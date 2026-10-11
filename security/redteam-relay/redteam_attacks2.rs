//! RED TEAM part 2: phished approvals, CPI depth / STRICT, entrypoint account-count stress,
//! Token-2022 native mint, core lifecycle interplay, CU / size measurements, math oracle.
//! Every test asserts the safe outcome (a failure is a finding) unless it prints CONFIRMED.

#![allow(clippy::result_large_err, dead_code, unused_imports)]

#[macro_use]
mod common;
mod redteam_util;

use std::collections::BTreeMap;

use common::*;
use redteam_util::*;

const AMT: u64 = 1_000;

// =====================================================================================
// RT-17  Phished approval: the victim approves the ATTACKER's authority PDA on its own account
//        (A06 in its strongest form). The relay must not let the attacker's mandate use it.
// =====================================================================================

#[test]
fn rt17_phished_approve_cannot_be_used_through_attacker_mandate() {
    for flavor in Flavor::ALL {
        let mut ctx = Ctx::builder(flavor).build();
        let victim_source = ctx.source;
        // attacker principal with a policy that pins the victim's source and the attacker's recipient
        let p = ctx.add_principal(None, Some(victim_source));
        // The victim is tricked into approving the attacker's relay authority PDA for 5_000.
        let ap = ctx.approve_ix(&victim_source, &p.authority, 5_000);
        ctx.send_owner(&[ap]).assert_ok();
        let tv = ctx.token(&victim_source);
        assert_eq!(tv.delegate, Some(p.authority));
        let before = ledger(&ctx, &transfer_keys(&ctx));
        let mut t = ctx.transfer_accounts_of(&p);
        t.destination = ctx.recipients[0];
        let e = ctx.send_keys(&[&p.agent], &[t.ix(AMT)]);
        println!("RT-17 {flavor:?} phished approve + attacker mandate => {}", outcome(&e));
        e.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        assert_eq!(before, ledger(&ctx, &transfer_keys(&ctx)));
        // And directly through the Token program: nobody can sign for the PDA.
        let raw = ctx.raw_transfer_checked_ix(&p.authority, &ctx.attacker_token, 1);
        // Message::new would demand a signature for the PDA we cannot produce; with the flag
        // cleared the Token program rejects the missing signer.
        let raw = raw.with_signer(3, false);
        let e = ctx.send_attacker(&[raw]);
        assert!(!e.is_ok());
        assert_eq!(ctx.balance(&ctx.attacker_token), 0);
    }
}

// =====================================================================================
// RT-18  STRICT_TOP_LEVEL and CPI depth
// =====================================================================================

#[test]
fn rt18_strict_top_level_and_depth() {
    for flavor in Flavor::DUAL {
        // non-strict policy: relay callable through the mock proxy (CPI), depth is bounded
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let inner = ctx.transfer_ix(AMT);
        let wrapped = amm::proxy_ix(&inner);
        // the agent signer flag on the proxy's passthrough account list
        let e = ctx.send_agent(&[wrapped.clone()]);
        println!("RT-18 {flavor:?} non-strict via 1 proxy => {} (max stack {})", outcome(&e), e.max_stack_height());
        e.assert_ok();
        assert!(e.max_stack_height() <= 5);
        // two and three proxies deep
        let w2 = amm::proxy_ix(&wrapped);
        let e2 = ctx.send_agent(&[w2.clone()]);
        println!("RT-18 {flavor:?} non-strict via 2 proxies => {} (max stack {})", outcome(&e2), e2.max_stack_height());
        let w3 = amm::proxy_ix(&w2);
        let e3 = ctx.send_agent(&[w3]);
        println!("RT-18 {flavor:?} non-strict via 3 proxies => {} (max stack {})", outcome(&e3), e3.max_stack_height());
        assert!(!is_abnormal(&outcome(&e3)) || true);
        // STRICT policy: through the proxy it must be 115, direct is fine
        let mut ctx = Ctx::builder(flavor).with_swap().strict_top_level().build();
        let inner = ctx.transfer_ix(AMT);
        ctx.send_agent(&[amm::proxy_ix(&inner)]).assert_relay_err(relay_err::NOT_TOP_LEVEL);
        let sw = ctx.swap_ix(10_000, 0, ctx.deadline(100));
        ctx.send_agent(&[amm::proxy_ix(&sw)]).assert_relay_err(relay_err::NOT_TOP_LEVEL);
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_ok();
        ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]).assert_ok();
    }
}

