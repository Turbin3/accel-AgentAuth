//! TEST-MATRIX areas DL (delegation and raw SPL semantics: the agent key holds nothing) and the
//! CORE-* rows that concern the relay's use of the AgentAuth core (not the core fixes themselves).
//!
//! Core behaviour in these tests is taken from the core source (RELAY-SPEC: "if this document and
//! the core source disagree about core behaviour, the core source wins"). Where a matrix row and
//! the core disagree the test asserts the core and the row is listed in the build report.

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use agent_auth_relay::state as rs;

#[track_caller]
fn agent_relay_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_relay_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

#[track_caller]
fn agent_aa_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_aa_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

// =============================================================================================
// DL: the agent key holds nothing
// =============================================================================================

dual_token!(dl_01_agent_raw_transfer_checked_is_refused, |ctx| {
    let before = ctx.snapshot();
    let agent = ctx.agent.pubkey();
    let tp = ctx.token_program;
    let ix = ctx.raw_transfer_checked_ix(&agent, &ctx.attacker_token.clone(), 1_000);
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    // the agent is not the delegate either (the delegate is the relay's PDA)
    let ix = ctx.raw_transfer_checked_ix(&agent, &ctx.agent_token.clone(), 1);
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.balance(&ctx.attacker_token), 0);
});

dual_token!(dl_02_agent_raw_approve_is_refused, |ctx| {
    let before = ctx.snapshot();
    let tp = ctx.token_program;
    let ix = token::spl_approve(
        &tp,
        &ctx.source,
        &ctx.attacker.pubkey(),
        &ctx.agent.pubkey(),
        1_000_000,
    );
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    // the agent approving itself
    let ix = token::spl_approve(
        &tp,
        &ctx.source,
        &ctx.agent.pubkey(),
        &ctx.agent.pubkey(),
        1_000_000,
    );
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(
        ctx.token(&ctx.source).delegate,
        Some(ctx.authority),
        "delegate untouched"
    );
});

dual_token!(dl_03_agent_raw_set_authority_is_refused, |ctx| {
    let before = ctx.snapshot();
    let tp = ctx.token_program;
    let atk = ctx.attacker.pubkey();
    for ty in [token::AUTH_ACCOUNT_OWNER, token::AUTH_CLOSE_ACCOUNT] {
        let ix = token::spl_set_authority(&tp, &ctx.source, &ctx.agent.pubkey(), ty, Some(&atk));
        ctx.send_agent(&[ix])
            .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    }
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.token(&ctx.source).owner, ctx.owner.pubkey());
});

dual_token!(dl_04_agent_raw_close_account_is_refused, |ctx| {
    let tp = ctx.token_program;
    let empty = ctx.new_token_account(ctx.owner.pubkey(), 0, "empty_owner_account");
    let before = ctx.snapshot();
    let agent = ctx.agent.pubkey();
    let ix = token::spl_close_account(&tp, &empty, &agent, &agent);
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert!(ctx.svm.get_account(&empty).is_some());
});

dual_token!(dl_05_owner_misapproved_the_agent_key, |ctx| {
    // owner error: the AGENT key was approved as delegate instead of the authority PDA
    let agent = ctx.agent.pubkey();
    let acct = TokenAcct::new(
        ctx.token_program,
        ctx.mint,
        ctx.owner.pubkey(),
        ctx.initial_source_balance,
    )
    .delegate(agent, ctx.initial_delegated);
    ctx.place_token(ctx.source, acct, "source");
    // the relay refuses (delegate != authority) ...
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    // ... but the agent can then use the delegation directly: documented owner error, which is
    // why the SDK must never emit it.
    let ix = ctx.raw_transfer_checked_ix(&agent, &ctx.attacker_token.clone(), 5_000);
    ctx.send_agent(&[ix]).assert_ok();
    assert_eq!(ctx.balance(&ctx.attacker_token), 5_000);
});

