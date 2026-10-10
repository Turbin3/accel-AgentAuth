//! Test engineer B: SW rows (swap against the mock AMM) and the swap-dependent end-to-end demo
//! replay (E2E-01 beats 1-3, 5-8; beat 4 needs `gated_example.so`, which is not built yet).
//!
//! Every Token-touching test runs against classic spl-token and p-token (`dual_token!`).
//! Expected failures assert the exact error code AND the program that raised it, plus
//! "nothing moved" (RELAY test matrix harness rules 2 and 3).
//!
//! Measurements are printed as `MEASURE | label | value`; run with `--nocapture` to see them.

#[macro_use]
mod common;
mod support_b;

use agent_auth_relay::math as relay_math;
use common::policy::off;
use common::*;
use solana_transaction::{InstructionError, TransactionError};
use support_b::{first_invocation, invocations, measure};

const AMOUNT: u64 = 1_000_000;

fn moved_nothing(ctx: &Ctx, before: &Snapshot) {
    assert_nothing_moved(before, &ctx.snapshot());
}

// =====================================================================================
// SW-01 / SW-02: happy path and verify booking
// =====================================================================================

dual_token!(
    sw01_happy_path_output_lands_in_owner_account,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        let before = ctx.snapshot();
        let want_out = ctx.expected_amount_out(AMOUNT);
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, ctx.deadline(100))]);
        r.assert_ok();

        // exact deltas on every account the swap touches
        assert_eq!(
            ctx.balance(&s.in_account),
            before.token(&s.in_account).amount - AMOUNT
        );
        assert_eq!(ctx.balance(&s.out_account), want_out);
        assert_eq!(
            ctx.balance(&s.input_vault),
            before.token(&s.input_vault).amount + AMOUNT
        );
        assert_eq!(
            ctx.balance(&s.output_vault),
            before.token(&s.output_vault).amount - want_out
        );
        assert!(want_out >= required_min_out(AMOUNT, s.floor_out, s.floor_in).unwrap());
        // the delegation fell by exactly the input
        assert_eq!(
            ctx.token(&s.in_account).delegated_amount,
            before.token(&s.in_account).delegated_amount - AMOUNT
        );
        // the output account is the owner's own; nothing reached the attacker or the agent
        assert_eq!(ctx.token(&s.out_account).owner, ctx.owner.pubkey());
        assert_eq!(ctx.balance(&ctx.attacker_token), 0);
        assert_eq!(ctx.balance(&ctx.agent_token), 0);
        // the transfer-side source is untouched
        assert_eq!(ctx.balance(&ctx.source), before.token(&ctx.source).amount);
        assert_eq!(
            ctx.token(&ctx.source).delegated_amount,
            before.token(&ctx.source).delegated_amount
        );
        // event 2 carries the deltas
        assert_eq!(
            r.events(),
            vec![RelayEvent::SwapExecuted {
                mandate: ctx.mandate,
                pool_state: s.pool_state,
                amount_in_requested: AMOUNT,
                in_delta: AMOUNT,
                out_delta: want_out,
            }]
        );
        // the relay's CPIs: verify, then exactly one AMM swap
        let cpis = r.relay_cpis();
        assert_eq!(cpis.len(), 2, "{cpis:?}");
        assert_eq!(cpis[0].program, AGENT_AUTH_ID);
        assert_eq!(cpis[1].program, MOCK_AMM_ID);
        assert_eq!(cpis[1].data.len(), 24);
    }
);

dual_token!(
    sw02_verify_books_amount_in_on_the_amm_slot_only,
    with | b | b.with_swap(),
    |ctx| {
        let token_before = ctx.token_perm();
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 0);
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]).assert_ok();
        let amm = ctx.perm(&MOCK_AMM_ID);
        assert_eq!(amm.spend_total, AMOUNT);
        assert_eq!(amm.call_count, 1);
        assert_eq!(
            ctx.token_perm(),
            token_before,
            "Token slot must not move on a swap"
        );
        ctx.send_agent(&[ctx.swap_ix_default(2 * AMOUNT)])
            .assert_ok();
        let amm = ctx.perm(&MOCK_AMM_ID);
        assert_eq!(amm.spend_total, 3 * AMOUNT);
        assert_eq!(amm.call_count, 2);
    }
);

// =====================================================================================
// SW-03 / SW-04 / SW-05 / SW-06: pins
// =====================================================================================

dual_token!(
    sw03_each_pinned_account_replaced_one_at_a_time_is_102,
    with | b | b.with_swap(),
    |ctx| {
        for (name, idx) in SWAP_PIN_TABLE {
            let before = ctx.snapshot();
            let ix = ctx.swap_ix_default(AMOUNT).with_account(idx, unique());
            let r = ctx.send_agent(&[ix]);
            assert!(!r.is_ok(), "{name}: replaced pin must fail");
            r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
            moved_nothing(ctx, &before);
        }
    }
);

dual_token!(
    sw03_lookalike_substitutions_are_102,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        // a real, well-formed, owner-delegated account in place of `in_account`
        let other_in = ctx.new_token_account(ctx.owner.pubkey(), 1_000_000_000, "other_in");
        let alt_token_program = if ctx.token_program == TOKEN_ID {
            TOKEN22_ID
        } else {
            TOKEN_ID
        };
        let cases: Vec<(&str, usize, Pubkey)> = vec![
            (
                "in_account -> another owner account",
                swap_idx::IN_ACCOUNT,
                other_in,
            ),
            (
                "out_account -> attacker token account",
                swap_idx::OUT_ACCOUNT,
                ctx.attacker_token,
            ),
            (
                "out_account -> agent's own token account",
                swap_idx::OUT_ACCOUNT,
                ctx.agent_token,
            ),
            (
                "in_token_program -> the other token program",
                swap_idx::IN_TOKEN_PROGRAM,
                alt_token_program,
            ),
            (
                "out_token_program -> the other token program",
                swap_idx::OUT_TOKEN_PROGRAM,
                alt_token_program,
            ),
            (
                "input_vault -> output vault",
                swap_idx::INPUT_VAULT,
                s.output_vault,
            ),
            (
                "output_vault -> input vault",
                swap_idx::OUTPUT_VAULT,
                s.input_vault,
            ),
            ("in_mint -> out mint", swap_idx::IN_MINT, s.out_mint),
            (
                "amm_authority -> owner",
                swap_idx::AMM_AUTHORITY,
                ctx.owner.pubkey(),
            ),
        ];
        for (name, idx, key) in cases {
            let before = ctx.snapshot();
            let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT).with_account(idx, key)]);
            assert!(!r.is_ok(), "{name}");
            r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
            moved_nothing(ctx, &before);
        }
    }
);