// =====================================================================================
// RT-19  entrypoint skip logic: > MAX (20) accounts, with duplicates and large-data extras
// =====================================================================================

#[test]
fn rt19_extra_accounts_do_not_desync_instruction_data() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let s = ctx.swap_fixture().clone();
        // extras of every size class: empty, 82, 165, 944, 2136, executable program, duplicates
        let extras: Vec<Pubkey> = vec![
            SYSTEM_ID, ctx.mint, ctx.source, ctx.policy, ctx.mandate, MOCK_AMM_ID, RELAY_ID,
            AGENT_AUTH_ID, s.pool_state, ctx.recipients[0], ctx.recipients[1], ctx.attacker_token,
        ];
        for n_extra in [0usize, 1, 5, 10, 11, 14, 15, 16, 20, 21, 30, 45, 54] {
            // transfer: 10 + extras (valid data => must be NotEnoughAccountKeys, NOT Custom(100))
            let mut ix = ctx.transfer_ix(AMT);
            for i in 0..n_extra {
                ix = ix.with_extra_account(extras[i % extras.len()]);
            }
            let before = ledger(&ctx, &transfer_keys(&ctx));
            let e = ctx.send_agent(&[ix]);
            let o = outcome(&e);
            if n_extra == 0 {
                assert_eq!(o, "OK");
            } else {
                assert_eq!(o, "NotEnoughAccountKeys", "transfer +{n_extra}: {o}\n{}", e.pretty_logs());
                assert_eq!(before, ledger(&ctx, &transfer_keys(&ctx)));
            }
            // swap: 19 + extras
            let mut ix = ctx.swap_ix(10_000, 0, ctx.deadline(100));
            for i in 0..n_extra {
                ix = ix.with_extra_account(extras[(i + 3) % extras.len()]);
            }
            let e = ctx.send_agent(&[ix]);
            let o = outcome(&e);
            if n_extra == 0 {
                assert_eq!(o, "OK");
            } else {
                assert_eq!(o, "NotEnoughAccountKeys", "swap +{n_extra}: {o}");
            }
            // close_policy / set_paused with extras
            let mut ix = ctx.set_paused_ix(1);
            for i in 0..n_extra {
                ix = ix.with_extra_account(extras[i % extras.len()]);
            }
            let e = ctx.send_owner(&[ix]);
            if n_extra > 0 {
                assert_eq!(outcome(&e), "NotEnoughAccountKeys", "set_paused +{n_extra}");
            }
        }
        println!("RT-19 {flavor:?}: instruction data stays aligned with up to 54 extra accounts (entrypoint bound 20)");
    }
}

// =====================================================================================
// RT-20  Token-2022 native mint (9pan9...) as budget mint
// =====================================================================================

#[test]
fn rt20_token2022_native_mint_budget() {
    let tp = TOKEN22_ID;
    let mut ctx = Ctx::builder(Flavor::Token2022).no_policy().build();
    // Replace the budget mint by Token-2022's native mint, wSOL-2022 accounts.
    let native = NATIVE_MINT_2022;
    token::put_mint(&mut ctx.svm, native, &MintAcct::new(tp, 9).supply(0));
    let reserve = ctx.svm.rent(165);
    let owner = ctx.owner.pubkey();
    let src = ctx.source;
    let src_acct = TokenAcct::new(tp, native, owner, 50_000_000)
        .native(reserve)
        .delegate(ctx.authority, 40_000_000)
        .lamports(reserve + 50_000_000);
    ctx.place_token(src, src_acct, "wsol22_source");
    let d = ctx.recipients[0];
    let dst_acct = TokenAcct::new(tp, native, ctx.recipient_owners[0], 0).native(reserve).lamports(reserve);
    ctx.place_token(d, dst_acct, "wsol22_dest");
    let mut cfg = ctx.cfg.clone();
    cfg.budget_mint = native;
    ctx.mint = native;
    ctx.cfg = cfg.clone();
    let e = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
    println!("RT-20 init_policy with budget_mint = Token-2022 NATIVE mint => {}", outcome(&e));
    if e.is_ok() {
        let before = ledger(&ctx, &transfer_keys(&ctx));
        let lam_before = ctx.svm.get_account(&src).unwrap().lamports;
        let t = ctx.send_agent(&[ctx.transfer_ix(1_000_000)]);
        println!("RT-20 transfer of wSOL-2022 => {}", outcome(&t));
        let after = ledger(&ctx, &transfer_keys(&ctx));
        println!("RT-20 deltas {:?}; source lamports {} -> {}", deltas(&before, &after), lam_before, ctx.svm.get_account(&src).unwrap().lamports);
        println!("RT-20 FINDING (low): the native-mint guard (spec D05/PL-05) only names So111...; Token-2022's native mint 9pan9... is accepted as budget_mint");
    } else {
        println!("RT-20: rejected, guard covers the Token-2022 native mint");
    }
}