dual_token!(dl_06_agent_raw_revoke_and_burn_are_refused, |ctx| {
    let before = ctx.snapshot();
    let tp = ctx.token_program;
    let agent = ctx.agent.pubkey();
    let ix = token::spl_revoke(&tp, &ctx.source, &agent);
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    let ix = token::spl_burn(&tp, &ctx.source, &ctx.mint, &agent, 1);
    ctx.send_agent(&[ix])
        .assert_token_err(&tp, token_err::OWNER_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.token(&ctx.source).delegate, Some(ctx.authority));
});

dual_token!(dl_07_second_mandates_authority_replaces_the_first, |ctx| {
    // same owner, second agent, SAME source account (L5: one SPL delegate per token account)
    let second = ctx.add_principal(Some(ctx.owner.insecure_clone()), Some(ctx.source));
    // both mandates have a working policy; only the delegate decides. Today the delegate is the first.
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    let before = ctx.snapshot();
    let ix = ctx.transfer_accounts_of(&second).ix(1_000);
    ctx.send_keys(&[&second.agent], &[ix])
        .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
    assert_nothing_moved(&before, &ctx.snapshot());

    // the owner approves the second authority on the same S (overwrites the delegate)
    let ix = ctx.approve_ix(&ctx.source.clone(), &second.authority, 40_000_000);
    ctx.send_owner(&[ix]).assert_ok();
    assert_eq!(ctx.token(&ctx.source).delegate, Some(second.authority));

    // first mandate's transfers now fail closed ...
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    // ... and the second mandate's succeed
    let ix = ctx.transfer_accounts_of(&second).ix(2_000);
    ctx.send_keys(&[&second.agent], &[ix]).assert_ok();
    let s = ctx.token(&ctx.source);
    assert_eq!(s.delegated_amount, 40_000_000 - 2_000);
    assert_eq!(s.amount, ctx.initial_source_balance - 1_000 - 2_000);
});

// =============================================================================================
// CORE rows concerning the relay
// =============================================================================================

// CORE-05: the agent calls `verify` directly with arbitrary amounts.
dual_token!(core_05_agent_calls_verify_directly, |ctx| {
    let before = ctx.snapshot();
    let ix = aa::verify_ix(
        &ctx.mandate,
        &ctx.owner.pubkey(),
        &ctx.agent.pubkey(),
        &ctx.token_program.clone(),
        &TRANSFER_CHECKED_DISC,
        7_000,
    );
    ctx.send_agent(&[ix]).assert_ok();
    // only its own counters changed
    let p = ctx.token_perm();
    assert_eq!((p.spend_total, p.call_count), (7_000, 1));
    let after = ctx.snapshot();
    for k in [
        ctx.source,
        ctx.recipients[0],
        ctx.recipients[1],
        ctx.attacker_token,
        ctx.agent_token,
    ] {
        assert_eq!(before.get(&k), after.get(&k), "token account {k} untouched");
    }
    assert_eq!(before.get(&ctx.policy), after.get(&ctx.policy));
    assert_eq!(
        ctx.token(&ctx.source).delegated_amount,
        ctx.initial_delegated
    );
});

// CORE-06: AgentAuth errors surface unchanged through the relay.
dual_token!(core_06_expired_mandate, |ctx| {
    ctx.set_unix_time(DEFAULT_EXPIRY + 1);
    agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::EXPIRED);
});

dual_token!(core_06_inactive_mandate_seeded, |ctx| {
    ctx.set_mandate_active_raw(false);
    agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::NOT_ACTIVE);
    // and through the real instruction
    ctx.set_mandate_active_raw(true);
    ctx.send_owner(&[ctx.set_active_ix(false)]).assert_ok();
    agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::NOT_ACTIVE);
    ctx.send_owner(&[ctx.set_active_ix(true)]).assert_ok();
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
});

dual_token!(
    core_06_no_token_slot,
    with | b | b.no_token_permission(),
    |ctx| {
        agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::PROGRAM_NOT_ALLOWED);
    }
);

dual_token!(
    core_06_slot_without_transfer_checked,
    with | b | b.token_discs(&[[3, 0, 0, 0, 0, 0, 0, 0]]),
    |ctx| {
        agent_aa_err(
            ctx,
            ctx.transfer_ix(1_000),
            aa_err::DISCRIMINATOR_NOT_ALLOWED,
        );
    }
);

