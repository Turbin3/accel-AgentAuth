//! TEST-MATRIX area UW: revocation and unwind. Each kill switch alone stops the agent, the
//! single-transaction unwind stops everything and returns every rent lamport, pause is reversible
//! and dust sent to the relay's accounts changes no behaviour.

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use common::policy::off;

#[track_caller]
fn agent_relay_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_relay_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// Fee of a one-signature transaction, measured.
fn fee_one_signature(ctx: &mut Ctx) -> u64 {
    let before = ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap();
    let ix = system_transfer_ix(&ctx.owner.pubkey(), &unique(), 1_000_000);
    ctx.send_owner(&[ix]).assert_ok();
    before - ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap() - 1_000_000
}

fn lamports(ctx: &Ctx, k: &Pubkey) -> u64 {
    ctx.svm.get_account(k).map_or(0, |a| a.lamports)
}

// UW-01 revoke_mandate only
dual_token!(uw_01_revoke_mandate_only, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::INVALID_MANDATE);
    // the delegation and the policy are untouched (only the mandate went)
    assert_eq!(ctx.token(&ctx.source).delegate, Some(ctx.authority));
    assert!(ctx.svm.get_account(&ctx.policy).is_some());
});

// UW-02 Token.Revoke only
dual_token!(uw_02_token_revoke_only, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    ctx.send_owner(&[ctx.revoke_delegate_ix(&ctx.source.clone())])
        .assert_ok();
    assert_eq!(ctx.token(&ctx.source).delegate, None);
    assert_eq!(ctx.token(&ctx.source).delegated_amount, 0);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    // mandate and policy are intact
    assert!(ctx.mandate_view().active);
    assert!(ctx.svm.get_account(&ctx.policy).is_some());
});

// UW-03 close_policy only
dual_token!(uw_03_close_policy_only, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::INVALID_POLICY);
    assert_eq!(ctx.token(&ctx.source).delegate, Some(ctx.authority));
    assert!(ctx.mandate_view().active);
});

// UW-04 single-transaction unwind
dual_token!(uw_04_single_transaction_unwind, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(2_000)]).assert_ok();
    let fee = fee_one_signature(ctx);
    let (mandate_l, policy_l) = (lamports(ctx, &ctx.mandate), lamports(ctx, &ctx.policy));
    assert!(mandate_l > 0 && policy_l > 0);
    let owner_l = lamports(ctx, &ctx.owner.pubkey());
    let source_before = ctx.token(&ctx.source);

    let ixs = ctx.unwind_ixs();
    assert_eq!(
        ixs.len(),
        3,
        "[Token.Revoke, AgentAuth.revoke_mandate, relay.close_policy]"
    );
    assert_eq!(ixs[0].program_id, ctx.token_program);
    assert_eq!(ixs[1].program_id, AGENT_AUTH_ID);
    assert_eq!(ixs[2].program_id, RELAY_ID);
    let r = ctx.send_owner(&ixs);
    r.assert_ok();
    eprintln!("UW-04 unwind transaction: {} bytes", r.tx_size);
    assert!(r.tx_size <= 1232, "unwind tx is {} bytes", r.tx_size);

    // all three effects
    let s = ctx.token(&ctx.source);
    assert_eq!(
        (s.delegate, s.delegated_amount),
        (None, 0),
        "delegation revoked"
    );
    assert!(
        ctx.svm.get_account(&ctx.mandate).is_none(),
        "mandate closed"
    );
    assert!(ctx.svm.get_account(&ctx.policy).is_none(), "policy closed");
    // owner's tokens are intact
    assert_eq!(s.amount, source_before.amount);
    assert_eq!(s.owner, ctx.owner.pubkey());
    // rent of mandate and policy returned exactly
    assert_eq!(
        lamports(ctx, &ctx.owner.pubkey()),
        owner_l + mandate_l + policy_l - fee,
        "exact rent returned (minus the one-signature fee)"
    );
    // the agent now fails closed at the first check
    let snap = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(1_000)])
        .assert_relay_err(relay_err::INVALID_POLICY);
    assert_nothing_moved(&snap, &ctx.snapshot());
});

// UW-05 agent transaction before the unwind, then after (the documented race)
dual_token!(uw_05_agent_before_and_after_unwind, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    let moved = ctx.initial_source_balance - ctx.balance(&ctx.source);
    assert_eq!(moved, 1_000);
    let ixs = ctx.unwind_ixs();
    ctx.send_owner(&ixs).assert_ok();
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(1_000)])
        .assert_relay_err(relay_err::INVALID_POLICY);
    assert_nothing_moved(&before, &ctx.snapshot());
    // only the pre-unwind amount ever left the source
    assert_eq!(ctx.initial_source_balance - ctx.balance(&ctx.source), 1_000);
});

