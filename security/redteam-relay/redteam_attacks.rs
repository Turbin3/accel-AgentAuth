//! RED TEAM: targeted attacks on the AgentAuth relay (LiteSVM, real .so binaries).
//!
//! Every test ASSERTS THE SAFE OUTCOME, so a failing test is a finding. Tests that document a
//! behaviour the spec classifies as ACCEPTED (ACC) assert that behaviour and print `CONFIRMED`.
//!
//! Run: see `README.md` next to this file. `cargo test -p agent-auth-relay --test redteam_attacks -- --nocapture`

#![allow(clippy::result_large_err, dead_code, unused_imports)]

#[macro_use]
mod common;
mod redteam_util;

use std::collections::BTreeMap;

use common::*;
use redteam_util::*;

const AMT: u64 = 1_000;

fn flavors() -> [Flavor; 3] {
    Flavor::ALL
}

// =====================================================================================
// RT-01  aliasing matrix, transfer: replace account j by the key of account i
// =====================================================================================

#[test]
fn rt01_transfer_alias_matrix() {
    for flavor in flavors() {
        let mut ctx = Ctx::builder(flavor).build();
        let keys = transfer_keys(&ctx);
        let mut hist: BTreeMap<String, usize> = BTreeMap::new();
        for i in 0..10 {
            for j in 0..10 {
                if i == j {
                    continue;
                }
                let base = ctx.transfer_ix(AMT);
                let ki = base.accounts[i].pubkey;
                let mut ix = base.with_account(j, ki);
                if j == 0 {
                    ix = ix.with_signer(0, false);
                }
                let before = ledger(&ctx, &keys);
                let e = ctx.send_agent(&[ix]);
                let after = ledger(&ctx, &keys);
                let o = outcome(&e);
                assert!(!is_abnormal(&o), "{flavor:?} alias({i}->{j}) abnormal {o}\n{}", e.pretty_logs());
                *hist.entry(o.clone()).or_default() += 1;
                if e.is_ok() {
                    let d = deltas(&before, &after);
                    let mut want = BTreeMap::new();
                    want.insert(ctx.source, -(AMT as i128));
                    want.insert(ctx.recipients[0], AMT as i128);
                    assert_eq!(d, want, "{flavor:?} alias({i}->{j}) succeeded with odd deltas\n{}", e.pretty_logs());
                    println!("NOTE {flavor:?} alias({i}->{j}) is OK with the expected deltas");
                } else {
                    assert_eq!(before, after, "{flavor:?} alias({i}->{j}) failed but state moved");
                }
            }
        }
        print_hist(&format!("RT-01 transfer alias matrix {flavor:?}"), &hist);
    }
}

// =====================================================================================
// RT-02  aliasing matrix, swap (19 x 19)
// =====================================================================================

fn swap_keys(ctx: &Ctx) -> Vec<Pubkey> {
    transfer_keys(ctx)
}

#[test]
fn rt02_swap_alias_matrix() {
    for flavor in flavors() {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let keys = swap_keys(&ctx);
        let mut hist: BTreeMap<String, usize> = BTreeMap::new();
        for i in 0..19 {
            for j in 0..19 {
                if i == j {
                    continue;
                }
                let base = ctx.swap_ix(10_000, 0, ctx.deadline(100));
                let ki = base.accounts[i].pubkey;
                let mut ix = base.with_account(j, ki);
                if j == 0 {
                    ix = ix.with_signer(0, false);
                }
                let before = ledger(&ctx, &keys);
                let e = ctx.send_agent(&[ix]);
                let after = ledger(&ctx, &keys);
                let o = outcome(&e);
                assert!(!is_abnormal(&o), "{flavor:?} swap alias({i}->{j}) abnormal {o}\n{}", e.pretty_logs());
                *hist.entry(o.clone()).or_default() += 1;
                if e.is_ok() {
                    // The only acceptable success is the pristine swap's effect.
                    let s = ctx.swap_fixture().clone();
                    let d = deltas(&before, &after);
                    assert_eq!(d.get(&s.in_account), Some(&-10_000i128), "{flavor:?} alias({i}->{j}) {d:?}");
                    assert!(d.get(&s.out_account).copied().unwrap_or(0) >= 9_500, "{flavor:?} alias({i}->{j}) {d:?}");
                    assert_eq!(d.len(), 4, "{flavor:?} alias({i}->{j}) extra movement {d:?}");
                    println!("NOTE {flavor:?} swap alias({i}->{j}) OK with expected deltas");
                } else {
                    assert_eq!(before, after, "{flavor:?} swap alias({i}->{j}) failed but state moved");
                }
            }
        }
        print_hist(&format!("RT-02 swap alias matrix {flavor:?}"), &hist);
    }
}