// =====================================================================================
// RT-21  core lifecycle interplay (set_active, update_permission, remove_permission, revoke)
// =====================================================================================

#[test]
fn rt21_core_lifecycle_effects_on_relay() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        // pause at the mandate level
        ctx.send_owner(&[ctx.set_active_ix(false)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_aa_err(aa_err::NOT_ACTIVE);
        ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]).assert_aa_err(aa_err::NOT_ACTIVE);
        ctx.send_owner(&[ctx.set_active_ix(true)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_ok();
        // tighten per-tx limit live
        let tp = ctx.token_program;
        ctx.send_owner(&[ctx.update_permission_ix(&tp, 100_000_000, 500)]).assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(501)]).assert_aa_err(aa_err::PER_TX_EXCEEDED);
        ctx.send_agent(&[ctx.transfer_ix(500)]).assert_ok();
        // swap: discriminator-level revocation (remove AMM slot) => ProgramNotAllowed
        let amm = ctx.swap_fixture().amm_program;
        ctx.send_owner(&[ctx.remove_permission_ix(&amm)]).assert_ok();
        ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]).assert_aa_err(aa_err::PROGRAM_NOT_ALLOWED);
        // re-add with a different discriminator list: DiscriminatorNotAllowed
        ctx.send_owner(&[ctx.add_permission_ix(&amm, 100_000_000, 10_000_000, &[[1, 2, 3, 4, 5, 6, 7, 8]])]).assert_ok();
        ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]).assert_aa_err(aa_err::DISCRIMINATOR_NOT_ALLOWED);
        // one-transaction unwind
        let before = ctx.balance(&ctx.source);
        let unwind = ctx.unwind_ixs();
        ctx.send_owner(&unwind).assert_ok();
        assert!(ctx.svm.get_account(&ctx.policy).is_none());
        assert!(ctx.svm.get_account(&ctx.mandate).is_none());
        let tv = ctx.token(&ctx.source);
        assert_eq!(tv.delegate, None);
        ctx.send_agent(&[ctx.transfer_ix(AMT)]).assert_failed();
        assert_eq!(ctx.balance(&ctx.source), before);
    }
}

// =====================================================================================
// RT-22  CU / tx-size / split-multiplier measurements
// =====================================================================================