// UW-06 unwind with a separate swap input account (two Revokes)
dual_token!(
    uw_06_unwind_with_swap_input_account,
    with | b | b.with_swap(),
    |ctx| {
        let in_account = ctx.swap_fixture().in_account;
        assert_ne!(in_account, ctx.source);
        ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
        let ixs = ctx.unwind_ixs();
        assert_eq!(ixs.len(), 4, "two Revokes + revoke_mandate + close_policy");
        let r = ctx.send_owner(&ixs);
        r.assert_ok();
        eprintln!(
            "UW-06 unwind transaction with two Revokes: {} bytes",
            r.tx_size
        );
        assert!(r.tx_size <= 1232);
        for k in [ctx.source, in_account] {
            let t = ctx.token(&k);
            assert_eq!((t.delegate, t.delegated_amount), (None, 0), "{k} revoked");
        }
        assert!(ctx.svm.get_account(&ctx.mandate).is_none());
        assert!(ctx.svm.get_account(&ctx.policy).is_none());
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix_default(1_000)])
            .assert_relay_err(relay_err::INVALID_POLICY);
        ctx.send_agent(&[ctx.transfer_ix(1_000)])
            .assert_relay_err(relay_err::INVALID_POLICY);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
);

// UW-07 pause then unpause changes nothing but the flags byte
dual_token!(uw_07_pause_then_unpause, with | b | b.with_swap(), |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
    let s0 = ctx.snapshot();
    let policy0 = ctx.policy_bytes();

    ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
    let s1 = ctx.snapshot();
    let policy1 = ctx.policy_bytes();
    // only the policy account changed, and only the flags byte
    for (k, a) in &s0.accounts {
        if *k != ctx.policy {
            assert_eq!(a, &s1.accounts[k], "{k} changed by set_paused");
        }
    }
    let diffs: Vec<usize> = (0..policy0.len())
        .filter(|&i| policy0[i] != policy1[i])
        .collect();
    assert_eq!(diffs, vec![off::FLAGS]);
    assert_eq!((policy0[off::FLAGS], policy1[off::FLAGS]), (0, FLAG_PAUSED));

    ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
    assert_nothing_moved(&s0, &ctx.snapshot());
    assert_eq!(ctx.policy_bytes(), policy0);
    // pausing twice / unpausing twice is idempotent
    ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
    assert_eq!(ctx.policy_bytes(), policy0);
});

// UW-08 lamports and dust tokens sent to the authority PDA, the policy and the source
dual_token!(
    uw_08_dust_changes_no_behaviour,
    with | b | b.with_swap(),
    |ctx| {
        let policy0 = ctx.policy_bytes();
        // lamports to the (never allocated) authority PDA, the policy and the source token account
        // (the never-allocated authority PDA needs at least the rent of an empty account to exist)
        let dust = ctx.svm.rent(0) + 12_345;
        for k in [ctx.authority, ctx.policy, ctx.source, ctx.mandate] {
            let ix = system_transfer_ix(&ctx.attacker.pubkey(), &k, dust);
            ctx.send_attacker(&[ix]).assert_ok();
        }
        assert_eq!(
            ctx.policy_bytes(),
            policy0,
            "policy bytes unchanged by a lamport top-up"
        );
        // dust tokens into the source and a recipient
        let (s, r0) = (ctx.source, ctx.recipients[0]);
        let (sb, rb) = (ctx.balance(&s), ctx.balance(&r0));
        ctx.set_token_amount(&s, sb + 5);
        ctx.set_token_amount(&r0, rb + 7);

        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
        assert_eq!(ctx.balance(&s), sb + 5 - 1_000);
        assert_eq!(ctx.balance(&r0), rb + 7 + 1_000);
        assert_eq!(ctx.token_perm().spend_total, 1_000);
        ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 1_000);
        // failures still fail the same way
        let snap = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), 1)])
            .assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
        assert_nothing_moved(&snap, &ctx.snapshot());
        let _ = before;
        // the unwind still returns the rent (the extra lamports ride along with the closed accounts)
        let fee = fee_one_signature(ctx);
        let owner_l = lamports(ctx, &ctx.owner.pubkey());
        let (ml, pl) = (lamports(ctx, &ctx.mandate), lamports(ctx, &ctx.policy));
        assert!(ml > 0 && pl > 0);
        let ixs = ctx.unwind_ixs();
        ctx.send_owner(&ixs).assert_ok();
        assert_eq!(lamports(ctx, &ctx.owner.pubkey()), owner_l + ml + pl - fee);
    }
);
