//! Self-tests of the `Ctx` fixture, the dual-token macro and the assertion helpers. They run
//! against the real `agent_auth.so` and relay `.so` (hard failure when missing).

use super::*;

// ---------------------------------------------------------------- fixture shape

fn check_fixture(ctx: &Ctx) {
    let me = ctx.mandate_view();
    assert_eq!(me.owner, ctx.owner.pubkey());
    assert_eq!(me.agent, ctx.agent.pubkey());
    assert_eq!(me.expiry, DEFAULT_EXPIRY);
    assert!(me.active);

    // Token slot created through the real add_permission
    let p = ctx.token_perm();
    assert_eq!(p.program, ctx.token_program);
    assert_eq!(p.spend_limit, ctx.spend_limit);
    assert_eq!(p.per_tx_limit, ctx.per_tx_limit);
    assert_eq!(p.discriminators, vec![TRANSFER_CHECKED_DISC]);
    assert_eq!((p.spend_total, p.call_count), (0, 0));

    // source: owned by the owner, delegate = authority PDA, delegated_amount = D
    let s = ctx.token(&ctx.source);
    assert_eq!(s.owner, ctx.owner.pubkey());
    assert_eq!(s.mint, ctx.mint);
    assert_eq!(s.delegate, Some(ctx.authority));
    assert_eq!(s.delegated_amount, ctx.initial_delegated);
    assert_eq!(s.amount, ctx.initial_source_balance);
    assert_eq!(s.state, token::STATE_INITIALIZED);

    // policy created by the real relay init_policy: header + config byte-exact
    let want = ctx.expected_header(ctx.flags).encode_with(&ctx.cfg);
    assert_eq!(ctx.policy_bytes(), want, "policy bytes after init_policy");
    let acct = ctx.svm.get_account(&ctx.policy).unwrap();
    assert_eq!(acct.owner, RELAY_ID);
    assert_eq!(acct.data.len(), policy::POLICY_LEN);
    assert!(acct.lamports >= ctx.svm.rent(policy::POLICY_LEN));

    // PDAs are what ids.rs derives
    assert_eq!(
        ctx.mandate,
        mandate_pda(&ctx.owner.pubkey(), &ctx.agent.pubkey()).0
    );
    assert_eq!(ctx.policy, policy_pda(&ctx.mandate).0);
    assert_eq!(ctx.authority, authority_pda(&ctx.mandate).0);
    assert!(
        ctx.svm.get_account(&ctx.authority).is_none(),
        "authority PDA is never allocated"
    );
    assert_eq!(ctx.recipients.len(), 2);
}

triple_token!(fixture_has_the_documented_shape, |ctx| {
    check_fixture(ctx);
});