// CORE-07: removing the Token slot kills transfers, the AMM slot keeps swaps alive.
dual_token!(
    core_07_remove_token_permission_keeps_swap,
    with | b | b.with_swap(),
    |ctx| {
        let tp = ctx.token_program;
        ctx.send_owner(&[ctx.remove_permission_ix(&tp)]).assert_ok();
        agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::PROGRAM_NOT_ALLOWED);
        ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 1_000);
    }
);

// CORE-08: remove then re-add Token with another discriminator: TransferChecked is DiscriminatorNotAllowed.
dual_token!(core_08_readd_token_with_other_discriminator, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, 1_000);
    let tp = ctx.token_program;
    ctx.send_owner(&[
        ctx.remove_permission_ix(&tp),
        ctx.add_permission_ix(&tp, 100_000_000, 10_000_000, &[[3, 0, 0, 0, 0, 0, 0, 0]]),
    ])
    .assert_ok();
    let p = ctx.token_perm();
    assert_eq!(
        (p.spend_total, p.call_count),
        (0, 0),
        "counters of the new slot are zero"
    );
    assert_eq!(p.discriminators, vec![[3, 0, 0, 0, 0, 0, 0, 0]]);
    agent_aa_err(
        ctx,
        ctx.transfer_ix(1_000),
        aa_err::DISCRIMINATOR_NOT_ALLOWED,
    );
});

// CORE-09: revoke_mandate, then transfer.
dual_token!(core_09_revoke_then_transfer, |ctx| {
    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
    assert!(
        ctx.svm.get_account(&ctx.mandate).is_none(),
        "hardened core really closes the mandate"
    );
    // (a) policy still present
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::INVALID_MANDATE);
    // (b) policy closed
    ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(1_000)])
        .assert_relay_err(relay_err::INVALID_POLICY);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// CORE-10: revoke, re-create with a different expiry, old policy present.
dual_token!(core_10_recreated_mandate_with_new_expiry_is_stale, |ctx| {
    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
    let tp = ctx.token_program;
    ctx.send_owner(&[
        ctx.create_mandate_ix(DEFAULT_EXPIRY + 12_345),
        ctx.add_permission_ix(&tp, 100_000_000, 10_000_000, &[TRANSFER_CHECKED_DISC]),
    ])
    .assert_ok();
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::STALE_POLICY);
});

// CORE-11: re-create with the SAME expiry re-binds the old policy (documented limitation L8).
dual_token!(core_11_recreated_mandate_with_same_expiry_rebinds, |ctx| {
    let tp = ctx.token_program;
    let recreate = |ctx: &Ctx| {
        vec![
            ctx.create_mandate_ix(ctx.expiry),
            ctx.add_permission_ix(&tp, 100_000_000, 10_000_000, &[TRANSFER_CHECKED_DISC]),
        ]
    };
    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
    let ixs = recreate(ctx);
    ctx.send_owner(&ixs).assert_ok();
    // L8: old policy + old delegation + same expiry: the new mandate is bound again
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, 1_000);

    // with the policy closed first the agent fails closed
    ctx.send_owner(&[ctx.revoke_mandate_ix(), ctx.close_policy_ix()])
        .assert_ok();
    let ixs = recreate(ctx);
    ctx.send_owner(&ixs).assert_ok();
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(1_000)])
        .assert_relay_err(relay_err::INVALID_POLICY);
    assert_nothing_moved(&before, &ctx.snapshot());
});

/// CORE-12: the relay's mandate constants equal the core crate's (also covered in conformance.rs).
#[test]
fn core_12_relay_constants_equal_core_constants() {
    assert_eq!(rs::MANDATE_OFF_DISC, agent_auth::OFF_DISC);
    assert_eq!(rs::MANDATE_OFF_OWNER, agent_auth::OFF_OWNER);
    assert_eq!(rs::MANDATE_OFF_AGENT, agent_auth::OFF_AGENT);
    assert_eq!(rs::MANDATE_OFF_EXPIRY, agent_auth::OFF_EXPIRY);
    assert_eq!(rs::MANDATE_OFF_ACTIVE, agent_auth::OFF_ACTIVE);
    assert_eq!(rs::MANDATE_LEN, agent_auth::ACCOUNT_SIZE);
    assert_eq!(rs::MANDATE_DISC, agent_auth::MANDATE_DISCRIMINATOR);
    assert_eq!(agent_auth_relay::ids::AGENT_AUTH_ID, agent_auth::ID);
}