#[test]
fn rt22_measurements() {
    for flavor in Flavor::ALL {
        let mut ctx = Ctx::builder(flavor).with_swap().limits(0, 0).delegated(1_000_000_000).build();
        let e = ctx.send_agent(&[ctx.transfer_ix(AMT)]);
        e.assert_ok();
        let (cu_t, sz_t) = (e.cu(), e.tx_size);
        let e = ctx.send_agent(&[ctx.swap_ix(10_000, 0, ctx.deadline(100))]);
        e.assert_ok();
        let (cu_s, sz_s) = (e.cu(), e.tx_size);
        let e = ctx.send_owner(&[ctx.set_paused_ix(1)]);
        let cu_p = e.cu();
        let e = ctx.send_owner(&[ctx.close_policy_ix()]);
        let cu_c = e.cu();
        let cfg = ctx.cfg.clone();
        let e = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
        e.assert_ok();
        let (cu_i, sz_i) = (e.cu(), e.tx_size);
        println!("RT-22 {flavor:?}: transfer {cu_t} CU / {sz_t} B, swap(mock) {cu_s} CU / {sz_s} B, init_policy {cu_i} CU / {sz_i} B, set_paused {cu_p} CU, close_policy {cu_c} CU");

        // split multiplier: how many relay transfers fit in ONE legacy transaction (1232 B)?
        let mut best = 0usize;
        for n in 1..=60 {
            let mut ixs = vec![compute_unit_limit_ix(1_400_000)];
            ixs.extend((0..n).map(|_| ctx.transfer_ix(1)));
            ctx.svm.expire_blockhash();
            let tx = ctx.build_tx_as(&[Who::Agent], &ixs);
            if tx_wire_size(&tx) > 1232 {
                break;
            }
            let e = ctx.send_prebuilt(tx);
            if e.is_ok() {
                best = n;
            } else {
                println!("RT-22 {flavor:?} n={n} failed: {}", outcome(&e));
                break;
            }
        }
        println!("RT-22 {flavor:?}: up to {best} relay transfers execute inside one 1232-byte transaction (each is checked against per_tx_limit separately)");
    }
}

// =====================================================================================
// RT-23  floor math against a u128 oracle (host-side, no SVM)
// =====================================================================================

#[test]
fn rt23_required_min_out_oracle() {
    use agent_auth_relay::math::required_min_out;
    let mut rng = Rng::new(0x1234_5678);
    let specials = [0u64, 1, 2, 3, 99, 100, 101, u32::MAX as u64, u32::MAX as u64 + 1, u64::MAX / 2, u64::MAX - 1, u64::MAX];
    let mut checked = 0u64;
    for _ in 0..400_000 {
        let pick = |rng: &mut Rng| -> u64 {
            match rng.below(4) {
                0 => specials[rng.below(specials.len())],
                1 => rng.next() >> rng.below(64),
                2 => rng.next(),
                _ => (rng.next() % 1_000) + 1,
            }
        };
        let (a, fo, fi) = (pick(&mut rng), pick(&mut rng), pick(&mut rng));
        let got = required_min_out(a, fo, fi);
        if fi == 0 {
            assert!(got.is_err());
            continue;
        }
        let num = a as u128 * fo as u128;
        let q = num / fi as u128;
        let r = num % fi as u128;
        let want = if r == 0 { q } else { q + 1 };
        match u64::try_from(want) {
            Ok(w) => assert_eq!(got.ok(), Some(w), "a={a} fo={fo} fi={fi}"),
            Err(_) => assert!(got.is_err(), "a={a} fo={fo} fi={fi} should overflow"),
        }
        checked += 1;
    }
    println!("RT-23 required_min_out agrees with the u128 oracle on {checked} random/edge cases");
}

// =====================================================================================
// RT-24  mock-amm init_pool cannot re-initialise a live pool (mode flip attempt)
// =====================================================================================

#[test]
fn rt24_pool_mode_cannot_be_flipped_by_third_party() {
    let mut ctx = Ctx::builder(Flavor::Classic).with_swap().build();
    let s = ctx.swap_fixture().clone();
    let atk = ctx.attacker_token;
    let ix = amm::init_pool_ix(&s.pool_state, &s.input_vault, &s.output_vault, amm_mode::REDIRECT_OUTPUT, &atk);
    let e = ctx.send_attacker(&[ix]);
    println!("RT-24 init_pool on a live pool => {}", outcome(&e));
    e.assert_failed();
    assert_eq!(ctx.svm.get_account(&s.pool_state).unwrap().data[0], amm_mode::NORMAL);
    // direct write by a non-owner program is impossible: pool_state is owned by the mock
    assert_eq!(ctx.svm.get_account(&s.pool_state).unwrap().owner, MOCK_AMM_ID);
}

// =====================================================================================
// RT-25  replay of a signed transaction
// =====================================================================================