// =====================================================================================
// RT-03  signer / writable flag flips on every account (agent controls the flags)
// =====================================================================================

#[test]
fn rt03_flag_flip_matrix() {
    for flavor in flavors() {
        for with_swap in [false, true] {
            let mut ctx = if with_swap {
                Ctx::builder(flavor).with_swap().build()
            } else {
                Ctx::builder(flavor).build()
            };
            let keys = swap_keys(&ctx);
            let n = if with_swap { 19 } else { 10 };
            let mut hist: BTreeMap<String, usize> = BTreeMap::new();
            for idx in 0..n {
                for (what, val) in [("writable", true), ("writable", false), ("signer", true), ("signer", false)] {
                    let base = if with_swap {
                        ctx.swap_ix(10_000, 0, ctx.deadline(100))
                    } else {
                        ctx.transfer_ix(AMT)
                    };
                    let ix = if what == "writable" {
                        base.with_writable(idx, val)
                    } else {
                        base.with_signer(idx, val)
                    };
                    // We can only sign for agent (0), owner (2). Skip signer=true on other slots.
                    let signers: Vec<Who> = if what == "signer" && val && idx == 2 {
                        vec![Who::Agent, Who::Owner]
                    } else if what == "signer" && val && idx != 0 {
                        continue;
                    } else {
                        vec![Who::Agent]
                    };
                    let before = ledger(&ctx, &keys);
                    let e = ctx.send_as(&signers, &[ix]);
                    let after = ledger(&ctx, &keys);
                    let o = outcome(&e);
                    assert!(!is_abnormal(&o), "{flavor:?} swap={with_swap} flag {what}={val} on {idx}: abnormal {o}\n{}", e.pretty_logs());
                    *hist.entry(o.clone()).or_default() += 1;
                    if e.is_ok() {
                        let d = deltas(&before, &after);
                        // Only owner-held accounts count as "owner loss": source (+ in_account for swap).
                        let mut owner_accts = vec![ctx.source];
                        if let Some(s) = &ctx.swap {
                            owner_accts.push(s.in_account);
                        }
                        let lost: i128 = owner_accts.iter().filter_map(|k| d.get(k)).filter(|v| **v < 0).sum();
                        let allowed = if with_swap { -10_000 } else { -(AMT as i128) };
                        assert!(
                            lost >= allowed,
                            "{flavor:?} flag {what}={val}@{idx}: owner lost {lost} > allowed {allowed}"
                        );
                        assert_eq!(ctx.balance(&ctx.attacker_token), 0);
                        assert_eq!(ctx.balance(&ctx.agent_token), 0);
                    } else {
                        assert_eq!(before, after);
                    }
                }
            }
            print_hist(&format!("RT-03 flag flips {flavor:?} swap={with_swap}"), &hist);
        }
    }
}

// =====================================================================================
// RT-04  same-transaction multi-instruction split (spec E08 / L4): quantify
// =====================================================================================