dual_token!(
    sw04_amm_program_replaced_by_another_executable_is_102,
    with | b | b.with_swap(),
    |ctx| {
        let other = unique();
        ctx.install_always_ok(other);
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx
            .swap_ix_default(AMOUNT)
            .with_account(swap_idx::AMM_PROGRAM, other)]);
        r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw04_policy_seeded_with_a_non_allowlisted_amm_is_103,
    with | b | b.with_swap(),
    |ctx| {
        // Seed the policy with an executable that is NOT in the compiled allowlist, then pass it:
        // every pin matches, only the allowlist can refuse.
        let rogue = unique();
        ctx.install_always_ok(rogue);
        let policy = ctx.policy;
        ctx.edit_account(&policy, |a| {
            a.data[off::AMM_PROGRAM..off::AMM_PROGRAM + 32].copy_from_slice(rogue.as_ref());
        });
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx
            .swap_ix_default(AMOUNT)
            .with_account(swap_idx::AMM_PROGRAM, rogue)]);
        r.assert_relay_err(relay_err::WRONG_PROGRAM);
        moved_nothing(ctx, &before);
    }
);

#[test]
fn sw04_production_relay_build_rejects_the_mock_amm() {
    let Some(prod) = svm::require_so(svm::ENV_RELAY_SO) else {
        return;
    };
    // (a) init_policy with the mock AMM on the production build: 113 (PL-04).
    let Some(mut ctx) = Ctx::builder(Flavor::Classic)
        .swap(SwapOpts::default())
        .relay_build(RelayBuild::Default)
        .no_policy()
        .try_build()
    else {
        return;
    };
    let cfg = ctx.cfg.clone();
    let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
    r.assert_relay_err(relay_err::INVALID_CONFIG);
    assert!(
        ctx.svm.get_account(&ctx.policy).is_none(),
        "no policy may be created"
    );

    // (b) a policy created by the test-amm build, then the production binary swapped in: the
    // runtime allowlist refuses the (pinned, executable) mock AMM with 103.
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]).assert_ok();
    ctx.svm
        .add_program_from_file(RELAY_ID, prod)
        .expect("load production relay");
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    r.assert_relay_err(relay_err::WRONG_PROGRAM);
    moved_nothing(&ctx, &before);
}

dual_token!(
    sw05_out_account_must_be_the_pinned_owner_account,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        // (a) attacker's token account in the out_account slot
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx
            .swap_ix_default(AMOUNT)
            .with_account(swap_idx::OUT_ACCOUNT, ctx.attacker_token)]);
        r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        moved_nothing(ctx, &before);

        // (b) the pinned key, but its token-level owner field is no longer the policy owner (seeded)
        let attacker = ctx.attacker.pubkey();
        let out = s.out_account;
        ctx.edit_account(&out, |a| {
            a.data[token::OFF_OWNER..token::OFF_OWNER + 32].copy_from_slice(attacker.as_ref());
        });
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
        r.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw06_in_and_out_accounts_swapped_is_102,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        let before = ctx.snapshot();
        let ix = ctx
            .swap_ix_default(AMOUNT)
            .with_account(swap_idx::IN_ACCOUNT, s.out_account)
            .with_account(swap_idx::OUT_ACCOUNT, s.in_account);
        ctx.send_agent(&[ix])
            .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        moved_nothing(ctx, &before);
    }
);

// =====================================================================================
// SW-07: the owner's floor beats the agent's min_out
// =====================================================================================

dual_token!(
    sw07_min_out_zero_cannot_lower_the_floor,
    with | b
        | b.swap_with(|o| {
            // pool price 0.80 against a floor of 0.95
            o.reserve_in = 1_000_000_000;
            o.reserve_out = 800_000_000;
        }),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        let would_get = ctx.expected_amount_out(AMOUNT);
        let floor = required_min_out(AMOUNT, s.floor_out, s.floor_in).unwrap();
        assert!(
            would_get < floor,
            "fixture: pool must be below the floor ({would_get} < {floor})"
        );
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, ctx.deadline(100))]);
        // the relay passes eff_min = ceil(AMOUNT * 95 / 100) to the AMM, which refuses first
        r.assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
        // a lower-than-floor min_out is equally ignored
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 1, ctx.deadline(100))]);
        r.assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw07_agent_can_raise_the_floor_never_lower_it,
    with | b | b.with_swap(),
    |ctx| {
        let before = ctx.snapshot();
        let would_get = ctx.expected_amount_out(AMOUNT);
        // above what the pool pays: the AMM refuses
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, would_get + 1, ctx.deadline(100))]);
        r.assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
        // exactly what the pool pays: fine
        ctx.send_agent(&[ctx.swap_ix(AMOUNT, would_get, ctx.deadline(100))])
            .assert_ok();
    }
);

// =====================================================================================
// SW-08: deadline window
// =====================================================================================

dual_token!(
    sw08_deadline_window_and_boundaries,
    with | b | b.with_swap(),
    |ctx| {
        ctx.warp_to_slot(1_000);
        let max = u64::from(ctx.swap_fixture().max_deadline_slots);
        let before = ctx.snapshot();

        let slot = ctx.slot();
        assert_eq!(slot, 1_000);
        for (what, deadline) in [
            ("slot - 1 (past)", slot - 1),
            ("0", 0),
            ("slot + max + 1 (too far)", slot + max + 1),
            ("u64::MAX", u64::MAX),
        ] {
            let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, deadline)]);
            assert!(!r.is_ok(), "{what}");
            r.assert_relay_err(relay_err::DEADLINE_EXPIRED);
            moved_nothing(ctx, &before);
        }
        // boundaries: deadline == slot and deadline == slot + max both succeed. The harness must not
        // move the clock between building and landing the transaction.
        let slot = ctx.slot();
        ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, slot)]).assert_ok();
        assert_eq!(
            ctx.slot(),
            slot,
            "sending must not advance the slot (boundary test premise)"
        );
        ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, slot + max)])
            .assert_ok();
    }
);

// =====================================================================================
// SW-09 / SW-10 / SW-11: disabled swap, AgentAuth limits and permission shape
// =====================================================================================

dual_token!(
    sw09_swap_disabled_is_110,
    with | b
        | b.with_swap().cfg(|c| {
            // canonical transfer-only config over the same token pins: swap_enabled = 0, swap fields zero
            let recipients = c.active_recipients().to_vec();
            *c = PolicyCfg::transfer_only(
                c.token_program,
                c.budget_mint,
                c.source_account,
                &recipients,
            );
        }),
    |ctx| {
        assert_eq!(ctx.policy_view().cfg.swap_enabled, 0);
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
            .assert_relay_err(relay_err::SWAP_DISABLED);
        moved_nothing(ctx, &before);
        // transfers keep working on the same policy
        ctx.send_agent(&[ctx.transfer_ix(10)]).assert_ok();
    }
);

