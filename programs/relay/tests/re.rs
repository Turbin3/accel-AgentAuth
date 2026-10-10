//! Test engineer B: RE rows (malicious pinned AMM, mock-amm modes 1-12) and the evil-token rows
//! (TR-31, TR-32, AR-06, RE-13).
//!
//! Every failure asserts the exact error AND the program that raised it, and that nothing moved:
//! all token balances, delegations, mandate counters, pool state and the policy are byte-identical
//! to the snapshot taken before the transaction (TEST-MATRIX harness rule 3).

#![allow(deprecated)] // InstructionError::NotEnoughAccountKeys is what the runtime still reports

#[macro_use]
mod common;
mod support_b;

use common::*;
use solana_transaction::InstructionError;
use support_b::measure;

const AMOUNT: u64 = 1_000_000;

fn moved_nothing(ctx: &Ctx, before: &Snapshot) {
    assert_nothing_moved(before, &ctx.snapshot());
}

/// BURN_CPU: the mock AMM spins until its compute meter is exhausted. The runtime reports the
/// transaction as `ProgramFailedToComplete` and the AMM's own log line is
/// `failed: exceeded CUs meter at BPF instruction` (TEST-MATRIX RE-12 names
/// `ComputationalBudgetExceeded`; that variant is for syscall metering, the VM meter ends here).
#[track_caller]
fn assert_cu_exhausted(r: &Exec) {
    r.assert_instruction_error(InstructionError::ProgramFailedToComplete);
    let amm_died = parse_failures(r.logs())
        .iter()
        .any(|f| f.program == MOCK_AMM_ID && f.detail.starts_with("exceeded CUs meter"));
    assert!(
        amm_died,
        "the mock AMM must be the program that ran out of CUs\n{}",
        r.pretty_logs()
    );
}

/// Run one swap on a fixture whose pool is in `mode` and return the result with the pre-state.
fn run_mode(ctx: &mut Ctx, amount: u64) -> (Exec, Snapshot) {
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.swap_ix(amount, 0, ctx.deadline(100))]);
    (r, before)
}

// =====================================================================================
// RE-01 .. RE-08: callee misbehaviour that the relay's own post-conditions catch
// =====================================================================================