#[test]
fn swap_fixture_has_the_documented_shape() {
    let Some(ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    check_fixture(&ctx);
    let s = ctx.swap_fixture();
    // AMM slot with SWAP_DISC
    let p = ctx.perm(&MOCK_AMM_ID);
    assert_eq!(p.discriminators, vec![SWAP_DISC]);
    // policy pins the pool
    let v = ctx.policy_view();
    assert_eq!(v.cfg.swap_enabled, 1);
    assert_eq!(v.cfg.pool_state, s.pool_state);
    assert_eq!(v.cfg.amm_program, MOCK_AMM_ID);
    assert_eq!(v.cfg.amm_authority, amm::pool_authority());
    assert_eq!(v.cfg.floor_out, 95);
    assert_eq!(v.cfg.floor_in, 100);
    // pool state and vaults
    let pool = PoolState::decode(&ctx.svm.data(&s.pool_state));
    assert_eq!(pool.mode, amm_mode::NORMAL);
    assert_eq!(
        (pool.vault_0, pool.vault_1),
        (s.input_vault, s.output_vault)
    );
    assert_eq!(ctx.token(&s.input_vault).owner, amm::pool_authority());
    assert_eq!(ctx.token(&s.output_vault).mint, s.out_mint);
    // in_account delegated to the authority, out_account is the owner's own
    assert_eq!(ctx.token(&s.in_account).delegate, Some(ctx.authority));
    assert_eq!(ctx.token(&s.out_account).owner, ctx.owner.pubkey());
}

#[test]
fn in_is_source_shares_the_source_account() {
    let Some(ctx) = Ctx::builder(Flavor::PToken)
        .swap_with(|o| o.in_is_source = true)
        .try_build()
    else {
        return;
    };
    assert_eq!(ctx.swap_fixture().in_account, ctx.source);
    assert_eq!(ctx.policy_view().cfg.in_account, ctx.source);
    assert_eq!(
        ctx.unwind_ixs().len(),
        3,
        "one Revoke when in_account == source"
    );
}

// ---------------------------------------------------------------- the macro, both forms

dual_token!(macro_runs_the_body_on_both_binaries, |ctx| {
    // the flavour inside the body is the flavour under test
    assert!(matches!(ctx.flavor, Flavor::Classic | Flavor::PToken));
    assert_eq!(ctx.token_program, TOKEN_ID);
});

dual_token!(
    macro_with_builder_customisation,
    with | b | b.limits(500, 100).recipients(3).delegated(777),
    |ctx| {
        assert_eq!(ctx.token_perm().per_tx_limit, 100);
        assert_eq!(ctx.recipients.len(), 3);
        assert_eq!(ctx.token(&ctx.source).delegated_amount, 777);
    }
);

// ---------------------------------------------------------------- transfer smoke (relay alive)

dual_token!(transfer_smoke_moves_exactly_the_amount, |ctx| {
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    r.assert_ok();
    eprintln!(
        "transfer CU {} tx size {} ({})",
        r.cu(),
        r.tx_size,
        ctx.flavor.name()
    );
    assert_eq!(
        ctx.balance(&ctx.source),
        before.token(&ctx.source).amount - 1_000
    );
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000);
    assert_eq!(
        ctx.token(&ctx.source).delegated_amount,
        ctx.initial_delegated - 1_000
    );
    let p = ctx.token_perm();
    assert_eq!((p.spend_total, p.call_count), (1_000, 1));
    // event 1 decodes
    let evs = r.events();
    assert_eq!(
        evs,
        vec![RelayEvent::TransferExecuted {
            mandate: ctx.mandate,
            destination: ctx.recipients[0],
            mint: ctx.mint,
            amount: 1_000
        }]
    );
    // the relay's CPIs: verify then TransferChecked, nothing else (INV-01 already ran in send_*)
    let cpis = r.relay_cpis();
    assert_eq!(cpis.len(), 2);
    assert_eq!(cpis[0].program, AGENT_AUTH_ID);
    assert_eq!(cpis[1].program, ctx.token_program);
    assert!(r.max_stack_height() == 2);
});

// ---------------------------------------------------------------- error attribution

dual_token!(error_attribution_names_the_raising_program, |ctx| {
    // relay error
    let r = ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), 10)]);
    assert_relay_err(&r.result, relay_err::RECIPIENT_NOT_ALLOWED);
    // AgentAuth error raised inside the relay's verify CPI (callee logs first)
    let per_tx = ctx.per_tx_limit;
    let r = ctx.send_agent(&[ctx.transfer_ix(per_tx + 1)]);
    r.assert_aa_err(aa_err::PER_TX_EXCEEDED);
    // Token error raised inside the relay's TransferChecked CPI: amount above the balance
    // but within delegated / per_tx / lifetime limits
    let s = ctx.source;
    let empty_it = ctx.new_token_account(ctx.owner.pubkey(), 0, "dust");
    let _ = empty_it;
    let mut acct = ctx.token(&s);
    acct.amount = 5; // balance 5, delegated still large
    let data = TokenAcct::new(ctx.token_program, ctx.mint, ctx.owner.pubkey(), 5)
        .delegate(ctx.authority, ctx.initial_delegated)
        .data();
    let lamports = ctx.svm.rent(165);
    ctx.svm.put(
        s,
        solana_account::Account {
            lamports,
            data,
            owner: ctx.token_program,
            executable: false,
            rent_epoch: 0,
        },
    );
    let r = ctx.send_agent(&[ctx.transfer_ix(6)]);
    r.assert_token_err(&ctx.token_program, token_err::INSUFFICIENT_FUNDS);
});