dual_token!(
    sw10_amm_slot_limits,
    with | b
        | b.swap_with(|o| {
            o.amm_per_tx_limit = 1_000;
            o.amm_spend_limit = 1_500;
        }),
    |ctx| {
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(1_001)])
            .assert_aa_err(aa_err::PER_TX_EXCEEDED);
        moved_nothing(ctx, &before);
        ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(600)])
            .assert_aa_err(aa_err::SPEND_LIMIT_EXCEEDED);
        moved_nothing(ctx, &before);
        ctx.send_agent(&[ctx.swap_ix_default(500)]).assert_ok();
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 1_500);
        ctx.send_agent(&[ctx.swap_ix_default(1)])
            .assert_aa_err(aa_err::SPEND_LIMIT_EXCEEDED);
    }
);

dual_token!(
    sw11_mandate_without_amm_slot_is_aa6,
    with | b | b.swap_with(|o| o.add_permission = false),
    |ctx| {
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
            .assert_aa_err(aa_err::PROGRAM_NOT_ALLOWED);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw11_amm_slot_without_swap_disc_is_aa7,
    with | b | b.swap_with(|o| o.add_permission = false),
    |ctx| {
        let add = ctx.add_permission_ix(
            &MOCK_AMM_ID,
            100_000_000,
            10_000_000,
            &[[9, 9, 9, 9, 9, 9, 9, 9]],
        );
        ctx.send_owner(&[add]).assert_ok();
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
            .assert_aa_err(aa_err::DISCRIMINATOR_NOT_ALLOWED);
        moved_nothing(ctx, &before);
    }
);

// =====================================================================================
// SW-12 / SW-13: floor math
// =====================================================================================

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Values biased towards boundaries and towards all magnitudes.
    fn value(&mut self) -> u64 {
        match self.next() % 8 {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            3 => u64::MAX - (self.next() % 4),
            4 => self.next() >> (self.next() % 64),
            5 => 1u64 << (self.next() % 64),
            _ => self.next(),
        }
    }
}

/// Independent reference: u128 arithmetic with `div_ceil`.
fn reference_required(amount_in: u64, floor_out: u64, floor_in: u64) -> Option<u64> {
    if floor_in == 0 {
        return None;
    }
    let num = u128::from(amount_in) * u128::from(floor_out);
    u64::try_from(num.div_ceil(u128::from(floor_in))).ok()
}

#[test]
fn sw12_floor_math_equals_u128_reference_on_boundaries_and_random_inputs() {
    let boundaries = [
        0u64,
        1,
        2,
        3,
        99,
        100,
        101,
        u64::MAX - 1,
        u64::MAX,
        1 << 32,
        (1 << 32) - 1,
        1 << 63,
    ];
    let mut cases: Vec<(u64, u64, u64, u64)> = Vec::new();
    for &a in &boundaries {
        for &fo in &boundaries {
            for &fi in &boundaries {
                for &m in &[0u64, 1, u64::MAX] {
                    cases.push((a, m, fo, fi));
                }
            }
        }
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..200_000 {
        cases.push((rng.value(), rng.value(), rng.value(), rng.value()));
    }
    let (mut overflow, mut ok) = (0u32, 0u32);
    for (a, m, fo, fi) in cases {
        let want_req = reference_required(a, fo, fi);
        let got_req = relay_math::required_min_out(a, fo, fi);
        match want_req {
            Some(w) => {
                assert_eq!(got_req, Ok(w), "required_min_out({a}, {fo}, {fi})");
                assert_eq!(
                    relay_math::effective_min_out(a, m, fo, fi),
                    Ok(w.max(m)),
                    "effective({a},{m},{fo},{fi})"
                );
                // the harness reference (used by the LiteSVM tests) must agree as well
                if fi != 0 {
                    assert_eq!(required_min_out(a, fo, fi), Some(w));
                }
                ok += 1;
            }
            None => {
                assert_eq!(
                    got_req,
                    Err(agent_auth_relay::RelayError::ArithmeticOverflow),
                    "required_min_out({a}, {fo}, {fi}) must be ArithmeticOverflow"
                );
                assert_eq!(
                    relay_math::effective_min_out(a, m, fo, fi),
                    Err(agent_auth_relay::RelayError::ArithmeticOverflow)
                );
                overflow += 1;
            }
        }
    }
    measure("sw12 cases ok / overflow", format!("{ok} / {overflow}"));
    assert!(
        ok > 1_000 && overflow > 1_000,
        "the case mix must exercise both outcomes"
    );
    // never rounds below the exact quotient (floor is a minimum): ceil(x) * fi >= num
    let (a, fo, fi) = (7u64, 13u64, 5u64);
    assert_eq!(relay_math::required_min_out(a, fo, fi), Ok(19)); // 91 / 5 = 18.2 -> 19
}

#[test]
fn sw12_floor_overflow_is_114_on_chain_and_nothing_moves() {
    for flavor in Flavor::DUAL {
        let Some(mut ctx) = Ctx::builder(flavor)
            .swap_with(|o| {
                o.floor_out = u64::MAX;
                o.floor_in = 1;
            })
            .try_build()
        else {
            return;
        };
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.swap_ix_default(2)]);
        r.assert_relay_err(relay_err::ARITHMETIC_OVERFLOW);
        moved_nothing(&ctx, &before);
    }
}

/// Reserves so that `floor(amount_in * out / (in + amount_in)) == target` and one unit less in
/// the output reserve gives `target - 1`.
fn tuned_reserves(amount_in: u64, reserve_in: u64, target: u64) -> u64 {
    let den = u128::from(reserve_in) + u128::from(amount_in);
    let ro = (u128::from(target) * den).div_ceil(u128::from(amount_in));
    u64::try_from(ro).unwrap()
}

fn assert_tuned(amount_in: u64, reserve_in: u64, target: u64) -> u64 {
    let ro = tuned_reserves(amount_in, reserve_in, target);
    assert_eq!(amm::amount_out(reserve_in, ro, amount_in), Some(target));
    assert_eq!(
        amm::amount_out(reserve_in, ro - 1, amount_in),
        Some(target - 1)
    );
    ro
}