dual_token!(
    re01_pull_extra_is_106,
    with | b | b.swap_with(|o| o.mode = amm_mode::PULL_EXTRA),
    |ctx| {
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    re02_burn_in_cannot_reach_the_burn_at_all,
    with | b | b.swap_with(|o| o.mode = amm_mode::BURN_IN),
    |ctx| {
        // SPEC DEVIATION (recorded in the report): TEST-MATRIX RE-02 expects relay 106. The relay
        // passes the mints to the AMM READ-ONLY, and a Token `Burn` needs the mint writable, so the
        // runtime stops the CPI with PrivilegeEscalation before the Token program or the relay's
        // post-check can run. The security property (no burn, nothing moves) holds, one layer earlier.
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_instruction_error(InstructionError::PrivilegeEscalation);
        moved_nothing(ctx, &before);
        let s = ctx.swap_fixture();
        assert_eq!(
            ctx.balance(&s.in_account),
            1_000_000_000,
            "no unit was burned"
        );
    }
);

dual_token!(
    re03_approve_attacker_is_refused_by_the_token_program,
    with | b | b.swap_with(|o| o.mode = amm_mode::APPROVE_ATTACKER),
    |ctx| {
        let tp = ctx.token_program;
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_token_err(&tp, token_err::OWNER_MISMATCH);
        moved_nothing(ctx, &before);
        let s = ctx.swap_fixture().clone();
        let v = ctx.token(&s.in_account);
        assert_eq!(
            v.delegate,
            Some(ctx.authority),
            "the delegate is still the authority PDA"
        );
        assert_eq!(v.delegated_amount, 100_000_000);
    }
);

dual_token!(
    re04_set_authority_is_refused_by_the_token_program,
    with | b | b.swap_with(|o| o.mode = amm_mode::SET_AUTH),
    |ctx| {
        let tp = ctx.token_program;
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_token_err(&tp, token_err::OWNER_MISMATCH);
        moved_nothing(ctx, &before);
        let s = ctx.swap_fixture().clone();
        assert_eq!(ctx.token(&s.in_account).owner, ctx.owner.pubkey());
    }
);

dual_token!(
    re05_close_account_is_refused_by_the_token_program,
    with | b | b.swap_with(|o| o.mode = amm_mode::CLOSE_ACCOUNT),
    |ctx| {
        let tp = ctx.token_program;
        let (r, before) = run_mode(ctx, AMOUNT);
        // The Token program refuses to close a non-empty account (NonNativeHasBalance = 11) before it
        // even looks at the authority; either way it is the Token program that stops it.
        r.assert_token_err(&tp, 11);
        moved_nothing(ctx, &before);
        let s = ctx.swap_fixture().clone();
        assert!(
            ctx.svm.get_account(&s.in_account).is_some(),
            "the account still exists"
        );
    }
);

dual_token!(
    re05_close_account_of_an_empty_input_is_still_not_closable_by_the_pda,
    with | b
        | b.swap_with(|o| {
            o.mode = amm_mode::CLOSE_ACCOUNT;
            o.in_balance = AMOUNT; // the swap drains the account to exactly 0 before the close attempt
            o.in_delegated = AMOUNT;
        }),
    |ctx| {
        let tp = ctx.token_program;
        let (r, before) = run_mode(ctx, AMOUNT);
        // balance is 0 now, so the close reaches the authority check: delegates cannot close
        r.assert_token_err(&tp, token_err::OWNER_MISMATCH);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    re06_redirect_output_is_stopped_by_the_token_program,
    with | b | b.swap_with(|o| o.mode = amm_mode::REDIRECT_OUTPUT),
    |ctx| {
        // SPEC DEVIATION (recorded in the report): TEST-MATRIX RE-06 expects relay 112. The mock pays
        // the OUTPUT mint into `in_account`, which holds the INPUT mint (in_mint != out_mint is a
        // policy rule), so the Token program rejects the transfer with MintMismatch (3) and the relay
        // post-check is never reached. Redirecting the output is impossible, which is the property.
        let tp = ctx.token_program;
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_token_err(&tp, token_err::MINT_MISMATCH);
        moved_nothing(ctx, &before);
    }
);

dual_token!(
    re07_noop_ok_is_112,
    with | b | b.swap_with(|o| o.mode = amm_mode::NOOP_OK),
    |ctx| {
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_relay_err(relay_err::SLIPPAGE_FLOOR_VIOLATED);
        moved_nothing(ctx, &before);
        // the mandate was NOT charged: verify's bookkeeping reverted with the transaction
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 0);
    }
);

dual_token!(
    re08_underpay_is_112,
    with | b | b.swap_with(|o| o.mode = amm_mode::UNDERPAY),
    |ctx| {
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_relay_err(relay_err::SLIPPAGE_FLOOR_VIOLATED);
        moved_nothing(ctx, &before);
    }
);

// =====================================================================================
// RE-09 .. RE-12
// =====================================================================================

dual_token!(
    re09_reentering_the_relay_fails_and_nothing_moves,
    with | b | b.swap_with(|o| o.mode = amm_mode::REENTER_RELAY),
    |ctx| {
        let (r, before) = run_mode(ctx, AMOUNT);
        assert!(!r.is_ok(), "A -> B -> A must not succeed");
        let err = format!("{:?}", r.result.as_ref().err().map(|f| &f.err));
        measure("re09 error of the re-entry attempt", &err);
        // Cause is the runtime's (ReentrancyNotAllowed) or a missing program account, never a relay
        // success; it must not be a relay balance/floor error either (the callee never got that far).
        assert!(
            !err.contains("Custom(106)")
                && !err.contains("Custom(112)")
                && !err.contains("Custom(119)"),
            "{err}"
        );
        moved_nothing(ctx, &before);
        assert_eq!(ctx.perm(&MOCK_AMM_ID).call_count, 0);
    }
);

dual_token!(
    re10_callee_verify_with_the_mandate_fails_and_counters_stay,
    with | b | b.swap_with(|o| o.mode = amm_mode::CPI_VERIFY),
    |ctx| {
        // aim the callee at the real mandate; the relay gives it neither the owner nor the agent
        let mandate = ctx.mandate;
        ctx.set_pool(|p| p.aux_key = mandate);
        let (r, before) = run_mode(ctx, AMOUNT);
        r.assert_instruction_error(InstructionError::NotEnoughAccountKeys);
        moved_nothing(ctx, &before);
        // the agent key was never handed to the AMM (INV-01, enforced by the Ctx audit as well)
        for c in r
            .inner_calls()
            .iter()
            .filter(|c| c.program != AGENT_AUTH_ID)
        {
            assert!(
                !c.accounts.contains(&ctx.agent.pubkey()),
                "the agent key reached {}",
                common::assert::program_name(&c.program)
            );
        }
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, 0);
    }
);

