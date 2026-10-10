//! TEST-MATRIX area INV: cross-cutting invariants.
//!
//! * INV-01 CPI audit: every `Ctx::send_*` in the whole suite already runs `audit_relay_cpis`
//!   (a violation panics); this file exercises it explicitly over every relay instruction and
//!   proves with fabricated transactions that the audit has teeth.
//! * INV-02 model-based random sequences against a small reference model.
//! * INV-03 policy config round trip and rejection of every mutated reserved / canonical-form byte.

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use common::assert::{audit_relay_cpis, InnerCall, OuterIx};
use common::policy::{off, PolicyView, CONFIG_OFFSET};
use litesvm::types::TransactionMetadata;
use solana_message::compiled_instruction::CompiledInstruction;
use solana_message::inner_instruction::InnerInstruction;

// =============================================================================================
// INV-01
// =============================================================================================

/// Token instruction tags the relay must never emit.
const FORBIDDEN_TOKEN_TAGS: [u8; 9] = [3, 4, 5, 6, 7, 8, 9, 10, 11];

#[track_caller]
fn check_exec(exec: &Exec, agent: &Pubkey, seen: &mut std::collections::BTreeSet<(Pubkey, u8)>) {
    let bad = audit_relay_cpis(exec, agent);
    assert!(bad.is_empty(), "INV-01: {bad:?}\n{}", exec.pretty_logs());
    for c in exec.inner_calls() {
        // the agent key appears in a CPI only as the verify account
        if c.accounts.contains(agent) {
            assert!(
                c.program == AGENT_AUTH_ID && c.data.first() == Some(&3),
                "agent key passed to {} data {:02x?}",
                program_name(&c.program),
                &c.data[..c.data.len().min(8)]
            );
        }
        if c.parent == RELAY_ID {
            seen.insert((c.program, c.data.first().copied().unwrap_or(255)));
            if c.program == TOKEN_ID || c.program == TOKEN22_ID {
                assert!(
                    !FORBIDDEN_TOKEN_TAGS.contains(&c.data[0]),
                    "the relay emitted Token tag {}",
                    c.data[0]
                );
                assert_eq!(c.data[0], 12, "only TransferChecked");
            }
        }
    }
}

use common::assert::program_name;

dual_token!(
    inv_01_cpi_audit_over_every_relay_instruction,
    with | b | b.with_swap().no_policy(),
    |ctx| {
        let agent = ctx.agent.pubkey();
        let mut seen = std::collections::BTreeSet::new();
        // init_policy (CreateAccount), prefunded init path (Transfer + Allocate + Assign)
        let cfg = ctx.cfg.clone();
        let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        let r = ctx.send_owner(&[ctx.close_policy_ix()]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        let policy = ctx.policy;
        ctx.svm.airdrop(&policy, 1_000_000).unwrap(); // a third party pre-funds the PDA
        let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        assert!(
            r.inner_calls().iter().any(|c| c.program == SYSTEM_ID),
            "the pre-funded path must use the System program"
        );
        for p in [1u8, 0] {
            let r = ctx.send_owner(&[ctx.set_paused_ix(p)]);
            r.assert_ok();
            check_exec(&r, &agent, &mut seen);
        }
        // transfer, swap, two in one transaction, and failing variants
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        let r = ctx.send_agent(&[ctx.swap_ix_default(1_000)]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        let r = ctx.send_agent(&[ctx.transfer_ix(1), ctx.swap_ix_default(1_000)]);
        r.assert_ok();
        check_exec(&r, &agent, &mut seen);
        let r = ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), 1)]);
        r.assert_failed();
        check_exec(&r, &agent, &mut seen);
        let r = ctx.send_agent(&[ctx.transfer_ix(u64::MAX)]);
        r.assert_failed();
        check_exec(&r, &agent, &mut seen);

        let allowed: std::collections::BTreeSet<(Pubkey, u8)> = [
            (AGENT_AUTH_ID, 3u8),        // verify
            (ctx.token_program, 12),     // TransferChecked
            (MOCK_AMM_ID, SWAP_DISC[0]), // swap_base_input
            (SYSTEM_ID, 0),              // CreateAccount
            (SYSTEM_ID, 2),              // Transfer
            (SYSTEM_ID, 8),              // Allocate
            (SYSTEM_ID, 1),              // Assign
        ]
        .into_iter()
        .collect();
        assert!(
            seen.is_subset(&allowed),
            "relay CPI set {seen:?} is not within {allowed:?}"
        );
        // every allowed kind of CPI was really exercised (the audit saw the swap, the transfer, verify and System)
        for want in [
            (AGENT_AUTH_ID, 3u8),
            (ctx.token_program, 12),
            (MOCK_AMM_ID, SWAP_DISC[0]),
            (SYSTEM_ID, 0),
            (SYSTEM_ID, 2),
        ] {
            assert!(
                seen.contains(&want),
                "never observed {want:?}; observed {seen:?}"
            );
        }
    }
);