dual_token!(
    sw13_pool_exactly_at_the_floor_passes_one_below_fails,
    with | b
        | b.swap_with(|o| {
            o.reserve_in = 1_000_000_000;
            o.reserve_out = assert_tuned(1_000_000, 1_000_000_000, 950_000);
        }),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        assert_eq!(
            required_min_out(1_000_000, s.floor_out, s.floor_in),
            Some(950_000)
        );
        assert_eq!(ctx.expected_amount_out(1_000_000), 950_000);
        // one unit below the floor: pull a unit out of the output reserve
        let vault = s.output_vault;
        let reserve = ctx.balance(&vault);
        ctx.set_token_amount(&vault, reserve - 1);
        assert_eq!(ctx.expected_amount_out(1_000_000), 949_999);
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(1_000_000)])
            .assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
        // restore: exactly the floor now passes
        ctx.set_token_amount(&vault, reserve);
        ctx.send_agent(&[ctx.swap_ix_default(1_000_000)])
            .assert_ok();
        assert_eq!(ctx.balance(&s.out_account), 950_000);
    }
);

dual_token!(
    sw12_floor_with_a_product_above_u64_uses_the_wide_path_on_chain,
    with | b
        | b.swap_with(|o| {
            // 5e9 * 3e12 = 1.5e22 > 2^64: exercises the shift-subtract division inside the program
            o.floor_out = 3_000_000_000_000;
            o.floor_in = 1_000_000_000_000;
            o.reserve_in = 1_000_000_000_000;
            o.reserve_out = assert_tuned(5_000_000_000, 1_000_000_000_000, 15_000_000_000);
            o.in_balance = 100_000_000_000;
            o.in_delegated = 100_000_000_000;
            o.amm_per_tx_limit = 100_000_000_000;
            o.amm_spend_limit = 100_000_000_000;
        }),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        assert_eq!(
            required_min_out(5_000_000_000, s.floor_out, s.floor_in),
            Some(15_000_000_000)
        );
        assert!(u128::from(5_000_000_000u64) * u128::from(s.floor_out) > u128::from(u64::MAX));
        let vault = s.output_vault;
        let reserve = ctx.balance(&vault);
        ctx.set_token_amount(&vault, reserve - 1);
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(5_000_000_000)])
            .assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
        ctx.set_token_amount(&vault, reserve);
        ctx.send_agent(&[ctx.swap_ix_default(5_000_000_000)])
            .assert_ok();
        assert_eq!(ctx.balance(&s.out_account), 15_000_000_000);
    }
);

// =====================================================================================
// SW-14 / SW-17 / SW-18 and delegation edge cases
// =====================================================================================

dual_token!(
    sw14_in_account_equal_to_source_shares_the_delegation,
    with | b | b.delegated(10_000).swap_with(|o| o.in_is_source = true),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        assert_eq!(s.in_account, ctx.source);
        ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
        ctx.send_agent(&[ctx.swap_ix_default(2_000)]).assert_ok();
        // both actions drew on the same SPL delegation
        assert_eq!(ctx.token(&ctx.source).delegated_amount, 10_000 - 3_000);
        assert_eq!(ctx.balance(&ctx.source), ctx.initial_source_balance - 3_000);
        // ... but the mandate keeps two separate slots
        let (t, a) = (ctx.token_perm(), ctx.perm(&MOCK_AMM_ID));
        assert_eq!((t.spend_total, t.call_count), (1_000, 1));
        assert_eq!((a.spend_total, a.call_count), (2_000, 1));
    }
);

dual_token!(
    sw17_pull_less_succeeds_when_the_pool_still_clears_the_floor,
    with | b
        | b.swap_with(|o| {
            o.mode = amm_mode::PULL_LESS;
            // a generous pool: even half the input buys more than the floor on the FULL amount_in
            o.reserve_out = 2_100_000_000;
        }),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, ctx.deadline(100))]);
        r.assert_ok();
        let pulled = AMOUNT / 2;
        assert_eq!(
            ctx.balance(&s.in_account),
            before.token(&s.in_account).amount - pulled
        );
        assert_eq!(
            ctx.token(&s.in_account).delegated_amount,
            before.token(&s.in_account).delegated_amount - pulled
        );
        // the mandate over-counts conservatively: it booked the requested amount, not the pulled one
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, AMOUNT);
        match r.events().as_slice() {
            [RelayEvent::SwapExecuted {
                amount_in_requested,
                in_delta,
                out_delta,
                ..
            }] => {
                assert_eq!(*amount_in_requested, AMOUNT);
                assert_eq!(*in_delta, pulled);
                assert!(*out_delta >= required_min_out(AMOUNT, s.floor_out, s.floor_in).unwrap());
            }
            other => panic!("unexpected events {other:?}"),
        }
    }
);

dual_token!(
    sw17_pull_less_at_the_normal_price_is_refused_by_the_floor,
    with | b | b.swap_with(|o| o.mode = amm_mode::PULL_LESS),
    |ctx| {
        // The floor is priced on the requested amount_in, so a callee that pulls half and pays
        // proportionally (about 0.4995 per unit) cannot slip under it: the AMM-side check refuses.
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, ctx.deadline(100))])
            .assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw18_swap_and_transfer_in_one_transaction_share_the_delegation,
    with | b | b.delegated(5_000).swap_with(|o| o.in_is_source = true),
    |ctx| {
        // exhausts the delegation exactly: 3000 + 2000
        let ixs = [ctx.transfer_ix(3_000), ctx.swap_ix_default(2_000)];
        ctx.send_agent(&ixs).assert_ok();
        let src = ctx.token(&ctx.source);
        assert_eq!(src.delegated_amount, 0);
        assert_eq!(
            src.delegate, None,
            "the Token program clears the delegate at 0"
        );
        // the next action of either kind fails closed with 105
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(1)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        ctx.send_agent(&[ctx.swap_ix_default(1)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    sw18_second_action_exceeding_the_shared_delegation_reverts_both,
    with | b | b.delegated(5_000).swap_with(|o| o.in_is_source = true),
    |ctx| {
        let before = ctx.snapshot();
        // swap 3000 fits, transfer 3000 does not (2000 left): the WHOLE transaction reverts
        let ixs = [ctx.swap_ix_default(3_000), ctx.transfer_ix(3_000)];
        let r = ctx.send_agent(&ixs);
        r.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        match &r.result {
            Err(f) => assert!(
                matches!(
                    f.err,
                    TransactionError::InstructionError(1, InstructionError::Custom(105))
                ),
                "failing instruction must be index 1: {:?}",
                f.err
            ),
            Ok(_) => unreachable!(),
        }
        moved_nothing(ctx, &before);
    }
);

triple_token!(
    sw19_swap_that_exhausts_the_delegation_exactly_clears_the_delegate,
    with | b
        | b.swap_with(|o| {
            o.in_delegated = AMOUNT;
        }),
    |ctx| {
        // Classic Token and p-token clear only the COption tag and leave the key bytes; Token-2022
        // zeroes them. The relay's "delegate bytes unchanged unless delegated_amount == 0" rule must
        // accept all three.
        let s = ctx.swap_fixture().clone();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]).assert_ok();
        let v = ctx.token(&s.in_account);
        assert_eq!(v.delegated_amount, 0);
        assert_eq!(v.delegate, None);
        assert_eq!(v.owner, ctx.owner.pubkey());
    }
);

