//! Test engineer B: FE rows (feasibility gates: transaction size, compute units, stack depth,
//! binary size, exact account counts) on classic spl-token, p-token and Token-2022.
//!
//! All numbers are LiteSVM measurements printed as `MEASURE | label | value` (run with
//! `--nocapture`). Nothing here claims a number that was not produced by the run that prints it.

#![allow(deprecated)] // InstructionError::NotEnoughAccountKeys is what the runtime still reports

#[macro_use]
mod common;
mod support_b;

use common::*;
use solana_transaction::InstructionError;
use support_b::{first_invocation, measure};

const AMOUNT: u64 = 1_000_000;
const PACKET_LIMIT: usize = 1232;

fn moved_nothing(ctx: &Ctx, before: &Snapshot) {
    assert_nothing_moved(before, &ctx.snapshot());
}

// =====================================================================================
// FE-01: serialized legacy transaction sizes
// =====================================================================================

dual_token!(
    fe01_transfer_and_swap_transaction_sizes,
    with | b | b.with_swap(),
    |ctx| {
        let t = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
        t.assert_ok();
        let s = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
        s.assert_ok();
        let label = ctx.flavor.name();
        measure(&format!("tx size transfer ({label})"), t.tx_size);
        measure(&format!("tx size swap ({label})"), s.tx_size);
        assert!(
            t.tx_size <= 520,
            "transfer tx is {} bytes (gate 520)",
            t.tx_size
        );
        assert!(
            s.tx_size <= 900,
            "swap tx is {} bytes (gate 900)",
            s.tx_size
        );
        assert!(t.tx_size < PACKET_LIMIT && s.tx_size < PACKET_LIMIT);
    }
);

#[test]
fn fe01_transfer_and_swap_sizes_with_compute_budget_instructions() {
    // wallets and bots usually prepend SetComputeUnitLimit (+ price): still far below the packet limit
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    let limit = compute_unit_limit_ix(200_000);
    let t = ctx.send_agent(&[limit.clone(), ctx.transfer_ix(AMOUNT)]);
    t.assert_ok();
    let s = ctx.send_agent(&[limit, ctx.swap_ix_default(AMOUNT)]);
    s.assert_ok();
    measure("tx size transfer + SetComputeUnitLimit", t.tx_size);
    measure("tx size swap + SetComputeUnitLimit", s.tx_size);
    assert!(t.tx_size <= 600 && s.tx_size <= 1000);
}

/// A second, fully separate owner/agent with two token accounts of `ctx.mint`, ready to onboard.
struct Newcomer {
    owner: Keypair,
    agent: Keypair,
    source: Pubkey,
    in_account: Pubkey,
    out_account: Pubkey,
    mandate: Pubkey,
    policy: Pubkey,
    authority: Pubkey,
}

fn newcomer(ctx: &mut Ctx) -> Newcomer {
    let (owner, agent) = (Keypair::new(), Keypair::new());
    ctx.svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());
    let (policy, _) = policy_pda(&mandate);
    let (authority, _) = authority_pda(&mandate);
    let out_mint = ctx.swap_fixture().out_mint;
    let tp = ctx.token_program;
    let mk = |ctx: &mut Ctx, mint: Pubkey, amount: u64, label: &str| {
        let k = unique();
        ctx.place_token(k, TokenAcct::new(tp, mint, owner.pubkey(), amount), label);
        k
    };
    let mint = ctx.mint;
    let source = mk(ctx, mint, 100_000_000, "n_source");
    let in_account = mk(ctx, mint, 100_000_000, "n_in");
    let out_account = mk(ctx, out_mint, 0, "n_out");
    Newcomer {
        owner,
        agent,
        source,
        in_account,
        out_account,
        mandate,
        policy,
        authority,
    }
}