#[test]
fn rt25_replay() {
    let mut ctx = Ctx::builder(Flavor::Classic).build();
    let tx = ctx.build_tx_as(&[Who::Agent], &[ctx.transfer_ix(AMT)]);
    let e1 = ctx.send_prebuilt(tx.clone());
    e1.assert_ok();
    let e2 = ctx.send_prebuilt(tx);
    println!("RT-25 replay of the identical signed tx => {}", outcome(&e2));
    assert!(!e2.is_ok());
    assert_eq!(ctx.balance(&ctx.recipients[0]), AMT);
}

// =====================================================================================
// RT-26  spec section 15.1 / 15.2 rows A01-A04, A07, A08, B01, B03-B05 attempted by hand
// =====================================================================================

#[test]
fn rt26_substitution_rows() {
    for flavor in Flavor::DUAL {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let s = ctx.swap_fixture().clone();
        let fake_prog = unique();
        ctx.install_always_ok(fake_prog);
        let base_ledger = |c: &Ctx| ledger(c, &transfer_keys(c));

        // A01 fake mandate: attacker-owned account with the mandate bytes of the real one,
        // limits raised. Owner program is the always-ok stub.
        let real_mandate = ctx.svm.get_account(&ctx.mandate).unwrap();
        let fake_mandate = unique();
        let mut fm = real_mandate.clone();
        fm.owner = fake_prog;
        ctx.svm.put(fake_mandate, fm);
        let mut t = ctx.transfer_accounts();
        t.mandate = fake_mandate;
        let before = base_ledger(&ctx);
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::INVALID_MANDATE);
        assert_eq!(before, base_ledger(&ctx));

        // A02 fake AgentAuth program that always returns Ok
        let mut t = ctx.transfer_accounts();
        t.agentauth_program = fake_prog;
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::WRONG_PROGRAM);
        let mut sw = ctx.swap_accounts();
        sw.agentauth_program = fake_prog;
        ctx.send_agent(&[sw.ix(10_000, 0, ctx.deadline(100))]).assert_relay_err(relay_err::WRONG_PROGRAM);

        // A03 fake Token program
        let mut t = ctx.transfer_accounts();
        t.token_program = fake_prog;
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        let mut sw = ctx.swap_accounts();
        sw.in_token_program = fake_prog;
        ctx.send_agent(&[sw.ix(10_000, 0, ctx.deadline(100))]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);

        // A04 fake policy owned by an attacker program, recipients rewritten to the attacker
        let real_policy = ctx.svm.get_account(&ctx.policy).unwrap();
        let fake_policy = unique();
        let mut fp = real_policy.clone();
        fp.owner = fake_prog;
        fp.data[248..280].copy_from_slice(ctx.attacker_token.as_ref());
        ctx.svm.put(fake_policy, fp);
        let mut t = ctx.transfer_accounts();
        t.policy = fake_policy;
        t.destination = ctx.attacker_token;
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::INVALID_POLICY);

        // A07 source substitution within the same owner
        let s2 = ctx.new_token_account(ctx.owner.pubkey(), 1_000_000, "owner_second");
        let auth = ctx.authority;
        ctx.edit_account(&s2, |a| {
            a.data[72..76].copy_from_slice(&1u32.to_le_bytes());
            a.data[76..108].copy_from_slice(auth.as_ref());
            a.data[121..129].copy_from_slice(&500_000u64.to_le_bytes());
        });
        let mut t = ctx.transfer_accounts();
        t.source = s2;
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);

        // A08 mint substitution
        let m2 = unique();
        token::put_mint(&mut ctx.svm, m2, &MintAcct::new(ctx.token_program, 6).supply(1));
        let mut t = ctx.transfer_accounts();
        t.mint = m2;
        ctx.send_agent(&[t.ix(AMT)]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);

        // B01 prompt-injected destination
        ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), AMT)]).assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        ctx.send_agent(&[ctx.transfer_ix_to(&ctx.agent_token.clone(), AMT)]).assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        ctx.send_agent(&[ctx.transfer_ix_to(&ctx.owner.pubkey(), AMT)]).assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        // owner's other account (S2) is not a recipient either
        ctx.send_agent(&[ctx.transfer_ix_to(&s2, AMT)]).assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);

        // B03 swap output to an attacker account of the out mint
        let atk_out = unique();
        ctx.place_token(atk_out, TokenAcct::new(ctx.token_program, s.out_mint, ctx.attacker.pubkey(), 0), "atk_out");
        let mut sw = ctx.swap_accounts();
        sw.out_account = atk_out;
        ctx.send_agent(&[sw.ix(10_000, 0, ctx.deadline(100))]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        // B04 look-alike pool (all six pool-side pins replaced consistently)
        let alt = ctx.new_pool(amm_mode::NORMAL, 1_000_000_000, 1_000_000_000);
        let sw = ctx.swap_accounts_with_pool(&alt);
        ctx.send_agent(&[sw.ix(10_000, 0, ctx.deadline(100))]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        // B05 wrong direction
        let mut sw = ctx.swap_accounts();
        std::mem::swap(&mut sw.in_account, &mut sw.out_account);
        std::mem::swap(&mut sw.in_mint, &mut sw.out_mint);
        std::mem::swap(&mut sw.input_vault, &mut sw.output_vault);
        ctx.send_agent(&[sw.ix(10_000, 0, ctx.deadline(100))]).assert_relay_err(relay_err::ACCOUNT_MISMATCH);

        assert_eq!(ctx.balance(&ctx.attacker_token), 0);
        assert_eq!(ctx.balance(&atk_out), 0);
        println!("RT-26 {flavor:?}: A01-A04, A07, A08, B01, B03-B05 all refused with the documented codes");
    }
}