dual_token!(
    sw20_swap_input_state_guards_are_105,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        let before = ctx.snapshot();
        // more than the delegation
        ctx.send_agent(&[ctx.swap_ix_default(100_000_001)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(ctx, &before);
        // more than the balance but within the delegation
        ctx.set_token_amount(&s.in_account, 10);
        let low = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(11)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(ctx, &low);
        ctx.set_token_amount(&s.in_account, 1_000_000_000);
        // the delegate is not the authority PDA
        let in_acct = s.in_account;
        let someone = unique();
        ctx.edit_account(&in_acct, |a| {
            a.data[token::OFF_DELEGATE..token::OFF_DELEGATE + 32].copy_from_slice(someone.as_ref());
        });
        let wrong_delegate = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(ctx, &wrong_delegate);
    }
);

dual_token!(
    sw20_frozen_accounts_and_zero_amount,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        for key in [s.in_account, s.out_account] {
            let before = ctx.snapshot();
            ctx.edit_account(&key, |a| a.data[token::OFF_STATE] = token::STATE_FROZEN);
            ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
                .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
            ctx.edit_account(&key, |a| {
                a.data[token::OFF_STATE] = token::STATE_INITIALIZED
            });
            // restoring the state restores the snapshot (except nothing else changed)
            moved_nothing(ctx, &before);
        }
        ctx.send_agent(&[ctx.swap_ix(0, 0, ctx.deadline(10))])
            .assert_relay_err(relay_err::INVALID_INSTRUCTION_DATA);
        // wrong data lengths
        let data24 = ctx.swap_ix_default(AMOUNT).truncate_data(24);
        ctx.send_agent(&[data24])
            .assert_relay_err(relay_err::INVALID_INSTRUCTION_DATA);
        let data26 = ctx.swap_ix_default(AMOUNT).append_data(&[0]);
        ctx.send_agent(&[data26])
            .assert_relay_err(relay_err::INVALID_INSTRUCTION_DATA);
    }
);

// =====================================================================================
// SW-16: CU of the swap, relay overhead excluding the callee
// =====================================================================================

triple_token!(
    sw16_swap_cu_and_relay_overhead,
    with | b | b.with_swap(),
    |ctx| {
        let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
        r.assert_ok();
        let total = r.cu();
        let relay = first_invocation(r.logs(), &RELAY_ID).expect("relay invocation");
        let overhead = relay.own();
        let amm = invocations(r.logs())
            .into_iter()
            .find(|i| i.program == MOCK_AMM_ID)
            .expect("amm invocation");
        let verify = invocations(r.logs())
            .into_iter()
            .find(|i| i.program == AGENT_AUTH_ID)
            .expect("verify invocation");
        let label = ctx.flavor.name();
        measure(&format!("swap total tx CU ({label})"), total);
        measure(
            &format!("swap relay.own excl. verify+AMM ({label})"),
            overhead,
        );
        measure(
            &format!("swap relay.consumed incl. callees ({label})"),
            relay.consumed,
        );
        measure(
            &format!("swap mock AMM consumed incl. Token CPIs ({label})"),
            amm.consumed,
        );
        measure(&format!("swap verify consumed ({label})"), verify.consumed);
        assert!(
            overhead <= 30_000,
            "relay overhead {overhead} CU exceeds the 30,000 gate"
        );
        assert!(relay.consumed - overhead == amm.consumed + verify.consumed);
        assert_eq!(r.max_stack_height(), 3, "relay(1) -> AMM(2) -> Token(3)");
    }
);

// =====================================================================================
// E2E-01: the demo script replayed (beats 1-3 and 5-8; beat 4 needs gated_example.so)
// =====================================================================================

mod e2e {
    use super::*;

    const USDC: u64 = 1_000_000;

    fn demo_ctx() -> Option<Ctx> {
        Ctx::builder(Flavor::Classic)
            .source_balance(100 * USDC)
            .delegated(50 * USDC)
            .limits(20 * USDC, 5 * USDC)
            .recipients(1)
            .strict_top_level()
            .swap(SwapOpts {
                in_is_source: true,
                reserve_in: 1_000 * USDC,
                reserve_out: 1_000 * USDC,
                floor_out: 95,
                floor_in: 100,
                max_deadline_slots: 150,
                amm_spend_limit: 10 * USDC,
                amm_per_tx_limit: 5 * USDC,
                ..SwapOpts::default()
            })
            .try_build()
    }

    /// The ledger of DEMO-SCRIPT section 3: (O, OUT, ACME, D, T, M).
    #[track_caller]
    fn ledger(ctx: &Ctx, want: (u64, u64, u64, u64, Option<u64>, u64)) {
        let s = ctx.swap_fixture();
        let (o, out, acme, d, t, m) = want;
        assert_eq!(ctx.balance(&ctx.source), o, "OWNER_USDC");
        assert_eq!(ctx.balance(&s.out_account), out, "OWNER_OUT");
        assert_eq!(ctx.balance(&ctx.recipients[0]), acme, "ACME");
        assert_eq!(ctx.token(&ctx.source).delegated_amount, d, "D");
        let mv = ctx.mandate_view();
        assert_eq!(mv.perm(&TOKEN_ID).map(|p| p.spend_total), t, "T");
        assert_eq!(mv.perm(&MOCK_AMM_ID).map(|p| p.spend_total), Some(m), "M");
    }

    #[track_caller]
    fn attacker_has_nothing(ctx: &Ctx, mallory_out: &Pubkey) {
        assert_eq!(ctx.balance(&ctx.attacker_token), 0, "MALLORY_USDC");
        assert_eq!(ctx.balance(mallory_out), 0, "MALLORY_OUT");
    }

    #[track_caller]
    fn fails_at(r: &Exec, index: u8, program: &Pubkey, code: u32) {
        r.assert_err(program, code);
        match &r.result {
            Err(f) => assert_eq!(
                f.err,
                TransactionError::InstructionError(index, InstructionError::Custom(code)),
                "failing instruction index"
            ),
            Ok(_) => unreachable!(),
        }
    }