/// The two onboarding transactions of RELAY-SPEC 12.1 for `n`: tx 1 (fee, mandate, permissions,
/// Approve) and tx 2 (`init_policy`). Returns (tx1 size, tx2 size).
fn onboard(ctx: &mut Ctx, n: &Newcomer, with_gated: bool, two_approves: bool) -> (usize, usize) {
    let (o, a) = (n.owner.pubkey(), n.agent.pubkey());
    let tp = ctx.token_program;
    let mut ixs = vec![
        system_transfer_ix(&o, &a, 50_000_000),
        aa::create_mandate_ix(&o, &a, DEFAULT_EXPIRY),
        aa::add_permission_ix(&o, &a, &tp, 20_000_000, 5_000_000, &[TRANSFER_CHECKED_DISC]),
        aa::add_permission_ix(&o, &a, &MOCK_AMM_ID, 10_000_000, 5_000_000, &[SWAP_DISC]),
    ];
    if with_gated {
        ixs.push(aa::add_permission_ix(
            &o,
            &a,
            &GATED_EXAMPLE_ID,
            100,
            10,
            &[GATED_ACTION_DISC],
        ));
    }
    ixs.push(token::spl_approve(
        &tp,
        &n.source,
        &n.authority,
        &o,
        50_000_000,
    ));
    if two_approves {
        ixs.push(token::spl_approve(
            &tp,
            &n.in_account,
            &n.authority,
            &o,
            50_000_000,
        ));
    }
    let tx1 = send_keys(&mut ctx.svm, &[&n.owner], &ixs);
    tx1.assert_ok();

    let mut pins = ctx.swap_fixture().pins();
    pins.in_account = if two_approves { n.in_account } else { n.source };
    pins.out_account = n.out_account;
    let cfg = PolicyCfg::transfer_only(tp, ctx.mint, n.source, &ctx.recipients).with_swap(&pins);
    let init = InitPolicyIx::new(o, n.mandate, n.policy).ix(&cfg.init_data(FLAG_STRICT_TOP_LEVEL));
    let tx2 = send_keys(&mut ctx.svm, &[&n.owner], &[init]);
    tx2.assert_ok();
    (tx1.tx_size, tx2.tx_size)
}

dual_token!(
    fe01_onboarding_and_init_policy_sizes,
    with | b | b.with_swap(),
    |ctx| {
        let n = newcomer(ctx);
        let (tx1, tx2) = onboard(ctx, &n, false, true);
        let label = ctx.flavor.name();
        measure(
            &format!("tx size onboarding tx1: fee+mandate+2 perms+2 Approve ({label})"),
            tx1,
        );
        measure(&format!("tx size init_policy ({label})"), tx2);
        assert!(tx1 <= 800, "onboarding tx 1 is {tx1} bytes (gate 800)");
        assert!(
            tx2 <= PACKET_LIMIT,
            "init_policy is {tx2} bytes (gate 1232)"
        );

        // the demo script's S1 (three permissions, one Approve because in_account == source)
        let n2 = newcomer(ctx);
        let (tx1b, _) = onboard(ctx, &n2, true, false);
        measure(
            &format!("tx size onboarding tx1: fee+mandate+3 perms+1 Approve ({label})"),
            tx1b,
        );
        assert!(
            tx1b <= 800,
            "demo S1 onboarding tx 1 is {tx1b} bytes (gate 800)"
        );
    }
);

dual_token!(
    fe01_unwind_transaction_sizes,
    with | b | b.with_swap(),
    |ctx| {
        // two Revokes (source + separate swap input account), mandate revoke, policy close
        let ixs = ctx.unwind_ixs();
        assert_eq!(ixs.len(), 4);
        let owner = ctx.owner.pubkey();
        let mandate_rent = ctx.svm.get_account(&ctx.mandate).unwrap().lamports;
        let policy_rent = ctx.svm.get_account(&ctx.policy).unwrap().lamports;
        let before = ctx.svm.get_balance(&owner).unwrap();
        let r = ctx.send_owner(&ixs);
        r.assert_ok();
        let after = ctx.svm.get_balance(&owner).unwrap();
        let label = ctx.flavor.name();
        measure(&format!("tx size unwind, 2 Revokes ({label})"), r.tx_size);
        measure(&format!("CU unwind, 2 Revokes ({label})"), r.cu());
        assert!(r.tx_size <= 450, "unwind is {} bytes (gate 450)", r.tx_size);
        assert_eq!(
            after + 5_000,
            before + mandate_rent + policy_rent,
            "both rents returned exactly"
        );
        // every agent action now fails closed
        ctx.send_agent(&[ctx.transfer_ix(AMOUNT)])
            .assert_relay_err(relay_err::INVALID_POLICY);
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
            .assert_relay_err(relay_err::INVALID_POLICY);
    }
);