dual_token!(
    re11_consistent_lookalike_pool_is_102,
    with | b | b.with_swap(),
    |ctx| {
        for mode in [amm_mode::NORMAL, amm_mode::NOOP_OK, amm_mode::PULL_EXTRA] {
            let alt = ctx.new_pool(mode, 1_000_000_000, 1_000_000_000);
            let ix = ctx
                .swap_accounts_with_pool(&alt)
                .ix(AMOUNT, 0, ctx.deadline(100));
            let before = ctx.snapshot();
            ctx.send_agent(&[ix])
                .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
            moved_nothing(ctx, &before);
        }
    }
);

dual_token!(
    re12_burn_cpu_exhausts_the_budget_and_nothing_moves,
    with | b | b.swap_with(|o| o.mode = amm_mode::BURN_CPU),
    |ctx| {
        let (r, before) = run_mode(ctx, AMOUNT);
        assert_cu_exhausted(&r);
        moved_nothing(ctx, &before);
        // the failure is bounded by the agent's own compute limit: with the maximum limit it still ends
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[
            compute_unit_limit_ix(1_400_000),
            ctx.swap_ix(AMOUNT, 0, ctx.deadline(100)),
        ]);
        assert_cu_exhausted(&r);
        moved_nothing(ctx, &before);
    }
);

// =====================================================================================
// All 13 modes through the relay, three token binaries: nothing moves unless the swap is honest
// =====================================================================================

triple_token!(re_all_modes_table, with | b | b.with_swap(), |ctx| {
    // (mode, expected outcome) as observed through the relay. Ok = the swap legitimately lands.
    #[derive(Debug)]
    enum Want {
        Ok,
        Relay(u32),
        Token(u32),
        Instr(InstructionError),
        CuExhausted,
        AnyFailure,
    }
    let table: Vec<(u8, Want)> = vec![
        (amm_mode::NORMAL, Want::Ok),
        (
            amm_mode::PULL_EXTRA,
            Want::Relay(relay_err::BALANCE_DELTA_VIOLATION),
        ),
        (
            amm_mode::BURN_IN,
            Want::Instr(InstructionError::PrivilegeEscalation),
        ),
        (
            amm_mode::APPROVE_ATTACKER,
            Want::Token(token_err::OWNER_MISMATCH),
        ),
        (amm_mode::SET_AUTH, Want::Token(token_err::OWNER_MISMATCH)),
        (amm_mode::CLOSE_ACCOUNT, Want::Token(11)),
        (
            amm_mode::REDIRECT_OUTPUT,
            Want::Token(token_err::MINT_MISMATCH),
        ),
        (amm_mode::REENTER_RELAY, Want::AnyFailure),
        (
            amm_mode::CPI_VERIFY,
            Want::Instr(InstructionError::NotEnoughAccountKeys),
        ),
        (
            amm_mode::NOOP_OK,
            Want::Relay(relay_err::SLIPPAGE_FLOOR_VIOLATED),
        ),
        (
            amm_mode::UNDERPAY,
            Want::Relay(relay_err::SLIPPAGE_FLOOR_VIOLATED),
        ),
        // PULL_LESS at the normal price: the floor (priced on amount_in) refuses it
        (amm_mode::PULL_LESS, Want::AnyFailure),
        (amm_mode::BURN_CPU, Want::CuExhausted),
    ];
    assert_eq!(
        table.len(),
        usize::from(amm_mode::COUNT),
        "every mock mode must be in the table"
    );
    let tp = ctx.token_program;
    for (mode, want) in table {
        ctx.set_pool_mode(mode);
        if mode == amm_mode::CPI_VERIFY {
            let mandate = ctx.mandate;
            ctx.set_pool(|p| p.aux_key = mandate);
        }
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.swap_ix(AMOUNT, 0, ctx.deadline(100))]);
        let label = format!("mode {mode}");
        match want {
            Want::Ok => {
                assert!(r.is_ok(), "{label}\n{}", r.pretty_logs());
                continue;
            }
            Want::Relay(c) => {
                assert!(!r.is_ok(), "{label}");
                r.assert_relay_err(c);
            }
            Want::Token(c) => {
                assert!(!r.is_ok(), "{label}");
                r.assert_token_err(&tp, c);
            }
            Want::Instr(e) => {
                assert!(!r.is_ok(), "{label}");
                r.assert_instruction_error(e);
            }
            Want::CuExhausted => {
                assert!(!r.is_ok(), "{label}");
                assert_cu_exhausted(&r);
            }
            Want::AnyFailure => assert!(!r.is_ok(), "{label}"),
        }
        moved_nothing(ctx, &before);
    }
});