    #[test]
    fn e2e01_demo_script_beats_1_to_3_and_5_to_8() {
        let Some(mut ctx) = demo_ctx() else { return };
        let s = ctx.swap_fixture().clone();
        let mallory = ctx.attacker_token;
        let mallory_out = unique();
        let atk = ctx.attacker.pubkey();
        ctx.place_token(
            mallory_out,
            TokenAcct::new(TOKEN_ID, s.out_mint, atk, 0),
            "mallory_out",
        );
        let tp = ctx.token_program;
        ledger(&ctx, (100 * USDC, 0, 0, 50 * USDC, Some(0), 0));
        let rent_floor = ctx.svm.rent(0);
        assert!(rent_floor > 0);

        // ---- Beat 1: control, the hot-wallet agent loses everything in one transaction
        let hot = Keypair::new();
        ctx.svm.airdrop(&hot.pubkey(), 1_000_000_000).unwrap();
        let hot_usdc = ctx.new_token_account(hot.pubkey(), 50 * USDC, "hot_usdc");
        let mallory_b = ctx.new_token_account(unique(), 0, "mallory_usdc_b");
        let drain = token::spl_transfer_checked(
            &tp,
            &hot_usdc,
            &ctx.mint,
            &mallory_b,
            &hot.pubkey(),
            50 * USDC,
            ctx.decimals,
        );
        ctx.send_keys(&[&hot], &[drain]).assert_ok();
        assert_eq!(
            ctx.balance(&mallory_b),
            50 * USDC,
            "1.1: the control agent is drained"
        );
        assert_eq!(ctx.balance(&hot_usdc), 0);

        // ---- Beat 2: normal work
        let r = ctx.send_agent(&[ctx.transfer_ix(3 * USDC)]);
        r.assert_ok();
        assert_eq!(r.events().len(), 1);
        assert!(matches!(
            r.events()[0],
            RelayEvent::TransferExecuted {
                amount: 3_000_000,
                ..
            }
        ));
        let cpis: Vec<_> = r.relay_cpis().iter().map(|c| c.program).collect();
        assert_eq!(
            cpis,
            vec![AGENT_AUTH_ID, TOKEN_ID],
            "2.1 explorer shape: relay -> verify, Token"
        );
        ledger(&ctx, (97 * USDC, 0, 3 * USDC, 47 * USDC, Some(3 * USDC), 0));

        let r = ctx.send_agent(&[ctx.swap_ix(5 * USDC, 0, ctx.deadline(100))]);
        r.assert_ok();
        assert_eq!(ctx.balance(&s.out_account), 4_975_124, "2.2 AMM output");
        assert_eq!(
            required_min_out(5 * USDC, 95, 100),
            Some(4_750_000),
            "floor minimum"
        );
        assert_eq!(ctx.balance(&s.input_vault), 1_005_000_000);
        assert_eq!(ctx.balance(&s.output_vault), 995_024_876);
        ledger(
            &ctx,
            (
                92 * USDC,
                4_975_124,
                3 * USDC,
                42 * USDC,
                Some(3 * USDC),
                5 * USDC,
            ),
        );

        // ---- Beat 3: the prompt injection, every step fails, nothing moves
        let frozen = ctx.snapshot();
        let mut failed = 0;

        // 3.1 drain to the attacker
        ctx.send_agent(&[ctx.transfer_ix_to(&mallory, 40 * USDC)])
            .assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        failed += 1;
        // 3.2 far above the per-call cap
        ctx.send_agent(&[ctx.transfer_ix(40 * USDC)])
            .assert_aa_err(aa_err::PER_TX_EXCEEDED);
        failed += 1;
        // 3.3 more than the whole delegation
        ctx.send_agent(&[ctx.transfer_ix(90 * USDC)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        failed += 1;
        // 3.4 split across five instructions in one transaction: index 3 hits the lifetime cap
        let split: Vec<_> = (0..5).map(|_| ctx.transfer_ix(5 * USDC)).collect();
        let r = ctx.send_agent(&split);
        fails_at(&r, 3, &AGENT_AUTH_ID, aa_err::SPEND_LIMIT_EXCEEDED);
        failed += 1;
        // 3.5 raw TransferChecked signed by the agent
        let agent = ctx.agent.pubkey();
        let raw = ctx.raw_transfer_checked_ix(&agent, &mallory, 40 * USDC);
        ctx.send_agent(&[raw])
            .assert_token_err(&tp, token_err::OWNER_MISMATCH);
        failed += 1;
        // 3.6 raw Approve(delegate = MALLORY) signed by the agent
        let approve = token::spl_approve(&tp, &ctx.source, &mallory, &agent, 1_000 * USDC);
        ctx.send_agent(&[approve])
            .assert_token_err(&tp, token_err::OWNER_MISMATCH);
        failed += 1;
        // 3.7 raw SetAuthority(AccountOwner -> MALLORY) signed by the agent
        let setauth = token::spl_set_authority(
            &tp,
            &ctx.source,
            &agent,
            token::AUTH_ACCOUNT_OWNER,
            Some(&atk),
        );
        ctx.send_agent(&[setauth])
            .assert_token_err(&tp, token_err::OWNER_MISMATCH);
        failed += 1;
        // 3.8 "approve through the relay": relay tag 5 does not exist
        let tag5 = ctx.transfer_ix(1).with_data(&[5]);
        ctx.send_agent(&[tag5])
            .assert_relay_err(relay_err::INVALID_INSTRUCTION_DATA);
        failed += 1;
        // 3.9 swap output into the attacker's account
        let s9 = ctx
            .swap_ix(5 * USDC, 0, ctx.deadline(100))
            .with_account(swap_idx::OUT_ACCOUNT, mallory_out);
        ctx.send_agent(&[s9])
            .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        failed += 1;
        // 3.10 ask the mandate itself whether Approve is allowed
        let v = aa::verify_ix(
            &ctx.mandate,
            &ctx.owner.pubkey(),
            &agent,
            &TOKEN_ID,
            &[4, 0, 0, 0, 0, 0, 0, 0],
            0,
        );
        ctx.send_agent(&[v])
            .assert_aa_err(aa_err::DISCRIMINATOR_NOT_ALLOWED);
        failed += 1;
        assert_eq!(failed, 10, "failed-transaction count of Beat 3");

        // verify direct calls by the agent are the only thing allowed to touch counters; the verify
        // above had amount 0 and failed, so the frozen snapshot is still identical.
        assert_nothing_moved(&frozen, &ctx.snapshot());
        attacker_has_nothing(&ctx, &mallory_out);
        ledger(
            &ctx,
            (
                92 * USDC,
                4_975_124,
                3 * USDC,
                42 * USDC,
                Some(3 * USDC),
                5 * USDC,
            ),
        );

        // ---- Beat 5: per-instruction control by the owner
        ctx.send_owner(&[ctx.remove_permission_ix(&tp)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(USDC)])
            .assert_aa_err(aa_err::PROGRAM_NOT_ALLOWED);
        ctx.send_agent(&[ctx.swap_ix(5 * USDC, 0, ctx.deadline(100))])
            .assert_ok();
        assert_eq!(
            ctx.balance(&s.out_account),
            4_975_124 + 4_925_865,
            "5.3 second swap output"
        );
        ledger(
            &ctx,
            (87 * USDC, 9_900_989, 3 * USDC, 37 * USDC, None, 10 * USDC),
        );
        // 5.4 re-add with only the legacy unchecked Transfer
        ctx.send_owner(&[ctx.add_permission_ix(
            &tp,
            20 * USDC,
            5 * USDC,
            &[[3, 0, 0, 0, 0, 0, 0, 0]],
        )])
        .assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(USDC)])
            .assert_aa_err(aa_err::DISCRIMINATOR_NOT_ALLOWED);
        // 5.6 restore TransferChecked; counters start at 0
        ctx.send_owner(&[
            ctx.remove_permission_ix(&tp),
            ctx.add_permission_ix(&tp, 20 * USDC, 5 * USDC, &[TRANSFER_CHECKED_DISC]),
        ])
        .assert_ok();
        ledger(
            &ctx,
            (
                87 * USDC,
                9_900_989,
                3 * USDC,
                37 * USDC,
                Some(0),
                10 * USDC,
            ),
        );
        // 5.7 the AMM lifetime limit is used up
        ctx.send_agent(&[ctx.swap_ix(5 * USDC, 0, ctx.deadline(100))])
            .assert_aa_err(aa_err::SPEND_LIMIT_EXCEEDED);

        // ---- Beat 6: reversible kill switch
        ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(USDC)])
            .assert_relay_err(relay_err::PAUSED);
        ctx.send_agent(&[ctx.swap_ix(USDC, 0, ctx.deadline(100))])
            .assert_relay_err(relay_err::PAUSED);
        ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(USDC)]).assert_ok();
        ledger(
            &ctx,
            (
                86 * USDC,
                9_900_989,
                4 * USDC,
                36 * USDC,
                Some(USDC),
                10 * USDC,
            ),
        );

        // ---- Beat 7: price floor. DEMO-SCRIPT beat 7 follows beat 5 where the AMM lifetime limit
        // is already used up (verify would answer AgentAuth 9 before the AMM is reached), so the
        // owner first raises the AMM slot limit with update_permission.
        ctx.send_owner(&[ctx.update_permission_ix(&MOCK_AMM_ID, 100 * USDC, 5 * USDC)])
            .assert_ok();
        let searcher = Keypair::new();
        ctx.svm.airdrop(&searcher.pubkey(), 1_000_000_000).unwrap();
        let sk = searcher.pubkey();
        let s_in = ctx.new_token_account(sk, 600 * USDC, "searcher_in");
        let s_out = unique();
        ctx.place_token(
            s_out,
            TokenAcct::new(TOKEN_ID, s.out_mint, sk, 0),
            "searcher_out",
        );
        let push = amm::mock_swap_ix(
            &sk,
            &s.pool_state,
            &s.amm_config,
            &s_in,
            &s_out,
            &s.input_vault,
            &s.output_vault,
            &tp,
            &tp,
            &s.in_mint,
            &s.out_mint,
            &s.observation_state,
            600 * USDC,
            0,
        );
        ctx.send_keys(&[&searcher], &[push]).assert_ok();
        let would_get = ctx.expected_amount_out(5 * USDC);
        assert!(
            would_get < 4_750_000,
            "pool pushed below the floor: agent would get {would_get}"
        );
        measure(
            "beat 7: agent would receive (raw units) for 5 tUSDC after the push",
            would_get,
        );
        let before7 = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix(5 * USDC, 0, ctx.deadline(100))])
            .assert_err(&MOCK_AMM_ID, amm_err::EXCEEDED_SLIPPAGE);
        assert_nothing_moved(&before7, &ctx.snapshot());

        // ---- Beat 8: one-transaction unwind, then the failed follow-up
        let owner = ctx.owner.pubkey();
        let owner_before = ctx.svm.get_balance(&owner).unwrap();
        let mandate_rent = ctx.svm.get_account(&ctx.mandate).unwrap().lamports;
        let policy_rent = ctx.svm.get_account(&ctx.policy).unwrap().lamports;
        let usdc_before = ctx.balance(&ctx.source);
        let unwind = ctx.unwind_ixs();
        assert_eq!(
            unwind.len(),
            3,
            "in_account == source: one Revoke, revoke_mandate, close_policy"
        );
        let r = ctx.send_owner(&unwind);
        r.assert_ok();
        measure("beat 8 unwind tx size (bytes)", r.tx_size);
        assert!(r.tx_size <= 450, "unwind size {}", r.tx_size);
        let owner_after = ctx.svm.get_balance(&owner).unwrap();
        let fee = owner_before + mandate_rent + policy_rent - owner_after;
        assert_eq!(
            fee, 5_000,
            "only the 1-signature fee is paid; both rents come back exactly"
        );
        let src = ctx.token(&ctx.source);
        assert_eq!(src.delegate, None);
        assert_eq!(src.amount, usdc_before, "balance intact");
        assert!(
            ctx.svm.get_account(&ctx.mandate).is_none()
                || ctx.svm.get_account(&ctx.mandate).unwrap().lamports == 0
        );
        assert!(
            ctx.svm.get_account(&ctx.policy).is_none()
                || ctx.svm.get_account(&ctx.policy).unwrap().lamports == 0
        );
        ctx.send_agent(&[ctx.transfer_ix(USDC)])
            .assert_relay_err(relay_err::INVALID_POLICY);
        attacker_has_nothing(&ctx, &mallory_out);
        assert_eq!(
            ctx.balance(&mallory_b),
            50 * USDC,
            "only the control agent ever lost funds"
        );
    }
}