/// A fabricated CPI: (program, data, accounts).
type FakeCall = (Pubkey, Vec<u8>, Vec<Pubkey>);

/// Build a fake transaction whose relay frame emitted `calls`.
fn fake_exec(calls: &[FakeCall]) -> Exec {
    let mut keys = vec![RELAY_ID];
    let mut inner = Vec::new();
    for (program, data, accounts) in calls {
        let idx = |k: &Pubkey, keys: &mut Vec<Pubkey>| -> u8 {
            keys.iter().position(|x| x == k).unwrap_or_else(|| {
                keys.push(*k);
                keys.len() - 1
            }) as u8
        };
        let program_id_index = idx(program, &mut keys);
        let accounts = accounts.iter().map(|a| idx(a, &mut keys)).collect();
        inner.push(InnerInstruction {
            instruction: CompiledInstruction::new_from_raw_parts(
                program_id_index,
                data.clone(),
                accounts,
            ),
            stack_height: 2,
        });
    }
    Exec {
        result: Ok(TransactionMetadata {
            inner_instructions: vec![inner],
            ..Default::default()
        }),
        keys,
        outer: vec![OuterIx {
            program: RELAY_ID,
            accounts: vec![],
            data: vec![3],
        }],
        tx_size: 0,
    }
}

/// The audit must flag exactly the things INV-01 forbids (negative controls) and pass the legal shapes.
#[test]
fn inv_01_audit_has_teeth() {
    let agent = unique();
    let (m, o, s, d) = (unique(), unique(), unique(), unique());
    let mut verify = vec![3u8];
    verify.extend_from_slice(&[0u8; 48]);
    let mut tc = vec![12u8];
    tc.extend_from_slice(&[0u8; 9]);

    // legal: verify with the agent, TransferChecked without it
    let ok = fake_exec(&[
        (AGENT_AUTH_ID, verify.clone(), vec![m, o, agent]),
        (TOKEN_ID, tc.clone(), vec![s, m, d, o]),
    ]);
    assert_eq!(audit_relay_cpis(&ok, &agent), Vec::<String>::new());
    assert_eq!(ok.relay_cpis().len(), 2);

    // each forbidden shape is flagged
    let approve = {
        let mut v = vec![4u8];
        v.extend_from_slice(&[0u8; 8]);
        v
    };
    let forbidden: Vec<(&str, Vec<FakeCall>)> = vec![
        ("Approve", vec![(TOKEN_ID, approve, vec![s, d, o])]),
        ("Revoke", vec![(TOKEN_ID, vec![5], vec![s, o])]),
        ("SetAuthority", vec![(TOKEN_ID, vec![6, 2, 0], vec![s, o])]),
        ("CloseAccount", vec![(TOKEN_ID, vec![9], vec![s, d, o])]),
        (
            "Burn",
            vec![(TOKEN_ID, vec![8, 1, 0, 0, 0, 0, 0, 0, 0], vec![s, m, o])],
        ),
        (
            "Token-2022 Burn",
            vec![(TOKEN22_ID, vec![8, 1, 0, 0, 0, 0, 0, 0, 0], vec![s, m, o])],
        ),
        (
            "agent passed to TransferChecked",
            vec![(TOKEN_ID, tc.clone(), vec![s, m, d, agent])],
        ),
        (
            "agent passed to a swap",
            vec![(
                MOCK_AMM_ID,
                {
                    let mut v = SWAP_DISC.to_vec();
                    v.extend_from_slice(&[0u8; 16]);
                    v
                },
                vec![agent, s, d],
            )],
        ),
        (
            "verify with the wrong length",
            vec![(AGENT_AUTH_ID, vec![3, 0, 0], vec![m, o, agent])],
        ),
        (
            "AgentAuth non-verify tag",
            vec![(
                AGENT_AUTH_ID,
                {
                    let mut v = vec![4u8];
                    v.extend_from_slice(&[0u8; 48]);
                    v
                },
                vec![m, o],
            )],
        ),
        (
            "System CreateAccountWithSeed",
            vec![(SYSTEM_ID, 3u32.to_le_bytes().to_vec(), vec![o, s])],
        ),
        ("unknown program", vec![(unique(), vec![1, 2, 3], vec![s])]),
    ];
    for (name, calls) in forbidden {
        let bad = audit_relay_cpis(&fake_exec(&calls), &agent);
        assert!(!bad.is_empty(), "the audit did not flag: {name}");
    }
    // legal System shapes
    for tag in [0u32, 1, 2, 8] {
        let e = fake_exec(&[(SYSTEM_ID, tag.to_le_bytes().to_vec(), vec![o, s])]);
        assert!(audit_relay_cpis(&e, &agent).is_empty(), "System tag {tag}");
    }
    // the parent attribution works: a CPI made by another frame is not blamed on the relay
    let mut e = fake_exec(&[(unique(), vec![1], vec![s])]);
    e.outer[0].program = unique();
    assert!(e.relay_cpis().is_empty());
    let _ = InnerCall {
        top_index: 0,
        stack_height: 0,
        program: s,
        data: vec![],
        accounts: vec![],
        parent: s,
    };
}