#[test]
fn rt04_split_across_instructions_in_one_tx() {
    for flavor in Flavor::DUAL {
        // per_tx_limit 1_000, lifetime 10_000, delegated 10_000
        let mut ctx = Ctx::builder(flavor)
            .limits(10_000, 1_000)
            .delegated(50_000)
            .build();
        // A single 5_000 transfer is refused by the mandate (PerTxExceeded = 8).
        ctx.send_agent(&[ctx.transfer_ix(5_000)]).assert_aa_err(aa_err::PER_TX_EXCEEDED);
        // Ten 1_000 transfers in ONE transaction move 10_000, ten times per_tx_limit.
        let ixs: Vec<_> = (0..10).map(|_| ctx.transfer_ix(1_000)).collect();
        let before = ctx.balance(&ctx.recipients[0]);
        let e = ctx.send_agent(&ixs);
        println!("RT-04 {flavor:?}: tx with 10 relay transfers => {} (tx bytes {}, CU {})", outcome(&e), e.tx_size, e.cu());
        if e.is_ok() {
            let moved = ctx.balance(&ctx.recipients[0]) - before;
            println!("RT-04 CONFIRMED (spec E08 accepted risk): {moved} units moved in one transaction although per_tx_limit = 1_000");
            assert_eq!(moved, 10_000);
        } else {
            println!("RT-04 {flavor:?} tx failed: {}", e.pretty_logs());
        }
        // The lifetime cap still holds: an 11th transfer is SpendLimitExceeded (9).
        ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_aa_err(aa_err::SPEND_LIMIT_EXCEEDED);
    }
}

// =====================================================================================
// RT-05  stale policy re-binding after revoke + re-create with identical expiry (L8)
// =====================================================================================

#[test]
fn rt05_stale_policy_rebinding_same_expiry() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).build();
        let r0 = ctx.recipients[0];
        // Owner revokes ONLY the mandate (not the delegation, not the policy).
        ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_relay_err(relay_err::INVALID_MANDATE);
        // Owner later re-creates a mandate for the same agent with the SAME expiry and a
        // fresh, narrower budget (spend 5_000 / per tx 500).
        ctx.send_owner(&[
            ctx.create_mandate_ix(ctx.expiry),
            ctx.add_permission_ix(&ctx.token_program, 5_000, 500, &[TRANSFER_CHECKED_DISC]),
        ])
        .assert_ok();
        // No relay instruction was run. The OLD policy (recipients, source) is live again.
        let before = ctx.balance(&r0);
        let e = ctx.send_agent(&[ctx.transfer_ix(400)]);
        println!("RT-05 {flavor:?}: old policy after revoke+recreate(same expiry) => {}", outcome(&e));
        e.assert_ok();
        assert_eq!(ctx.balance(&r0), before + 400);
        println!("RT-05 CONFIRMED residual (spec L8/D8): same-expiry re-creation silently re-binds the old policy and the old SPL delegation");
        // A different expiry is caught (118).
        ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
        ctx.send_owner(&[
            ctx.create_mandate_ix(ctx.expiry + 1),
            ctx.add_permission_ix(&ctx.token_program, 5_000, 500, &[TRANSFER_CHECKED_DISC]),
        ])
        .assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_relay_err(relay_err::STALE_POLICY);
    }
}

// =====================================================================================
// RT-06  pre-funding / dust griefing of the policy PDA and the authority PDA
// =====================================================================================

#[test]
fn rt06_prefund_policy_pda_does_not_brick_init() {
    for flavor in Flavor::DUAL {
        let rent944 = Ctx::builder(flavor).no_policy().build().svm.rent(944);
        for dust in [890_880u64, rent944 - 1, rent944, rent944 + 1, 50_000_000] {
            let mut ctx = Ctx::builder(flavor).no_policy().build();
            // Attacker sends lamports to the (not yet created) policy PDA and the authority PDA.
            ctx.send_attacker(&[
                system_transfer_ix(&ctx.attacker.pubkey(), &ctx.policy, dust),
                system_transfer_ix(&ctx.attacker.pubkey(), &ctx.authority, dust),
            ])
            .assert_ok();
            let cfg = ctx.cfg.clone();
            ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)])
                .assert_ok();
            // The policy works.
            ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_ok();
            // And it can be closed and re-created (dust returned to owner).
            ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
            assert!(ctx.svm.get_account(&ctx.policy).is_none(), "policy account must be gone");
            ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]).assert_ok();
        }
    }
}