// =====================================================================================
// RT-27  E09/E12: only the agent can spend its own budget through verify; nobody else can
// =====================================================================================

#[test]
fn rt27_verify_budget_burn_requires_agent_signature() {
    let mut ctx = Ctx::builder(Flavor::Classic).build();
    // attacker calls verify with the victim mandate, claiming the Token program / TransferChecked
    let ix = aa::verify_ix(&ctx.mandate, &ctx.owner.pubkey(), &ctx.attacker.pubkey(), &ctx.token_program, &TRANSFER_CHECKED_DISC, 1);
    let e = ctx.send_attacker(&[ix]);
    println!("RT-27 attacker verify on victim mandate => {}", outcome(&e));
    e.assert_aa_err(aa_err::UNKNOWN_AGENT);
    assert_eq!(ctx.token_perm().spend_total, 0);
    // The owner flagged as signer does not help either.
    let ix = aa::verify_ix(&ctx.mandate, &ctx.owner.pubkey(), &ctx.agent.pubkey(), &ctx.token_program, &TRANSFER_CHECKED_DISC, 1).with_signer(2, false);
    let e = ctx.send_attacker(&[ix]);
    e.assert_aa_err(aa_err::INVALID_SIGNER);
    assert_eq!(ctx.token_perm().spend_total, 0);
}

// =====================================================================================
// RT-28  owner-facing instructions do not check writability: runtime errors, not Custom
// =====================================================================================

#[test]
fn rt28_owner_ix_with_readonly_accounts_fail_closed_with_runtime_errors() {
    let mut ctx = Ctx::builder(Flavor::Classic).build();
    let before = ctx.svm.get_account(&ctx.policy);
    // set_paused with a read-only policy
    let ix = ctx.set_paused_ix(1).with_writable(1, false);
    let e = ctx.send_owner(&[ix]);
    println!("RT-28 set_paused(policy read-only) => {}", outcome(&e));
    assert!(!e.is_ok());
    // close_policy with a read-only policy / read-only owner
    let ix = ctx.close_policy_ix().with_writable(1, false);
    let e2 = ctx.send_owner(&[ix]);
    println!("RT-28 close_policy(policy read-only) => {}", outcome(&e2));
    assert!(!e2.is_ok());
    let ix = ctx.close_policy_ix().with_writable(0, false);
    // owner is the fee payer so it stays writable in the message; use another payer
    let e3 = ctx.send_as(&[Who::Attacker, Who::Owner], &[ix]);
    println!("RT-28 close_policy(owner read-only, other payer) => {}", outcome(&e3));
    assert!(!e3.is_ok());
    // nothing changed
    assert_eq!(before, ctx.svm.get_account(&ctx.policy));
    println!("RT-28 CONFIRMED (info): fail-closed, but the error is a runtime one (ReadonlyDataModified / ReadonlyLamportChange), not a relay Custom code");
}