// =====================================================================================
// SW-15 (P2): the REAL Raydium CP-Swap binary and a REAL devnet pool, read-only fetched
// =====================================================================================

/// Ignored by default. Needs
///   * `AGENT_AUTH_RAYDIUM_CPMM_SO` = path of the devnet binary:
///     `solana program dump DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb cpmm_devnet.so -u devnet`
///   * `tests/raydium_fixture/devnet_pool.json` (written by `tests/raydium_fixture/fetch_fixture.py`,
///     also read-only).
///
/// Run: `AGENT_AUTH_RAYDIUM_CPMM_SO=... cargo test -p agent-auth-relay --test sw sw15 -- --ignored --nocapture`
///
/// It uses the PRODUCTION relay build (default features: the allowlist holds the real CPMM ids, not
/// the mock AMM), so it also proves the shipped allowlist accepts the real program.
mod sw15 {
    use super::*;
    use serde_json::Value;
    use solana_account::Account;

    const ENV_CPMM_SO: &str = "AGENT_AUTH_RAYDIUM_CPMM_SO";
    const FIXTURE: &str = include_str!("raydium_fixture/devnet_pool.json");

    fn key(s: &str) -> Pubkey {
        s.parse().expect("pubkey")
    }

    fn run(flavor: Flavor) {
        let so = std::env::var(ENV_CPMM_SO).unwrap_or_else(|_| {
            panic!("SW-15 needs {ENV_CPMM_SO} (see the doc comment of this module)")
        });
        let fx: Value = serde_json::from_str(FIXTURE).expect("fixture json");
        assert_eq!(fx["program"], CPMM_DEVNET.to_string());
        let acct = |name: &str| -> (Pubkey, Account) {
            let a = &fx["accounts"][name];
            let data = common::assert::base64_decode(a["data_base64"].as_str().expect("data"))
                .expect("base64");
            (
                key(a["key"].as_str().expect("key")),
                Account {
                    lamports: a["lamports"].as_u64().expect("lamports"),
                    data,
                    owner: key(a["owner"].as_str().expect("owner")),
                    executable: false,
                    rent_epoch: 0,
                },
            )
        };
        let (pool, vault0, vault1, mint0, mint1, config, obs) = (
            acct("pool"),
            acct("vault0"),
            acct("vault1"),
            acct("mint0"),
            acct("mint1"),
            acct("config"),
            acct("obs"),
        );
        let reserve0 = TokenView::parse(&vault0.1.data).amount;
        let amount_in = (reserve0 / 10_000).clamp(1_000, 1_000_000_000_000);

        let Some(mut ctx) = Ctx::builder(flavor)
            .swap_with(|o| {
                o.amm_program = CPMM_DEVNET;
                o.amm_spend_limit = 1_000_000_000_000_000_000;
                o.amm_per_tx_limit = 1_000_000_000_000_000_000;
            })
            .relay_build(RelayBuild::Default)
            .no_policy()
            .try_build()
        else {
            return;
        };
        ctx.svm
            .add_program_from_file(CPMM_DEVNET, so)
            .expect("load the dumped Raydium CPMM binary");
        for (k, a) in [&pool, &vault0, &vault1, &mint0, &mint1, &config, &obs] {
            ctx.svm.put(*k, a.clone());
            ctx.label(*k, "raydium");
        }
        // classic Token accounts of the pool's two mints, owned by our owner
        let tp = ctx.token_program;
        assert_eq!(
            mint0.1.owner, tp,
            "the fixture pool is a classic-Token pool"
        );
        let owner = ctx.owner.pubkey();
        let (in_account, out_account) = (unique(), unique());
        let funds = amount_in.saturating_mul(10);
        let authority = ctx.authority;
        ctx.place_token(
            in_account,
            TokenAcct::new(tp, mint0.0, owner, funds).delegate(authority, funds),
            "in_account",
        );
        ctx.place_token(
            out_account,
            TokenAcct::new(tp, mint1.0, owner, 0),
            "out_account",
        );
        let (amm_authority, _) =
            Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &CPMM_DEVNET);
        ctx.swap = Some(SwapFixture {
            in_account,
            out_account,
            in_mint: mint0.0,
            out_mint: mint1.0,
            amm_program: CPMM_DEVNET,
            amm_authority,
            amm_config: config.0,
            pool_state: pool.0,
            input_vault: vault0.0,
            output_vault: vault1.0,
            observation_state: obs.0,
            in_token_program: tp,
            out_token_program: tp,
            floor_out: 1,
            floor_in: 1 << 40,
            max_deadline_slots: 150,
            out_decimals: 9,
        });
        let pins = ctx.swap_fixture().pins();
        ctx.cfg = PolicyCfg::transfer_only(tp, mint0.0, ctx.source, &ctx.recipients.clone())
            .with_swap(&pins);
        let init = ctx.init_policy_ix(&ctx.cfg.clone(), 0);
        ctx.send_owner(&[init]).assert_ok();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs() as i64;
        ctx.set_unix_time(now);
        ctx.warp_to_slot(1_000);