// =====================================================================================
// RT-07  close_policy + init_policy in ONE transaction, and policy zeroing
// =====================================================================================

#[test]
fn rt07_close_and_reinit_same_tx() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).build();
        let mut cfg = ctx.cfg.clone();
        // New config: a single different recipient.
        let newr = ctx.new_token_account(unique(), 0, "newr");
        cfg.recipients = [Pubkey::default(); 8];
        cfg.recipients[0] = newr;
        cfg.recipients_len = 1;
        let e = ctx.send_owner(&[ctx.close_policy_ix(), ctx.init_policy_ix(&cfg, 0)]);
        println!("RT-07 {flavor:?} close+init same tx => {}", outcome(&e));
        e.assert_ok();
        // old recipient now refused, new accepted
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        ctx.send_agent(&[ctx.transfer_ix_to(&newr, AMT)]).assert_ok();
    }
}

// =====================================================================================
// RT-08  authority / ownership: who may pause, close, init
// =====================================================================================

#[test]
fn rt08_owner_only_operations() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).build();
        let atk = ctx.attacker.pubkey();
        let agent = ctx.agent.pubkey();
        // attacker / agent trying set_paused / close_policy for the victim's policy
        for who in [Who::Attacker, Who::Agent] {
            let pk = if who == Who::Attacker { atk } else { agent };
            let set = relay_ix::set_paused_ix(&pk, &ctx.policy, 1);
            let close = relay_ix::close_policy_ix(&pk, &ctx.policy);
            ctx.send_as(&[who], &[set]).assert_relay_err(relay_err::NOT_POLICY_OWNER);
            ctx.send_as(&[who], &[close]).assert_relay_err(relay_err::NOT_POLICY_OWNER);
            // owner key passed but not a signer (attacker pays)
            let owner = ctx.owner.pubkey();
            let set = relay_ix::set_paused_ix(&owner, &ctx.policy, 1).with_signer(0, false);
            ctx.send_as(&[who], &[set]).assert_relay_err(relay_err::OWNER_NOT_SIGNER);
            let close = relay_ix::close_policy_ix(&owner, &ctx.policy).with_signer(0, false);
            ctx.send_as(&[who], &[close]).assert_relay_err(relay_err::OWNER_NOT_SIGNER);
        }
        // attacker calling init_policy for the victim's mandate
        let cfg = ctx.cfg.clone();
        ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
        let ix = InitPolicyIx::new(atk, ctx.mandate, ctx.policy).ix(&cfg.init_data(0));
        ctx.send_attacker(&[ix]).assert_relay_err(relay_err::NOT_POLICY_OWNER);
        // pause: agent fails with 116, owner may unpause
        ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]).assert_ok();
        ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_relay_err(relay_err::PAUSED);
        ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_ok();
    }
}

// =====================================================================================
// RT-09  cross-principal confused deputy
// =====================================================================================

#[test]
fn rt09_attacker_own_mandate_pinning_victim_source() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).build();
        // The attacker is a complete second principal whose policy pins the VICTIM's source.
        let victim_source = ctx.source;
        let before = ctx.balance(&victim_source);
        let p = ctx.add_principal(None, Some(victim_source));
        let mut t = ctx.transfer_accounts_of(&p);
        t.destination = ctx.recipients[0];
        let e = ctx.send_keys(&[&p.agent], &[t.ix(AMT)]);
        println!("RT-09 {flavor:?} attacker mandate + victim source => {}", outcome(&e));
        e.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        assert_eq!(ctx.balance(&victim_source), before);
        // The victim (legit) delegate is the victim authority; try using the VICTIM's authority
        // with the attacker's mandate / policy.
        let mut t2 = ctx.transfer_accounts_of(&p);
        t2.authority = ctx.authority;
        ctx.send_keys(&[&p.agent], &[t2.ix(AMT)]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        // Victim mandate + victim policy, attacker's agent key signing.
        let mut t3 = ctx.transfer_accounts();
        t3.agent = p.agent.pubkey();
        ctx.send_keys(&[&p.agent], &[t3.ix(AMT)]).assert_relay_err(relay_err::INVALID_MANDATE);
        // Attacker's agent + attacker mandate, victim's policy.
        let mut t4 = ctx.transfer_accounts_of(&p);
        t4.policy = ctx.policy;
        ctx.send_keys(&[&p.agent], &[t4.ix(AMT)]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        assert_eq!(ctx.balance(&victim_source), before);
    }
}