// =============================================================================================
// INV-02 model-based random sequences
// =============================================================================================

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const TOK_SPEND: u64 = 60_000;
const TOK_PER_TX: u64 = 10_000;
const AMM_SPEND: u64 = 40_000;
const AMM_PER_TX: u64 = 8_000;

/// Reference model of everything the random sequence can change.
#[derive(Clone, Debug)]
struct Model {
    mandate_live: bool,
    paused: bool,
    tok_perm: bool,
    tok_spent: u64,
    amm_perm: bool,
    amm_spent: u64,
    src_bal: u64,
    src_deleg: Option<u64>,
    in_bal: u64,
    in_deleg: Option<u64>,
    recip: [u64; 2],
    /// Sum of every allowance the owner granted (initial + each re-Approve).
    approved_src: u64,
}

impl Model {
    fn transfer_ok(&self, a: u64) -> bool {
        self.mandate_live
            && !self.paused
            && self.tok_perm
            && self.src_deleg.is_some_and(|d| d >= a)
            && a <= TOK_PER_TX
            && self.tok_spent + a <= TOK_SPEND
            && self.src_bal >= a
    }
    fn swap_ok(&self, a: u64) -> bool {
        self.mandate_live
            && !self.paused
            && self.amm_perm
            && self.in_deleg.is_some_and(|d| d >= a)
            && a <= AMM_PER_TX
            && self.amm_spent + a <= AMM_SPEND
            && self.in_bal >= a
    }
}

fn spend(deleg: &mut Option<u64>, a: u64) {
    let rem = deleg.expect("delegate") - a;
    *deleg = (rem > 0).then_some(rem);
}