dual_token!(fe01_unwind_with_a_single_revoke, |ctx| {
    let ixs = ctx.unwind_ixs();
    assert_eq!(ixs.len(), 3);
    let r = ctx.send_owner(&ixs);
    r.assert_ok();
    measure(
        &format!("tx size unwind, 1 Revoke ({})", ctx.flavor.name()),
        r.tx_size,
    );
    assert!(r.tx_size <= 450);
});

// =====================================================================================
// FE-02: compute-unit gates (transfer) and measurements (everything else)
// =====================================================================================

triple_token!(
    fe02_transfer_cu_gates_and_measurements,
    with | b | b.with_swap(),
    |ctx| {
        let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
        r.assert_ok();
        let relay = first_invocation(r.logs(), &RELAY_ID).expect("relay invocation");
        let label = ctx.flavor.name();
        measure(&format!("transfer total tx CU ({label})"), r.cu());
        measure(
            &format!("transfer relay.own excl. verify+Token ({label})"),
            relay.own(),
        );
        let gate = match ctx.flavor {
            Flavor::Classic => Some(15_000),
            Flavor::PToken => Some(8_000),
            Flavor::Token2022 => None, // the spec gives no gate; measured only
        };
        if let Some(g) = gate {
            assert!(
                r.cu() <= g,
                "transfer {} CU exceeds the {g} CU gate on {label}",
                r.cu()
            );
        }
        // a second transfer (warm state: no first-touch effects) for the record
        let r2 = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
        r2.assert_ok();
        measure(
            &format!("transfer total tx CU, second call ({label})"),
            r2.cu(),
        );
        // swap, same fixture
        let s = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
        s.assert_ok();
        measure(&format!("swap total tx CU, mock AMM ({label})"), s.cu());
        // both together in one transaction
        let both = ctx.send_agent(&[ctx.transfer_ix(AMOUNT), ctx.swap_ix_default(AMOUNT)]);
        both.assert_ok();
        measure(
            &format!("transfer + swap in one tx, CU ({label})"),
            both.cu(),
        );
    }
);

dual_token!(
    fe02_policy_lifecycle_cu,
    with | b | b.with_swap().no_policy(),
    |ctx| {
        let cfg = ctx.cfg.clone();
        let label = ctx.flavor.name();
        let init = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
        init.assert_ok();
        measure(
            &format!("init_policy CU, swap enabled ({label})"),
            init.cu(),
        );
        let pause = ctx.send_owner(&[ctx.set_paused_ix(1)]);
        pause.assert_ok();
        measure(&format!("set_paused CU ({label})"), pause.cu());
        ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
        let close = ctx.send_owner(&[ctx.close_policy_ix()]);
        close.assert_ok();
        measure(&format!("close_policy CU ({label})"), close.cu());
    }
);

#[test]
fn fe02_strict_top_level_flag_costs_few_cu() {
    let (Some(mut plain), Some(mut strict)) = (
        Ctx::builder(Flavor::PToken).try_build(),
        Ctx::builder(Flavor::PToken).strict_top_level().try_build(),
    ) else {
        return;
    };
    let a = plain.send_agent(&[plain.transfer_ix(AMOUNT)]);
    let b = strict.send_agent(&[strict.transfer_ix(AMOUNT)]);
    a.assert_ok();
    b.assert_ok();
    measure(
        "STRICT_TOP_LEVEL extra CU on a transfer (p-token)",
        b.cu() as i64 - a.cu() as i64,
    );
    assert!(b.cu() >= a.cu() && b.cu() - a.cu() < 1_000);
}