        let label = flavor.name();
        // a floor the real pool will refuse (the agent raises min_out above the pool output)
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[
            compute_unit_limit_ix(400_000),
            ctx.swap_ix(amount_in, u64::MAX, ctx.deadline(100)),
        ]);
        assert!(!r.is_ok(), "{label}: impossible min_out must fail");
        let failing = parse_failures(r.logs()).first().map(|f| f.program);
        assert_eq!(
            failing,
            Some(CPMM_DEVNET),
            "{label}: raydium itself refuses\n{}",
            r.pretty_logs()
        );
        measure(
            &format!("sw15 raydium slippage refusal ({label})"),
            format!("{:?}", parse_failures(r.logs()).first()),
        );
        moved_nothing(&ctx, &before);

        // the real swap
        let r = ctx.send_agent(&[
            compute_unit_limit_ix(400_000),
            ctx.swap_ix(amount_in, 0, ctx.deadline(100)),
        ]);
        r.assert_ok();
        let relay = first_invocation(r.logs(), &RELAY_ID).expect("relay");
        let raydium = invocations(r.logs())
            .into_iter()
            .find(|i| i.program == CPMM_DEVNET)
            .expect("raydium");
        let in_after = ctx.balance(&in_account);
        let out_after = ctx.balance(&out_account);
        assert_eq!(in_after, funds - amount_in);
        assert!(out_after > 0, "the pool paid something");
        measure(
            &format!("sw15 amount_in / amount_out raw ({label})"),
            format!("{amount_in} / {out_after}"),
        );
        measure(&format!("sw15 total tx CU ({label})"), r.cu());
        measure(
            &format!("sw15 relay.own excl. verify+Raydium ({label})"),
            relay.own(),
        );
        measure(
            &format!("sw15 raydium swap_base_input consumed incl. Token CPIs ({label})"),
            raydium.consumed,
        );
        measure(
            &format!("sw15 max stack height ({label})"),
            r.max_stack_height(),
        );
        assert!(relay.own() <= 30_000);
        match r.events().as_slice() {
            [RelayEvent::SwapExecuted {
                in_delta,
                out_delta,
                ..
            }] => {
                assert_eq!((*in_delta, *out_delta), (amount_in, out_after));
            }
            other => panic!("unexpected events {other:?}"),
        }
        assert_eq!(ctx.perm(&CPMM_DEVNET).spend_total, amount_in);
    }

    #[test]
    #[ignore = "SW-15 (P2): needs the dumped devnet Raydium CPMM binary, see the module docs"]
    fn sw15_real_raydium_cpmm_swap_classic() {
        run(Flavor::Classic);
    }

    #[test]
    #[ignore = "SW-15 (P2): needs the dumped devnet Raydium CPMM binary, see the module docs"]
    fn sw15_real_raydium_cpmm_swap_ptoken() {
        run(Flavor::PToken);
    }
}