/// Returns (transfers ok, transfers refused, swaps ok, swaps refused).
fn run_sequence(flavor: Flavor, seed: u64, steps: usize) -> [usize; 4] {
    let mut stats = [0usize; 4];
    let Some(mut ctx) = Ctx::builder(flavor)
        .limits(TOK_SPEND, TOK_PER_TX)
        .delegated(50_000)
        .source_balance(1_000_000)
        .swap_with(|s| {
            s.in_balance = 200_000;
            s.in_delegated = 30_000;
            s.amm_spend_limit = AMM_SPEND;
            s.amm_per_tx_limit = AMM_PER_TX;
        })
        .try_build()
    else {
        return stats;
    };
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let (src, in_acct) = (ctx.source, ctx.swap_fixture().in_account);
    let tp = ctx.token_program;
    let mut m = Model {
        mandate_live: true,
        paused: false,
        tok_perm: true,
        tok_spent: 0,
        amm_perm: true,
        amm_spent: 0,
        src_bal: 1_000_000,
        src_deleg: Some(50_000),
        in_bal: 200_000,
        in_deleg: Some(30_000),
        recip: [0, 0],
        approved_src: 50_000,
    };
    let mut log: Vec<String> = Vec::new();

    for step in 0..steps {
        let op = rng.below(26);
        let what;
        match op {
            0..=5 => {
                // transfer to an allowlisted recipient
                let a = 1 + rng.below(12_000);
                let r = rng.below(2) as usize;
                what = format!("transfer({a}) -> recipient{r}");
                let ix = ctx.transfer_ix_to(&ctx.recipients[r].clone(), a);
                let exec = ctx.send_agent(&[ix]);
                let expect = m.transfer_ok(a);
                stats[usize::from(!expect)] += 1;
                assert_eq!(
                    exec.is_ok(),
                    expect,
                    "seed {seed} step {step}: {what}; model {m:?}\n{log:#?}\n{}",
                    exec.pretty_logs()
                );
                if expect {
                    m.src_bal -= a;
                    m.recip[r] += a;
                    spend(&mut m.src_deleg, a);
                    m.tok_spent += a;
                }
            }
            6..=10 => {
                // >= 20 so the mock pool's floor rounding (out = a - 1) clears the 95% floor price
                let a = 20 + rng.below(9_981);
                what = format!("swap({a})");
                let ix = ctx.swap_ix_default(a);
                let exec = ctx.send_agent(&[ix]);
                let expect = m.swap_ok(a);
                stats[2 + usize::from(!expect)] += 1;
                assert_eq!(
                    exec.is_ok(),
                    expect,
                    "seed {seed} step {step}: {what}; model {m:?}\n{log:#?}\n{}",
                    exec.pretty_logs()
                );
                if expect {
                    m.in_bal -= a;
                    spend(&mut m.in_deleg, a);
                    m.amm_spent += a;
                }
            }
            11 => {
                // transfer to a non-allowlisted account: always refused
                let a = 1 + rng.below(1_000);
                let dest = if rng.below(2) == 0 {
                    ctx.attacker_token
                } else {
                    ctx.agent_token
                };
                what = format!("transfer({a}) -> NOT allowlisted");
                let ix = ctx.transfer_ix_to(&dest, a);
                let exec = ctx.send_agent(&[ix]);
                exec.assert_failed();
            }
            12 | 13 => {
                what = "pause/unpause".to_string();
                let p = u8::from(rng.below(4) == 0);
                ctx.send_owner(&[ctx.set_paused_ix(p)]).assert_ok();
                m.paused = p == 1;
            }
            14 => {
                // flip the Token slot
                if m.mandate_live {
                    if m.tok_perm {
                        what = "remove Token permission".to_string();
                        ctx.send_owner(&[ctx.remove_permission_ix(&tp)]).assert_ok();
                        m.tok_perm = false;
                    } else {
                        what = "add Token permission".to_string();
                        let ix = ctx.add_permission_ix(
                            &tp,
                            TOK_SPEND,
                            TOK_PER_TX,
                            &[TRANSFER_CHECKED_DISC],
                        );
                        ctx.send_owner(&[ix]).assert_ok();
                        m.tok_perm = true;
                        m.tok_spent = 0;
                    }
                } else {
                    what = "(skipped: mandate revoked)".to_string();
                }
            }
            15 => {
                if m.mandate_live {
                    if m.amm_perm {
                        what = "remove AMM permission".to_string();
                        ctx.send_owner(&[ctx.remove_permission_ix(&MOCK_AMM_ID)])
                            .assert_ok();
                        m.amm_perm = false;
                    } else {
                        what = "add AMM permission".to_string();
                        let ix = ctx.add_permission_ix(
                            &MOCK_AMM_ID,
                            AMM_SPEND,
                            AMM_PER_TX,
                            &[SWAP_DISC],
                        );
                        ctx.send_owner(&[ix]).assert_ok();
                        m.amm_perm = true;
                        m.amm_spent = 0;
                    }
                } else {
                    what = "(skipped: mandate revoked)".to_string();
                }
            }
            16 => {
                if m.mandate_live && rng.below(3) == 0 {
                    what = "revoke_mandate".to_string();
                    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
                    m.mandate_live = false;
                    m.tok_perm = false;
                    m.amm_perm = false;
                } else if !m.mandate_live {
                    // re-create with the SAME expiry: the old policy binds again (L8), no permissions yet
                    what = "re-create mandate (same expiry)".to_string();
                    ctx.send_owner(&[ctx.create_mandate_ix(ctx.expiry)])
                        .assert_ok();
                    m.mandate_live = true;
                    m.tok_spent = 0;
                    m.amm_spent = 0;
                } else {
                    what = "(noop)".to_string();
                }
            }
            17 => {
                what = "Token.Revoke(source)".to_string();
                ctx.send_owner(&[ctx.revoke_delegate_ix(&src)]).assert_ok();
                m.src_deleg = None;
            }
            18 => {
                what = "Token.Revoke(in_account)".to_string();
                ctx.send_owner(&[ctx.revoke_delegate_ix(&in_acct)])
                    .assert_ok();
                m.in_deleg = None;
            }
            19..=22 => {
                let amt = 1 + rng.below(40_000);
                what = format!("re-Approve(source, {amt})");
                ctx.send_owner(&[ctx.approve_ix(&src, &ctx.authority.clone(), amt)])
                    .assert_ok();
                m.src_deleg = Some(amt);
                m.approved_src += amt;
            }
            _ => {
                let amt = 1 + rng.below(40_000);
                what = format!("re-Approve(in_account, {amt})");
                ctx.send_owner(&[ctx.approve_ix(&in_acct, &ctx.authority.clone(), amt)])
                    .assert_ok();
                m.in_deleg = Some(amt);
            }
        }
        log.push(format!("{step}: {what}"));

        // ---- invariants after every step (the audit of INV-01 ran inside send_*)
        let s = ctx.token(&src);
        assert_eq!(
            s.amount, m.src_bal,
            "seed {seed} step {step} ({what}): source balance"
        );
        assert_eq!(
            s.owner,
            ctx.owner.pubkey(),
            "source still owned by the owner"
        );
        assert_eq!(
            s.delegate,
            m.src_deleg.map(|_| ctx.authority),
            "seed {seed} step {step}: source delegate"
        );
        if let Some(d) = m.src_deleg {
            assert_eq!(
                s.delegated_amount, d,
                "seed {seed} step {step}: source delegated_amount"
            );
        } else {
            assert_eq!(s.delegated_amount, 0);
        }
        // I11: nothing ever left the source beyond what the owner approved over time
        assert!(
            1_000_000 - s.amount <= m.approved_src,
            "I11: debit {} > approved {}",
            1_000_000 - s.amount,
            m.approved_src
        );
        let i = ctx.token(&in_acct);
        assert_eq!(
            i.amount, m.in_bal,
            "seed {seed} step {step} ({what}): in_account balance"
        );
        assert_eq!(i.delegated_amount, m.in_deleg.unwrap_or(0));
        // recipients only allowlisted: exact balances, attacker and agent accounts untouched
        assert_eq!(ctx.balance(&ctx.recipients[0]), m.recip[0]);
        assert_eq!(ctx.balance(&ctx.recipients[1]), m.recip[1]);
        assert_eq!(
            ctx.balance(&ctx.attacker_token),
            0,
            "attacker account untouched"
        );
        assert_eq!(ctx.balance(&ctx.agent_token), 0, "agent account untouched");
        // I12: the Token slot counter equals the sum debited from the source since the slot was created
        if m.mandate_live && m.tok_perm {
            assert_eq!(
                ctx.token_perm().spend_total,
                m.tok_spent,
                "I12 at step {step}"
            );
        }
        if m.mandate_live && m.amm_perm {
            assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, m.amm_spent);
        }
        // the policy is never touched except by set_paused
        let pol = ctx.policy_bytes();
        assert_eq!(
            pol[off::FLAGS],
            u8::from(m.paused),
            "paused flag mirrors the model"
        );
        let mut canon = ctx.expected_header(0).encode_with(&ctx.cfg);
        canon[off::FLAGS] = u8::from(m.paused);
        assert_eq!(pol, canon, "policy bytes changed");
    }
    stats
}