// =====================================================================================
// FE-03: stack depth through the mock-amm `proxy`
// =====================================================================================

/// A wrapper program that is NOT the pinned AMM: a second copy of `evil_token.so` at a fresh id,
/// used only for its `proxy` instruction (see the evil-token crate docs). The mock AMM's own
/// `proxy` cannot wrap `swap`: the relay would call the mock AMM again (A -> B -> A).
struct Wrapper(Pubkey);

impl Wrapper {
    fn install(ctx: &mut Ctx) -> Option<Self> {
        let path = svm::require_so(svm::ENV_EVIL_TOKEN_SO)?;
        let id = unique();
        ctx.svm
            .add_program_from_file(id, path)
            .expect("load wrapper");
        Some(Self(id))
    }

    fn wrap(&self, inner: &Instruction) -> Instruction {
        let mut data = PROXY_DISC.to_vec();
        data.extend_from_slice(&inner.data);
        let mut accounts = vec![AccountMeta::new_readonly(inner.program_id, false)];
        accounts.extend(inner.accounts.iter().cloned());
        Instruction::new_with_bytes(self.0, &data, accounts)
    }

    fn nest(&self, ix: &Instruction, depth: usize) -> Instruction {
        let mut cur = ix.clone();
        for _ in 0..depth {
            cur = self.wrap(&cur);
        }
        cur
    }
}

dual_token!(
    fe03_transfer_and_swap_through_one_wrapper_work_and_stay_within_depth,
    with | b | b.with_swap(),
    |ctx| {
        let Some(w) = Wrapper::install(ctx) else {
            return;
        };
        let t = ctx.send_agent(&[w.wrap(&ctx.transfer_ix(AMOUNT))]);
        t.assert_ok();
        // wrapper(1) -> relay(2) -> verify(3) | Token(3)
        assert_eq!(t.max_stack_height(), 3);
        let s = ctx.send_agent(&[w.wrap(&ctx.swap_ix_default(AMOUNT))]);
        s.assert_ok();
        // wrapper(1) -> relay(2) -> verify(3) | AMM(3) -> Token(4)
        assert_eq!(s.max_stack_height(), 4);
        measure(
            &format!(
                "max stack height, transfer via 1 wrapper ({})",
                ctx.flavor.name()
            ),
            t.max_stack_height(),
        );
        measure(
            &format!(
                "max stack height, swap via 1 wrapper ({})",
                ctx.flavor.name()
            ),
            s.max_stack_height(),
        );
        assert!(
            t.max_stack_height() <= 4 && s.max_stack_height() <= 4,
            "FE-03 gate: max stack height <= 4"
        );
        // direct, for the record: swap relay(1) -> AMM(2) -> Token(3)
        let d = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
        d.assert_ok();
        assert_eq!(d.max_stack_height(), 3);
    }
);

dual_token!(
    fe03_transfer_through_the_mock_amm_proxy_works_swap_cannot,
    with | b | b.with_swap(),
    |ctx| {
        // The mock AMM `proxy` (RELAY-SPEC 14.1) wraps `transfer` fine (TR-34/TR-35 use it) ...
        let t = ctx.send_agent(&[amm::proxy_ix(&ctx.transfer_ix(AMOUNT))]);
        t.assert_ok();
        assert_eq!(t.max_stack_height(), 3);
        // ... but it cannot wrap `swap`: the proxy IS the pinned AMM, so the relay's swap CPI would
        // re-enter the mock AMM (mock -> relay -> mock). The runtime refuses; nothing moves. This is a
        // limitation of the test infrastructure, not of the relay (a third-party wrapper works above).
        let before = ctx.snapshot();
        let s = ctx.send_agent(&[amm::proxy_ix(&ctx.swap_ix_default(AMOUNT))]);
        s.assert_instruction_error(InstructionError::ReentrancyNotAllowed);
        moved_nothing(ctx, &before);
    }
);