#[test]
#[should_panic(expected = "was raised by")]
fn assert_err_rejects_the_right_code_from_the_wrong_program() {
    let Some(mut ctx) = Ctx::try_new(Flavor::Classic) else {
        // skipping: satisfy should_panic
        panic!("was raised by (skipped)");
    };
    let r = ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), 10)]);
    // 104 was raised by the relay, not by AgentAuth
    assert_err(&r.result, &AGENT_AUTH_ID, relay_err::RECIPIENT_NOT_ALLOWED);
}

#[test]
#[should_panic(expected = "SUCCEEDED")]
fn assert_err_rejects_success() {
    let Some(mut ctx) = Ctx::try_new(Flavor::Classic) else {
        panic!("SUCCEEDED (skipped)");
    };
    let r = ctx.send_agent(&[ctx.transfer_ix(10)]);
    assert_relay_err(&r.result, relay_err::PAUSED);
}

dual_token!(agent_cannot_move_funds_with_its_own_key, |ctx| {
    // DL-01 shape: raw TransferChecked signed by the agent -> Token OwnerMismatch
    let dest = ctx.attacker_token;
    let before = ctx.snapshot();
    let ix = ctx.raw_transfer_checked_ix(&ctx.agent.pubkey(), &dest, 5);
    let r = ctx.send_agent(&[ix]);
    r.assert_token_err(&ctx.token_program, token_err::OWNER_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// ---------------------------------------------------------------- snapshots

dual_token!(snapshot_detects_a_real_move, |ctx| {
    let before = ctx.snapshot();
    let ix = ctx.raw_transfer_checked_ix(&ctx.owner.pubkey(), &ctx.recipients[0].clone(), 3);
    ctx.send_owner(&[ix]).assert_ok();
    let after = ctx.snapshot();
    let outcome = std::panic::catch_unwind(|| assert_nothing_moved(&before, &after));
    let msg = *outcome
        .expect_err("a moved balance must be detected")
        .downcast::<String>()
        .expect("string panic");
    assert!(msg.contains("source"), "message names the account: {msg}");
    assert!(
        msg.contains("recipient0"),
        "message names the account: {msg}"
    );
});

dual_token!(snapshot_is_equal_after_a_rejected_transaction, |ctx| {
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix_to(&ctx.attacker_token.clone(), 10)])
        .assert_relay_err(relay_err::RECIPIENT_NOT_ALLOWED);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// ---------------------------------------------------------------- sizes

#[test]
fn transaction_sizes_are_measured() {
    let Some(mut ctx) = Ctx::builder(Flavor::PToken).with_swap().try_build() else {
        return;
    };
    let t = ctx.send_agent(&[ctx.transfer_ix(1)]);
    t.assert_ok();
    let s = ctx.send_agent(&[ctx.swap_ix_default(1_000)]);
    let unwind = ctx.build_tx_as(&[Who::Owner], &ctx.unwind_ixs());
    let unwind_size = tx_wire_size(&unwind);
    eprintln!(
        "tx sizes: transfer {} B, swap {} B (ok={}), unwind {} B",
        t.tx_size,
        s.tx_size,
        s.is_ok(),
        unwind_size
    );
    // FE-01 gates
    assert!(t.tx_size <= 520, "transfer tx {} B", t.tx_size);
    assert!(s.tx_size <= 900, "swap tx {} B", s.tx_size);
    assert!(unwind_size <= 450, "unwind tx {} B", unwind_size);
    assert!(t.tx_size <= 1232 && s.tx_size <= 1232);
}

// ---------------------------------------------------------------- second principal, clock, unwind

dual_token!(second_principal_has_its_own_working_stack, |ctx| {
    let p = ctx.add_principal(None, None);
    let ix = ctx.transfer_accounts_of(&p).ix(7);
    let r = ctx.send_keys(&[&p.agent], &[ix]);
    r.assert_ok();
    assert_eq!(ctx.balance(&p.source), ctx.initial_source_balance - 7);
    assert_eq!(ctx.balance(&ctx.recipients[0]), 7);
    // the main principal is untouched
    assert_eq!(ctx.balance(&ctx.source), ctx.initial_source_balance);
    assert_eq!(ctx.token_perm().call_count, 0);
});

dual_token!(unwind_in_one_transaction_stops_the_agent, |ctx| {
    ctx.send_agent(&[ctx.transfer_ix(10)]).assert_ok();
    let ixs = ctx.unwind_ixs();
    let r = ctx.send_owner(&ixs);
    r.assert_ok();
    assert_eq!(ctx.token(&ctx.source).delegate, None);
    assert!(ctx
        .svm
        .get_account(&ctx.mandate)
        .is_none_or(|a| a.lamports == 0 || a.data.iter().all(|b| *b == 0)));
    assert!(ctx.svm.get_account(&ctx.policy).is_none(), "policy closed");
    ctx.send_agent(&[ctx.transfer_ix(10)])
        .assert_relay_err(relay_err::INVALID_POLICY);
});

#[test]
fn clock_helpers_move_the_slot() {
    let Some(mut ctx) = Ctx::try_new(Flavor::Classic) else {
        return;
    };
    assert_eq!(ctx.slot(), 0);
    ctx.warp_to_slot(1_234);
    assert_eq!(ctx.slot(), 1_234);
    ctx.set_unix_time(1_700_000_000);
    assert_eq!(ctx.slot(), 1_234, "set_unix_time keeps the slot");
    assert_eq!(ctx.deadline(10), 1_244);
}

// ---------------------------------------------------------------- corruption helpers on a live tx

dual_token!(one_field_corruption_changes_exactly_that_outcome, |ctx| {
    let evil = ctx.attacker_token;
    // wrong mint account
    let r = ctx.send_agent(&[ctx.transfer_ix(1).with_account(transfer_idx::MINT, evil)]);
    r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
    // too few / too many accounts
    let r = ctx.send_agent(&[ctx.transfer_ix(1).truncate_accounts(9)]);
    r.assert_not_enough_accounts();
    let r = ctx.send_agent(&[ctx.transfer_ix(1).with_extra_account(evil)]);
    r.assert_not_enough_accounts();
    // unsigned agent with another fee payer -> 107
    let ix = ctx.transfer_ix(1).with_signer(transfer_idx::AGENT, false);
    let r = ctx.send_as(&[Who::Attacker], &[ix]);
    r.assert_relay_err(relay_err::AGENT_NOT_SIGNER);
    // zero amount
    let r = ctx.send_agent(&[ctx.transfer_ix(0)]);
    r.assert_relay_err(relay_err::INVALID_INSTRUCTION_DATA);
});

// ---------------------------------------------------------------- pause / replay

dual_token!(set_paused_and_replay_helpers, |ctx| {
    ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
    assert!(ctx.policy_view().paused());
    ctx.send_agent(&[ctx.transfer_ix(1)])
        .assert_relay_err(relay_err::PAUSED);
    ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
    // identical prebuilt transaction submitted twice: the second is rejected
    let tx = ctx.build_tx_as(&[Who::Agent], &[ctx.transfer_ix(1)]);
    ctx.send_prebuilt(tx.clone()).assert_ok();
    let again = ctx.send_prebuilt(tx);
    assert!(!again.is_ok(), "a replayed transaction must be rejected");
});

// ---------------------------------------------------------------- loader policy

#[test]
fn a_missing_so_is_a_hard_failure_unless_skipping_is_allowed() {
    assert!(svm::so_path("AA_TEST_NO_SUCH_ENV_VAR").is_err());
    if svm::skip_allowed() {
        assert!(svm::require_so("AA_TEST_NO_SUCH_ENV_VAR").is_none());
        return;
    }
    let outcome = std::panic::catch_unwind(|| svm::require_so("AA_TEST_NO_SUCH_ENV_VAR"));
    let msg = *outcome
        .expect_err("a missing .so must panic")
        .downcast::<String>()
        .expect("string panic");
    assert!(msg.contains("AA_TEST_NO_SUCH_ENV_VAR"), "{msg}");
    assert!(msg.contains("AGENT_AUTH_ALLOW_SKIP"), "{msg}");
}

// ---------------------------------------------------------------- fake programs (TR-13, TR-14)

dual_token!(fake_programs_are_rejected_before_any_cpi, |ctx| {
    let fake = unique();
    ctx.install_always_ok(fake);
    let before = ctx.snapshot();
    // TR-13: fake AgentAuth program that always returns Ok
    let ix = ctx
        .transfer_ix(10)
        .with_account(transfer_idx::AGENTAUTH_PROGRAM, fake);
    ctx.send_agent(&[ix])
        .assert_relay_err(relay_err::WRONG_PROGRAM);
    // TR-14: fake Token program that "succeeds" without moving funds
    let ix = ctx
        .transfer_ix(10)
        .with_account(transfer_idx::TOKEN_PROGRAM, fake);
    ctx.send_agent(&[ix])
        .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// ---------------------------------------------------------------- invalid config tables (PL-05)

#[test]
fn every_invalid_config_row_is_rejected_with_113_and_creates_nothing() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic)
        .with_swap()
        .no_policy()
        .try_build()
    else {
        return;
    };
    let base = ctx.cfg.clone();
    let mut rows = invalid_config_rows(&base);
    rows.extend(header_alias_rows(
        &base,
        &ctx.mandate,
        &ctx.policy,
        &ctx.authority,
        &ctx.owner.pubkey(),
        &ctx.agent.pubkey(),
    ));
    assert!(rows.len() >= 50, "{} rows", rows.len());
    let mut names = std::collections::BTreeSet::new();
    for row in &rows {
        assert!(names.insert(row.name), "duplicate row name {}", row.name);
        let r = ctx.send_owner(&[ctx.init_policy_ix(&row.cfg, row.flags)]);
        assert!(!r.is_ok(), "row `{}` was ACCEPTED by init_policy", row.name);
        if assert::custom_code(&r.result) != Some(relay_err::INVALID_CONFIG) {
            panic!(
                "row `{}`: expected relay 113, got {:?}\n{}",
                row.name,
                r.result.as_ref().err().map(|e| &e.err),
                r.pretty_logs()
            );
        }
        assert!(
            ctx.svm.get_account(&ctx.policy).is_none(),
            "row `{}` left a policy account behind",
            row.name
        );
    }
    // and the valid base is accepted afterwards (nothing was poisoned)
    let ix = ctx.init_policy_ix(&base, 0);
    ctx.send_owner(&[ix]).assert_ok();
    assert_eq!(
        ctx.policy_bytes(),
        ctx.expected_header(0).encode_with(&base)
    );
}

// ---------------------------------------------------------------- raw edits

dual_token!(raw_edit_helpers_drive_the_core_failure_paths, |ctx| {
    // inactive mandate: AgentAuth NotActive (4) raised inside verify
    ctx.set_mandate_active_raw(false);
    ctx.send_agent(&[ctx.transfer_ix(1)])
        .assert_aa_err(aa_err::NOT_ACTIVE);
    ctx.set_mandate_active_raw(true);
    // expiry changed behind the policy's back: stale-policy guard (118)
    ctx.set_mandate_expiry_raw(DEFAULT_EXPIRY + 1);
    ctx.send_agent(&[ctx.transfer_ix(1)])
        .assert_relay_err(relay_err::STALE_POLICY);
    ctx.set_mandate_expiry_raw(DEFAULT_EXPIRY);
    // the clock past the expiry: AgentAuth Expired (5)
    ctx.set_unix_time(DEFAULT_EXPIRY + 1);
    ctx.send_agent(&[ctx.transfer_ix(1)])
        .assert_aa_err(aa_err::EXPIRED);
    ctx.set_unix_time(0);
    ctx.send_agent(&[ctx.transfer_ix(1)]).assert_ok();
});

// ---------------------------------------------------------------- extra pool

#[test]
fn a_consistent_look_alike_pool_is_rejected_by_the_pins() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    let alt = ctx.new_pool(amm_mode::NORMAL, 1_000_000_000, 1_000_000_000);
    let before = ctx.snapshot();
    let ix = ctx
        .swap_accounts_with_pool(&alt)
        .ix(1_000, 0, ctx.deadline(10));
    ctx.send_agent(&[ix])
        .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
}

#[test]
fn every_swap_pin_replacement_is_rejected_with_102() {
    let Some(mut ctx) = Ctx::builder(Flavor::PToken).with_swap().try_build() else {
        return;
    };
    let before = ctx.snapshot();
    for (name, idx) in SWAP_PIN_TABLE {
        let ix = ctx
            .swap_ix(1_000, 0, ctx.deadline(10))
            .with_account(idx, unique());
        let r = ctx.send_agent(&[ix]);
        assert!(!r.is_ok(), "pin `{name}` replaced but the swap succeeded");
        assert_eq!(
            assert::custom_code(&r.result),
            Some(relay_err::ACCOUNT_MISMATCH),
            "pin `{name}`\n{}",
            r.pretty_logs()
        );
    }
    assert_nothing_moved(&before, &ctx.snapshot());
}

#[test]
fn pool_modes_can_be_flipped_on_the_pinned_pool() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    ctx.set_pool_mode(amm_mode::PULL_EXTRA);
    let before = ctx.snapshot();
    // RE-01: the pool pulls one unit too many -> relay 106, nothing moved
    ctx.send_agent(&[ctx.swap_ix(1_000_000, 0, ctx.deadline(10))])
        .assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    assert_nothing_moved(&before, &ctx.snapshot());
    ctx.set_pool_mode(amm_mode::NOOP_OK);
    // RE-07: Ok but nothing delivered -> 112
    ctx.send_agent(&[ctx.swap_ix(1_000_000, 0, ctx.deadline(10))])
        .assert_relay_err(relay_err::SLIPPAGE_FLOOR_VIOLATED);
}

// ---------------------------------------------------------------- relay builds

#[test]
fn production_relay_build_rejects_the_mock_amm_but_test_amm_build_accepts_it() {
    // default features: only Raydium CPMM ids are allowlisted (PL-04 / SW-04)
    let Some(mut ctx) = Ctx::builder(Flavor::Classic)
        .with_swap()
        .relay_build(RelayBuild::Default)
        .no_policy()
        .try_build()
    else {
        return;
    };
    let cfg = ctx.cfg.clone();
    assert_eq!(cfg.amm_program, MOCK_AMM_ID);
    ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)])
        .assert_relay_err(relay_err::INVALID_CONFIG);
    assert!(ctx.svm.get_account(&ctx.policy).is_none());
    // a transfer-only policy is fine on the production build
    let mut only = cfg.clone();
    only.swap_enabled = 0;
    for f in [
        &mut only.amm_program,
        &mut only.amm_authority,
        &mut only.amm_config,
        &mut only.pool_state,
        &mut only.input_vault,
        &mut only.output_vault,
        &mut only.observation_state,
        &mut only.in_mint,
        &mut only.out_mint,
        &mut only.in_token_program,
        &mut only.out_token_program,
        &mut only.in_account,
        &mut only.out_account,
    ] {
        *f = Pubkey::default();
    }
    only.floor_in = 0;
    only.floor_out = 0;
    only.max_deadline_slots = 0;
    ctx.send_owner(&[ctx.init_policy_ix(&only, 0)]).assert_ok();
}