/// The random walk must really exercise both outcomes of both actions.
#[track_caller]
fn assert_exercised(total: [usize; 4]) {
    eprintln!("INV-02 outcomes (transfer ok/refused, swap ok/refused): {total:?}");
    assert!(
        total.iter().all(|&n| n >= 20),
        "sequences too one-sided: {total:?}"
    );
}

#[test]
fn inv_02_model_based_random_sequences_classic() {
    let mut total = [0usize; 4];
    for seed in 1..=24 {
        for (t, n) in total
            .iter_mut()
            .zip(run_sequence(Flavor::Classic, seed, 60))
        {
            *t += n;
        }
    }
    assert_exercised(total);
}

#[test]
fn inv_02_model_based_random_sequences_ptoken() {
    let mut total = [0usize; 4];
    for seed in 101..=124 {
        for (t, n) in total.iter_mut().zip(run_sequence(Flavor::PToken, seed, 60)) {
            *t += n;
        }
    }
    assert_exercised(total);
}

// =============================================================================================
// INV-03 policy config round trip and mutated reserved bytes
// =============================================================================================

fn random_cfg(tp: Pubkey, mint: Pubkey, source: Pubkey, n: usize) -> PolicyCfg {
    let recips: Vec<Pubkey> = (0..n).map(|_| unique()).collect();
    PolicyCfg::transfer_only(tp, mint, source, &recips)
}