#[test]
fn fe03_how_deep_can_the_relay_be_wrapped() {
    // Solana allows a maximum instruction stack height of 5 (top level = 1) while SIMD-0268 is not
    // active (RELAY-SPEC section 11). Wrap the relay in more and more wrappers and record where the
    // runtime stops it. The relay itself adds: transfer +1 (verify | Token), swap +2 (AMM -> Token).
    let Some(mut ctx) = Ctx::builder(Flavor::PToken).with_swap().try_build() else {
        return;
    };
    let Some(w) = Wrapper::install(&mut ctx) else {
        return;
    };
    let (mut transfer_max_ok, mut swap_max_ok) = (None, None);
    for depth in 0..=4 {
        let before = ctx.snapshot();
        let t = ctx.send_agent(&[w.nest(&ctx.transfer_ix(AMOUNT), depth)]);
        if !t.is_ok() {
            moved_nothing(&ctx, &before);
        }
        let before = ctx.snapshot();
        let s = ctx.send_agent(&[w.nest(&ctx.swap_ix_default(AMOUNT), depth)]);
        if !s.is_ok() {
            moved_nothing(&ctx, &before);
        }
        let err = |e: &Exec| format!("{:?}", e.result.as_ref().err().map(|f| &f.err));
        measure(
            &format!("{depth} wrappers in front of the relay"),
            format!(
                "transfer ok={} max_height={} err={} | swap ok={} max_height={} err={}",
                t.is_ok(),
                t.max_stack_height(),
                err(&t),
                s.is_ok(),
                s.max_stack_height(),
                err(&s)
            ),
        );
        if t.is_ok() {
            transfer_max_ok = Some(depth);
            assert_eq!(usize::from(t.max_stack_height()), depth + 2);
        } else {
            t.assert_instruction_error(InstructionError::CallDepth);
        }
        if s.is_ok() {
            swap_max_ok = Some(depth);
            assert_eq!(usize::from(s.max_stack_height()), depth + 3);
        } else {
            s.assert_instruction_error(InstructionError::CallDepth);
        }
    }
    measure(
        "deepest wrapper nesting where relay.transfer still works",
        format!("{transfer_max_ok:?}"),
    );
    measure(
        "deepest wrapper nesting where relay.swap still works",
        format!("{swap_max_ok:?}"),
    );
    // the limit is 5: transfer = wrappers + relay + Token, swap = wrappers + relay + AMM + Token
    assert_eq!(
        transfer_max_ok,
        Some(3),
        "transfer: 3 wrappers + relay(4) + Token(5)"
    );
    assert_eq!(
        swap_max_ok,
        Some(2),
        "swap: 2 wrappers + relay(3) + AMM(4) + Token(5)"
    );
}

dual_token!(
    fe03_strict_top_level_refuses_both_actions_through_a_wrapper,
    with | b | b.with_swap().strict_top_level(),
    |ctx| {
        let Some(w) = Wrapper::install(ctx) else {
            return;
        };
        // direct calls work
        ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]).assert_ok();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]).assert_ok();
        // wrapped: 115, nothing moves
        let before = ctx.snapshot();
        ctx.send_agent(&[w.wrap(&ctx.transfer_ix(AMOUNT))])
            .assert_relay_err(relay_err::NOT_TOP_LEVEL);
        ctx.send_agent(&[w.wrap(&ctx.swap_ix_default(AMOUNT))])
            .assert_relay_err(relay_err::NOT_TOP_LEVEL);
        moved_nothing(ctx, &before);
    }
);

// =====================================================================================
// FE-09: exact account counts (program side; the IDL side is in conformance.rs)
// =====================================================================================