// =====================================================================================
// RT-10  delegation tricks
// =====================================================================================

#[test]
fn rt10_delegate_tricks() {
    for flavor in Flavor::DUAL {
        // delegated_amount smaller than the mandate limits: Token program is the cap.
        let mut ctx = Ctx::builder(flavor).delegated(1_500).limits(0, 0).build();
        ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
        // 500 remain; 600 is refused by the relay (105) before the Token program is reached
        ctx.send_agent(&[ctx.transfer_ix(600)]).assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        ctx.send_agent(&[ctx.transfer_ix(500)]).assert_ok();
        // delegate cleared at zero: nothing more, even 1
        ctx.send_agent(&[ctx.transfer_ix(1)]).assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        // Agent uses the delegation directly with its own key: OwnerMismatch.
        let ix = ctx.raw_transfer_checked_ix(&ctx.agent.pubkey(), &ctx.agent_token, 1);
        let r = ctx.send_agent(&[ix]);
        r.assert_token_err(&ctx.token_program, token_err::OWNER_MISMATCH);
        // Agent tries Approve / SetAuthority / CloseAccount / Revoke on the owner's source.
        let atk = ctx.agent.pubkey();
        let approve = token::spl_approve(&ctx.token_program, &ctx.source, &atk, &atk, u64::MAX);
        ctx.send_agent(&[approve]).assert_token_err(&ctx.token_program, token_err::OWNER_MISMATCH);
        let setauth = token::spl_set_authority(&ctx.token_program, &ctx.source, &atk, token::AUTH_ACCOUNT_OWNER, Some(&atk));
        ctx.send_agent(&[setauth]).assert_token_err(&ctx.token_program, token_err::OWNER_MISMATCH);
        let close = token::spl_close_account(&ctx.token_program, &ctx.source, &atk, &atk);
        ctx.send_agent(&[close]).assert_failed();
    }
}

// =====================================================================================
// RT-11  second mandate for the same owner overwrites the SPL delegate (B09)
// =====================================================================================

#[test]
fn rt11_second_mandate_same_source_fails_closed() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).build();
        let owner_kp = ctx.owner.insecure_clone();
        let p2 = ctx.add_principal(Some(owner_kp), Some(ctx.source));
        // Owner approves principal 2's authority on the same source: this overwrites the first.
        let ap = ctx.approve_ix(&ctx.source.clone(), &p2.authority, 5_000);
        ctx.send_owner(&[ap]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        let mut t = ctx.transfer_accounts_of(&p2);
        t.destination = ctx.recipients[0];
        ctx.send_keys(&[&p2.agent], &[t.ix(AMT)]).assert_ok();
    }
}

// =====================================================================================
// RT-12  swap: all 13 hostile pool modes, owner conservation
// =====================================================================================