#[test]
fn inv_03_encode_decode_round_trip_host() {
    let mut rng = Rng(0xDEAD_BEEF_1234_5679);
    for n in 0..=8 {
        for _ in 0..20 {
            let cfg = random_cfg(TOKEN_ID, unique(), unique(), n);
            assert_eq!(PolicyCfg::decode(&cfg.encode()), cfg);
            assert_eq!(cfg.init_data(3).len(), 802);
            // swap section too
            let pins = SwapPins {
                amm_program: MOCK_AMM_ID,
                amm_authority: unique(),
                amm_config: unique(),
                pool_state: unique(),
                input_vault: unique(),
                output_vault: unique(),
                observation_state: unique(),
                in_mint: unique(),
                out_mint: unique(),
                in_token_program: TOKEN_ID,
                out_token_program: TOKEN22_ID,
                in_account: unique(),
                out_account: unique(),
                floor_out: rng.next() | 1,
                floor_in: rng.next() | 1,
                max_deadline_slots: 1 + rng.below(9000) as u32,
            };
            let cfg = cfg.with_swap(&pins);
            assert_eq!(PolicyCfg::decode(&cfg.encode()), cfg);
            let hdr = PolicyHeader {
                policy_bump: rng.below(256) as u8,
                authority_bump: rng.below(256) as u8,
                flags: rng.below(4) as u8,
                mandate: unique(),
                owner: unique(),
                agent: unique(),
                authority: unique(),
                mandate_expiry: rng.next() as i64,
            };
            let view = PolicyView::decode(&hdr.encode_with(&cfg));
            assert_eq!((view.header.clone(), view.cfg.clone()), (hdr, cfg));
        }
    }
}