dual_token!(
    fe09_exact_account_counts_for_every_instruction,
    with | b | b.with_swap(),
    |ctx| {
        let extra = unique();
        let before = ctx.snapshot();
        // transfer: 10
        let t = ctx.transfer_ix(10);
        ctx.send_agent(&[t.clone().truncate_accounts(9)])
            .assert_not_enough_accounts();
        ctx.send_agent(&[t.with_extra_account(extra)])
            .assert_not_enough_accounts();
        // swap: 19
        let s = ctx.swap_ix_default(10);
        ctx.send_agent(&[s.clone().truncate_accounts(18)])
            .assert_not_enough_accounts();
        ctx.send_agent(&[s.with_extra_account(extra)])
            .assert_not_enough_accounts();
        moved_nothing(ctx, &before);

        // init_policy: 4 (needs a fresh Ctx without a policy), set_paused: 2, close_policy: 2
        let p = ctx.set_paused_ix(1);
        ctx.send_owner(&[p.clone().truncate_accounts(1)])
            .assert_not_enough_accounts();
        ctx.send_owner(&[p.with_extra_account(extra)])
            .assert_not_enough_accounts();
        let c = ctx.close_policy_ix();
        ctx.send_owner(&[c.clone().truncate_accounts(1)])
            .assert_not_enough_accounts();
        ctx.send_owner(&[c.with_extra_account(extra)])
            .assert_not_enough_accounts();
        moved_nothing(ctx, &before);
    }
);

#[test]
fn fe09_init_policy_requires_exactly_four_accounts() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).no_policy().try_build() else {
        return;
    };
    let cfg = ctx.cfg.clone();
    let ix = ctx.init_policy_ix(&cfg, 0);
    ctx.send_owner(&[ix.clone().truncate_accounts(3)])
        .assert_not_enough_accounts();
    ctx.send_owner(&[ix.clone().with_extra_account(unique())])
        .assert_not_enough_accounts();
    assert!(
        ctx.svm.get_account(&ctx.policy).is_none(),
        "no policy created by a malformed call"
    );
    ctx.send_owner(&[ix]).assert_ok();
}

// =====================================================================================
// FE-05: binary size and no std / formatting machinery
// =====================================================================================

#[test]
fn fe05_relay_binary_is_small_and_has_no_std_formatting_or_panic_machinery() {
    for env in [svm::ENV_RELAY_SO, svm::ENV_RELAY_TESTAMM_SO] {
        let Ok(path) = svm::so_path(env) else {
            // the test-amm build is optional when AGENT_AUTH_RELAY_SO is itself a test-amm build
            if env == svm::ENV_RELAY_TESTAMM_SO {
                continue;
            }
            svm::require_so(env);
            return;
        };
        let bytes = std::fs::read(&path).expect("read .so");
        measure(&format!("size of {env}"), bytes.len());
        assert!(
            bytes.len() <= 64 * 1024,
            "{env}: {} bytes exceeds 64 KiB",
            bytes.len()
        );
        let hay = String::from_utf8_lossy(&bytes);
        for needle in [
            "std::",
            "core::fmt",
            "core::panicking",
            "alloc::fmt",
            "alloc::string",
            "panicked at",
            "called `Option::unwrap()",
            "called `Result::unwrap()",
            "/rustc/",
        ] {
            assert!(!hay.contains(needle), "{env}: binary contains {needle:?}");
        }
    }
}

// =====================================================================================
// stack-height facts used by the docs
// =====================================================================================

#[test]
fn fe03_direct_call_heights_and_cpi_shapes() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    let t = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
    t.assert_ok();
    assert_eq!(t.max_stack_height(), 2, "relay(1) -> verify(2) | Token(2)");
    let s = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    s.assert_ok();
    assert_eq!(
        s.max_stack_height(),
        3,
        "relay(1) -> verify(2) | AMM(2) -> Token(3)"
    );
    measure("direct transfer max stack height", t.max_stack_height());
    measure("direct swap max stack height", s.max_stack_height());
    // wrong-depth sanity: a bare InstructionError is never produced by a normal call
    assert!(!matches!(
        t.result.as_ref().err().map(|f| f.err.clone()),
        Some(solana_transaction::TransactionError::InstructionError(
            _,
            InstructionError::CallDepth
        ))
    ));
}