// =====================================================================================
// evil-token: a Token program that lies (installed at the Token program id)
// =====================================================================================

/// A transfer-only fixture whose Token program is the evil stub, mode `mode` on the budget mint.
fn evil_transfer_ctx(mode: u8) -> Option<Ctx> {
    let mut ctx = Ctx::builder(Flavor::Classic).try_build()?;
    if !ctx.install_evil_token() {
        return None;
    }
    let mint = ctx.mint;
    ctx.edit_account(&mint, |a| a.data[81] = mode);
    Some(ctx)
}

#[test]
fn evil_token_honest_mode_behaves_like_the_real_token_program() {
    let Some(mut ctx) = evil_transfer_ctx(token::evil::HONEST) else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    r.assert_ok();
    assert_eq!(
        ctx.balance(&ctx.source),
        before.token(&ctx.source).amount - 1_000
    );
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000);
    assert_eq!(ctx.token(&ctx.source).delegated_amount, 100_000_000 - 1_000);
    // honest stub exhausts the delegation exactly like the real program
    let d = ctx.token(&ctx.source).delegated_amount;
    ctx.send_agent(&[ctx.transfer_ix(d.min(10_000_000))])
        .assert_ok();
    // and refuses a stranger like the real program (Token OwnerMismatch)
    let stranger = ctx.attacker.pubkey();
    let raw = ctx.raw_transfer_checked_ix(&stranger, &ctx.attacker_token, 1);
    ctx.send_attacker(&[raw])
        .assert_token_err(&TOKEN_ID, token_err::OWNER_MISMATCH);
}

#[test]
fn tr31_token_moving_amount_plus_one_is_106() {
    let Some(mut ctx) = evil_transfer_ctx(token::evil::MOVE_PLUS_ONE) else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    r.assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    moved_nothing(&ctx, &before);
    assert_eq!(
        ctx.perm(&TOKEN_ID).spend_total,
        0,
        "verify bookkeeping reverted"
    );
}

#[test]
fn tr32_token_crediting_amount_minus_one_is_106() {
    let Some(mut ctx) = evil_transfer_ctx(token::evil::CREDIT_MINUS_ONE) else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    r.assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    moved_nothing(&ctx, &before);
}