/// CORE-13: a full mandate (16 permissions, Token in slot 15, TransferChecked in discriminator
/// position 8) transfers within the CU gate (classic <= 15,000; p-token <= 8,000).
#[test]
fn core_13_full_mandate_transfer_within_cu_gate() {
    for (flavor, gate) in [(Flavor::Classic, 15_000u64), (Flavor::PToken, 8_000)] {
        let Some(mut ctx) = Ctx::builder(flavor).no_token_permission().try_build() else {
            return;
        };
        // 15 filler slots (unique program ids) in three transactions
        for chunk in 0..3 {
            let ixs: Vec<Instruction> = (0..5)
                .map(|_| ctx.add_permission_ix(&unique(), 1_000, 10, &[[9, 0, 0, 0, 0, 0, 0, 0]]))
                .collect();
            ctx.send_owner(&ixs).assert_ok();
            let _ = chunk;
        }
        // slot 15: Token with 8 discriminators, TransferChecked LAST (position 8)
        let mut discs: Vec<[u8; 8]> = (1..8u8).map(|i| [i + 20, 0, 0, 0, 0, 0, 0, 0]).collect();
        discs.push(TRANSFER_CHECKED_DISC);
        assert_eq!(discs.len(), 8);
        let tp = ctx.token_program;
        let ix = ctx.add_permission_ix(&tp, 100_000_000, 10_000_000, &discs);
        ctx.send_owner(&[ix]).assert_ok();
        let m = ctx.mandate_view();
        assert_eq!(m.permissions.len(), 16, "full mandate");
        assert_eq!(m.permissions[15].program, tp, "target is in slot 15");
        assert_eq!(m.permissions[15].discriminators[7], TRANSFER_CHECKED_DISC);

        let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
        r.assert_ok();
        let cu = r.cu();
        eprintln!(
            "CORE-13 {} transfer CU with a full 16-slot mandate: {cu}",
            flavor.name()
        );
        assert!(cu <= gate, "{}: {cu} CU > gate {gate}", flavor.name());
        assert_eq!(ctx.token_perm().spend_total, 1_000);
    }
}

// CORE-14: remove + add of the same program resets the counters (documented).
dual_token!(core_14_remove_then_add_resets_counters, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(3_000)]).assert_ok();
    ctx.send_agent(&[ctx.transfer_ix(4_000)]).assert_ok();
    let p = ctx.token_perm();
    assert_eq!((p.spend_total, p.call_count), (7_000, 2));
    let tp = ctx.token_program;
    ctx.send_owner(&[
        ctx.remove_permission_ix(&tp),
        ctx.add_permission_ix(
            &tp,
            ctx.spend_limit,
            ctx.per_tx_limit,
            &[TRANSFER_CHECKED_DISC],
        ),
    ])
    .assert_ok();
    let p = ctx.token_perm();
    assert_eq!((p.spend_total, p.call_count), (0, 0), "counters reset");
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, 1_000);
});

// CORE-15: expiry boundary. The core treats `now >= expiry` as expired (`Mandate::is_expired`),
// so the last valid instant is `expiry - 1`. The matrix row says "ok at expiry"; the core source
// wins and this is listed in the build report.
dual_token!(core_15_clock_at_expiry_boundary, |ctx| {
    ctx.set_unix_time(DEFAULT_EXPIRY - 1);
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    ctx.set_unix_time(DEFAULT_EXPIRY);
    agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::EXPIRED);
    ctx.set_unix_time(DEFAULT_EXPIRY + 1);
    agent_aa_err(ctx, ctx.transfer_ix(1_000), aa_err::EXPIRED);
    // moving the clock back un-expires it (nothing was written by the failures)
    ctx.set_unix_time(DEFAULT_EXPIRY - 1);
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, 2_000);
});