#[test]
fn rt12_swap_hostile_modes() {
    for flavor in Flavor::DUAL {
        for mode in 0..amm_mode::COUNT {
            let mut ctx = Ctx::builder(flavor)
                .swap_with(|o| o.mode = mode)
                .build();
            let s = ctx.swap_fixture().clone();
            let keys = swap_keys(&ctx);
            let before = ledger(&ctx, &keys);
            let attacker_before = ctx.balance(&ctx.attacker_token);
            let ix = ctx.swap_ix(10_000, 0, ctx.deadline(100));
            let e = ctx.send_agent(&[ix]);
            let after = ledger(&ctx, &keys);
            let o = outcome(&e);
            println!("RT-12 {flavor:?} mode {mode:2} => {o}");
            assert!(!is_abnormal(&o) || mode == amm_mode::BURN_CPU, "mode {mode}: {o}");
            let d = deltas(&before, &after);
            if e.is_ok() {
                // owner's input fell by at most amount_in; output rose by at least the floor
                let in_delta = -d.get(&s.in_account).copied().unwrap_or(0);
                let out_delta = d.get(&s.out_account).copied().unwrap_or(0);
                assert!((0..=10_000).contains(&in_delta), "mode {mode} in_delta {in_delta}");
                assert!(out_delta >= 4_000, "mode {mode} out {out_delta} too low");
                assert!(mode == amm_mode::NORMAL || mode == amm_mode::PULL_LESS, "mode {mode} unexpectedly succeeded");
            } else {
                assert_eq!(before, after, "mode {mode} failed but state moved");
            }
            assert_eq!(ctx.balance(&ctx.attacker_token), attacker_before, "attacker gained in mode {mode}");
            // the owner token accounts keep owner/delegate/close-authority untouched
            let i = ctx.token(&s.in_account);
            assert_eq!(i.owner, ctx.owner.pubkey());
            let o2 = ctx.token(&s.out_account);
            assert_eq!(o2.owner, ctx.owner.pubkey());
        }
    }
}

// =====================================================================================
// RT-13  swap deadline / clock edges
// =====================================================================================

#[test]
fn rt13_deadline_edges() {
    let mut ctx = Ctx::builder(Flavor::Classic)
        .swap_with(|o| o.max_deadline_slots = 150)
        .build();
    ctx.warp_to_slot(1_000);
    let slot = ctx.slot();
    let cases: [(u64, Option<u32>); 8] = [
        (slot, None),
        (slot + 150, None),
        (slot + 151, Some(relay_err::DEADLINE_EXPIRED)),
        (slot - 1, Some(relay_err::DEADLINE_EXPIRED)),
        (0, Some(relay_err::DEADLINE_EXPIRED)),
        (u64::MAX, Some(relay_err::DEADLINE_EXPIRED)),
        (slot + 1, None),
        (slot + u64::from(u32::MAX), Some(relay_err::DEADLINE_EXPIRED)),
    ];
    for (deadline, want) in cases {
        ctx.warp_to_slot(1_000);
        let e = ctx.send_agent(&[ctx.swap_ix(10_000, 0, deadline)]);
        match want {
            None => {
                e.assert_ok();
            }
            Some(c) => {
                e.assert_relay_err(c);
            }
        }
    }
}

// =====================================================================================
// RT-14  production build rejects the mock AMM, devnet build rejects the mainnet CPMM
// =====================================================================================

#[test]
fn rt14_amm_allowlist_by_build() {
    // Default build + swap config pinning the mock AMM: init_policy -> InvalidConfig.
    let mut ctx = Ctx::builder(Flavor::Classic)
        .with_swap()
        .relay_build(RelayBuild::Default)
        .no_policy()
        .build();
    let cfg = ctx.cfg.clone();
    ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]).assert_relay_err(relay_err::INVALID_CONFIG);
    // devnet CPMM id is accepted by the default build, mainnet CPMM id is not
    let mut dev = cfg.clone();
    dev.amm_program = CPMM_DEVNET;
    ctx.send_owner(&[ctx.init_policy_ix(&dev, 0)]).assert_ok();
    ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
    let mut main = cfg.clone();
    main.amm_program = CPMM_MAINNET;
    ctx.send_owner(&[ctx.init_policy_ix(&main, 0)]).assert_relay_err(relay_err::INVALID_CONFIG);
}

// =====================================================================================
// RT-15  non-executable AMM program account / wrong program at the AMM slot
// =====================================================================================