#[test]
fn ar06_token_raising_the_source_balance_during_the_cpi_never_wraps() {
    let Some(mut ctx) = evil_transfer_ctx(token::evil::RAISE_SOURCE) else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    // source ends higher than it started: `src_before - src_after` underflows in the relay's
    // checked arithmetic, which RELAY-SPEC 7.4 step 17 maps to 114 (not a wrapped huge debit).
    r.assert_relay_err(relay_err::ARITHMETIC_OVERFLOW);
    moved_nothing(&ctx, &before);
}

// ---- the same stub on the swap path (RE-13)

fn evil_swap_ctx(in_mode: u8, out_mode: u8, tune: impl FnOnce(&mut SwapOpts)) -> Option<Ctx> {
    let mut ctx = Ctx::builder(Flavor::Classic).swap_with(tune).try_build()?;
    if !ctx.install_evil_token() {
        return None;
    }
    let (in_mint, out_mint) = (ctx.mint, ctx.swap_fixture().out_mint);
    ctx.edit_account(&in_mint, |a| a.data[81] = in_mode);
    ctx.edit_account(&out_mint, |a| a.data[81] = out_mode);
    Some(ctx)
}

#[test]
fn re13_honest_stub_swap_succeeds() {
    let Some(mut ctx) = evil_swap_ctx(token::evil::HONEST, token::evil::HONEST, |_| {}) else {
        return;
    };
    ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]).assert_ok();
}

#[test]
fn re13_token_rewriting_the_close_authority_of_in_account_is_119() {
    let Some(mut ctx) = evil_swap_ctx(token::evil::REWRITE_CLOSE_AUTH, token::evil::HONEST, |_| {})
    else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    r.assert_relay_err(relay_err::ACCOUNT_INVARIANT_VIOLATED);
    moved_nothing(&ctx, &before);
    assert_eq!(
        ctx.token(&ctx.swap_fixture().in_account).close_authority,
        None
    );
}

#[test]
fn re13_token_rewriting_the_close_authority_of_out_account_is_119() {
    let Some(mut ctx) = evil_swap_ctx(token::evil::HONEST, token::evil::REWRITE_CLOSE_AUTH, |_| {})
    else {
        return;
    };
    // the output transfer's SOURCE is the vault, so the stub rewrites the vault, not out_account:
    // nothing owner-side changed and the swap succeeds. Documented so nobody mistakes it for a gap.
    let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    r.assert_ok();
    let s = ctx.swap_fixture().clone();
    assert_eq!(ctx.token(&s.out_account).close_authority, None);
    assert!(
        ctx.token(&s.output_vault).close_authority.is_some(),
        "only the pool vault was touched"
    );
}

#[test]
fn re13_token_debiting_one_extra_unit_in_a_swap_is_106() {
    let Some(mut ctx) = evil_swap_ctx(token::evil::MOVE_PLUS_ONE, token::evil::HONEST, |_| {})
    else {
        return;
    };
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
        .assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    moved_nothing(&ctx, &before);
}

#[test]
fn re13_token_raising_in_account_during_a_swap_is_106() {
    let Some(mut ctx) = evil_swap_ctx(token::evil::RAISE_SOURCE, token::evil::HONEST, |_| {})
    else {
        return;
    };
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
        .assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    moved_nothing(&ctx, &before);
}

#[test]
fn re13_token_crediting_one_unit_less_than_the_floor_is_112() {
    // pool tuned so the honest output equals the floor exactly; the stub credits one unit less
    let ro = {
        let (ain, ri, target) = (1_000_000u64, 1_000_000_000u64, 950_000u64);
        let den = u128::from(ri) + u128::from(ain);
        u64::try_from((u128::from(target) * den).div_ceil(u128::from(ain))).unwrap()
    };
    let Some(mut ctx) = evil_swap_ctx(token::evil::HONEST, token::evil::CREDIT_MINUS_ONE, |o| {
        o.reserve_in = 1_000_000_000;
        o.reserve_out = ro;
    }) else {
        return;
    };
    assert_eq!(ctx.expected_amount_out(AMOUNT), 950_000);
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)])
        .assert_relay_err(relay_err::SLIPPAGE_FLOOR_VIOLATED);
    moved_nothing(&ctx, &before);
}