/// Through the program: for every recipient count and flag combination the stored bytes decode
/// back to exactly the submitted config and header.
#[test]
fn inv_03_round_trip_through_init_policy() {
    for flavor in Flavor::DUAL {
        for n in 0..=8usize {
            for flags in [
                0u8,
                FLAG_STRICT_TOP_LEVEL,
                FLAG_PAUSED,
                FLAG_PAUSED | FLAG_STRICT_TOP_LEVEL,
            ] {
                let Some(mut ctx) = Ctx::builder(flavor).no_policy().try_build() else {
                    return;
                };
                let cfg = random_cfg(ctx.token_program, ctx.mint, ctx.source, n);
                ctx.send_owner(&[ctx.init_policy_ix(&cfg, flags)])
                    .assert_ok();
                let v = ctx.policy_view();
                assert_eq!(v.cfg, cfg, "n={n} flags={flags}");
                assert_eq!(v.header, ctx.expected_header(flags));
                assert_eq!(
                    ctx.policy_bytes(),
                    ctx.expected_header(flags).encode_with(&cfg)
                );
                if n == 0 {
                    // an empty allowlist is valid and means "no transfer is ever allowed"
                    if flags & FLAG_PAUSED == 0 {
                        ctx.send_agent(&[ctx.transfer_ix(1)])
                            .assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
                    }
                }
            }
        }
    }
}

/// Every reserved byte and every byte of the canonical-zero swap region, mutated one at a time, is 113.
#[test]
fn inv_03_mutated_reserved_and_canonical_bytes_are_rejected() {
    for flavor in Flavor::DUAL {
        // transfer-only config: reserved1/reserved2 AND the whole swap region must stay zero
        let Some(mut ctx) = Ctx::builder(flavor).no_policy().try_build() else {
            return;
        };
        let cfg = ctx.cfg.clone();
        assert_eq!(cfg.swap_enabled, 0);
        let good = ctx.init_policy_ix(&cfg, 0);
        let mut offsets: Vec<usize> = (off::RESERVED1..off::RESERVED1 + 6).collect();
        offsets.extend(off::RESERVED2..off::RESERVED2 + 4);
        offsets.extend(off::AMM_PROGRAM..off::RESERVED2); // 504..940: all swap fields
        offsets.extend(off::MAX_DEADLINE_SLOTS..off::MAX_DEADLINE_SLOTS + 4);
        let mut failures = Vec::new();
        for abs in &offsets {
            for v in [1u8, 0xFF] {
                let ix = good.clone().patch_data(2 + abs - CONFIG_OFFSET, &[v]);
                let r = ctx.send_owner(&[ix]);
                let code = common::assert::custom_code(&r.result);
                if code != Some(relay_err::INVALID_CONFIG) {
                    failures.push(format!("byte {abs}={v:#x}: got {code:?}"));
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
        assert!(
            ctx.svm.get_account(&ctx.policy).is_none(),
            "nothing was created"
        );
        ctx.send_owner(&[good]).assert_ok();

        // swap-enabled config: reserved bytes are still rejected
        let Some(mut ctx) = Ctx::builder(flavor).with_swap().no_policy().try_build() else {
            return;
        };
        let cfg = ctx.cfg.clone();
        let good = ctx.init_policy_ix(&cfg, 0);
        for abs in (off::RESERVED1..off::RESERVED1 + 6).chain(off::RESERVED2..off::RESERVED2 + 4) {
            for v in [1u8, 0x80] {
                let ix = good.clone().patch_data(2 + abs - CONFIG_OFFSET, &[v]);
                ctx.send_owner(&[ix])
                    .assert_relay_err(relay_err::INVALID_CONFIG);
            }
        }
        // recipients beyond recipients_len must be zero
        let n = cfg.recipients_len as usize;
        for slot in n..8 {
            let ix = good
                .clone()
                .patch_data(2 + off::RECIPIENTS + 32 * slot - CONFIG_OFFSET + 31, &[1]);
            ctx.send_owner(&[ix])
                .assert_relay_err(relay_err::INVALID_CONFIG);
        }
        // flags: every reserved bit
        for bit in 2..8 {
            let ix = good.clone().patch_data(1, &[1u8 << bit]);
            ctx.send_owner(&[ix])
                .assert_relay_err(relay_err::INVALID_CONFIG);
        }
        ctx.send_owner(&[good]).assert_ok();
    }
}