#[test]
fn rt15_amm_executable_flag_and_replacement() {
    let mut ctx = Ctx::builder(Flavor::Classic).with_swap().build();
    let mock = MOCK_AMM_ID;
    // (a) key pinned, account no longer executable
    ctx.edit_account(&mock, |a| a.executable = false);
    let before = ledger(&ctx, &swap_keys(&ctx));
    let e = ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]);
    println!("RT-15 non-executable AMM => {}", outcome(&e));
    e.assert_failed();
    assert_eq!(before, ledger(&ctx, &swap_keys(&ctx)));
}

// =====================================================================================
// RT-16  token-2022 shape sweep: every extension on source / destination / mint
// =====================================================================================

#[test]
fn rt16_token2022_extension_sweep() {
    use token::Ext;
    let all = [
        Ext::TransferFeeConfig, Ext::TransferFeeAmount, Ext::MintCloseAuthority,
        Ext::ConfidentialTransferMint, Ext::ConfidentialTransferAccount, Ext::DefaultAccountState,
        Ext::ImmutableOwner, Ext::MemoTransfer, Ext::NonTransferable, Ext::InterestBearingConfig,
        Ext::CpiGuard, Ext::PermanentDelegate, Ext::NonTransferableAccount, Ext::TransferHook,
        Ext::TransferHookAccount, Ext::MetadataPointer, Ext::Pausable, Ext::PausableAccount,
    ];
    let tp = TOKEN22_ID;
    for ext in all {
        let combos = if matches!(ext, Ext::ImmutableOwner) { vec![vec![ext]] } else { vec![vec![ext], vec![Ext::ImmutableOwner, ext]] };
        for combo in combos {
            let only_immutable = combo.iter().all(|e| matches!(e, Ext::ImmutableOwner));
            // (a) destination carries the extension(s)
            let mut ctx = Ctx::builder(Flavor::Token2022).build();
            let d = ctx.recipients[0];
            let acct = TokenAcct::new(tp, ctx.mint, ctx.recipient_owners[0], 0).with_extensions(&combo);
            ctx.place_token(d, acct, "dest_ext");
            let before = ledger(&ctx, &transfer_keys(&ctx));
            let e = ctx.send_agent(&[ctx.transfer_ix(AMT)]);
            let o = outcome(&e);
            assert!(!is_abnormal(&o), "dest ext {combo:?}: {o}");
            if only_immutable {
                e.assert_ok();
            } else {
                e.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
                assert_eq!(before, ledger(&ctx, &transfer_keys(&ctx)));
            }
            // (b) source carries the extension(s)
            let mut ctx = Ctx::builder(Flavor::Token2022).build();
            let s = ctx.source;
            let acct = TokenAcct::new(tp, ctx.mint, ctx.owner.pubkey(), 1_000_000)
                .delegate(ctx.authority, 100_000)
                .with_extensions(&combo);
            ctx.place_token(s, acct, "source_ext");
            let e = ctx.send_agent(&[ctx.transfer_ix(AMT)]);
            let o = outcome(&e);
            assert!(!is_abnormal(&o), "source ext {combo:?}: {o}");
            if only_immutable {
                e.assert_ok();
            } else {
                e.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
            }
            // (c) mint carries the extension(s): padded layout, always rejected
            let mut ctx = Ctx::builder(Flavor::Token2022).build();
            let m = MintAcct::new(tp, 6).supply(1_000_000_000).with_extensions(&combo);
            token::put_mint(&mut ctx.svm, ctx.mint, &m);
            let e = ctx.send_agent(&[ctx.transfer_ix(AMT)]);
            let o = outcome(&e);
            assert!(!is_abnormal(&o), "mint ext {combo:?}: {o}");
            e.assert_relay_err(relay_err::WRONG_PROGRAM);
        }
    }
    println!("RT-16 CONFIRMED: every Token-2022 extension on source/destination/mint is refused; ImmutableOwner-only 170-byte accounts are accepted");
}
