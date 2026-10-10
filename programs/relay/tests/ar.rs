//! TEST-MATRIX area AR: arithmetic, replay and splitting.

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use agent_auth::{HEADER_SIZE, PERMISSION_SIZE, P_SPEND_TOTAL};
use agent_auth_relay::error::RelayError;
use agent_auth_relay::math::{effective_min_out, required_min_out};
use solana_transaction::TransactionError;

#[track_caller]
fn agent_aa_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_aa_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// Overwrite `spend_total` of permission slot `idx` directly in the mandate bytes.
fn seed_spend_total(ctx: &mut Ctx, idx: usize, total: u64) {
    let m = ctx.mandate;
    ctx.edit_account(&m, |a| {
        let o = HEADER_SIZE + idx * PERMISSION_SIZE + P_SPEND_TOTAL;
        a.data[o..o + 8].copy_from_slice(&total.to_le_bytes());
    });
}

// ---------------------------------------------------------------------------------------------
// AR-01 lifetime counter near u64::MAX
//
// The matrix row says AgentAuth Custom(13) (ArithmeticOverflow). The hardened core never returns
// 13 from `verify`: on a LIMITED permission `spend_total + amount` that overflows is simply over
// the limit (SpendLimitExceeded = 9), on an UNLIMITED permission the counters saturate (see the
// doc comment of `verify`). Core source wins (RELAY-SPEC header), so this test asserts the core's
// behaviour; the property that matters (no wrap-around, nothing moves) is the same.
// ---------------------------------------------------------------------------------------------

dual_token!(ar_01_counter_near_u64_max_limited_permission, |ctx| {
    seed_spend_total(ctx, 0, u64::MAX - 5);
    assert_eq!(ctx.token_perm().spend_total, u64::MAX - 5);
    agent_aa_err(ctx, ctx.transfer_ix(10), aa_err::SPEND_LIMIT_EXCEEDED);
    assert_eq!(ctx.token_perm().spend_total, u64::MAX - 5, "no wrap");
});

dual_token!(
    ar_01_counter_near_u64_max_unlimited_permission,
    with | b | b.limits(0, 0),
    |ctx| {
        seed_spend_total(ctx, 0, u64::MAX - 5);
        let src_before = ctx.balance(&ctx.source);
        ctx.send_agent(&[ctx.transfer_ix(10)]).assert_ok();
        // saturates instead of wrapping to a small number
        assert_eq!(ctx.token_perm().spend_total, u64::MAX);
        assert_eq!(ctx.balance(&ctx.source), src_before - 10);
        // and again: still saturated, never an overflow error, never a wrap
        ctx.send_agent(&[ctx.transfer_ix(10)]).assert_ok();
        assert_eq!(ctx.token_perm().spend_total, u64::MAX);
        assert_eq!(ctx.token_perm().call_count, 2);
    }
);

// ---------------------------------------------------------------------------------------------
// AR-02 floor math with u64::MAX operands (unit) and through the program
// ---------------------------------------------------------------------------------------------

#[test]
fn ar_02_floor_math_u64_max_operands() {
    let m = u64::MAX;
    assert_eq!(required_min_out(m, 1, 1), Ok(m));
    assert_eq!(required_min_out(m, m, m), Ok(m));
    assert_eq!(
        required_min_out(m, m, 1),
        Err(RelayError::ArithmeticOverflow)
    );
    assert_eq!(
        required_min_out(m, 2, 1),
        Err(RelayError::ArithmeticOverflow)
    );
    assert_eq!(required_min_out(1, m, 1), Ok(m));
    assert_eq!(
        required_min_out(2, m, 1),
        Err(RelayError::ArithmeticOverflow)
    );
    assert_eq!(
        required_min_out(1, 1, 0),
        Err(RelayError::ArithmeticOverflow)
    );
    assert_eq!(required_min_out(0, m, 1), Ok(0));
    assert_eq!(required_min_out(m, 1, m), Ok(1));
    assert_eq!(
        required_min_out(m, 1, 2),
        Ok(1 << 63),
        "ceil((2^64-1)/2) = 2^63"
    );
    assert_eq!(effective_min_out(m, 7, 1, 1), Ok(m));
    assert_eq!(
        effective_min_out(10, 1_000, 1, 1),
        Ok(1_000),
        "agent min_out above the floor wins"
    );
    assert_eq!(
        effective_min_out(10, 1, 1, 1),
        Ok(10),
        "floor wins over a lazy min_out"
    );
    assert_eq!(
        effective_min_out(m, 0, m, 1),
        Err(RelayError::ArithmeticOverflow)
    );
    assert_eq!(RelayError::ArithmeticOverflow.code(), 114);
    // against an independent u128 reference over boundary values and a deterministic PRNG
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let edges = [
        0u64,
        1,
        2,
        3,
        99,
        100,
        101,
        1 << 32,
        (1 << 32) - 1,
        (1 << 63) - 1,
        1 << 63,
        m - 1,
        m,
    ];
    let mut cases: Vec<(u64, u64, u64)> = Vec::new();
    for &a in &edges {
        for &b in &edges {
            for &c in edges.iter().filter(|&&c| c != 0) {
                cases.push((a, b, c));
            }
        }
    }
    for _ in 0..5_000 {
        let (a, b, c) = (
            next() >> (next() % 64),
            next() >> (next() % 64),
            (next() >> (next() % 64)).max(1),
        );
        cases.push((a, b, c));
    }
    for (a, b, c) in cases {
        let reference = (u128::from(a) * u128::from(b)).div_ceil(u128::from(c));
        let want = u64::try_from(reference).map_err(|_| RelayError::ArithmeticOverflow);
        assert_eq!(required_min_out(a, b, c), want, "ceil({a}*{b}/{c})");
    }
}

// Through the program: a floor whose required minimum does not fit in u64 is error 114 and moves nothing.
dual_token!(
    ar_02_floor_overflow_through_swap_is_114,
    with | b
        | b.swap_with(|s| {
            s.floor_out = u64::MAX;
            s.floor_in = 1;
        }),
    |ctx| {
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.swap_ix(2, 0, ctx.deadline(50))])
            .assert_relay_err(relay_err::ARITHMETIC_OVERFLOW);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
);

// ---------------------------------------------------------------------------------------------
// AR-03 N transfers in ONE transaction (limitation L4)
// ---------------------------------------------------------------------------------------------

dual_token!(
    ar_03_split_transfers_bounded_by_lifetime_limit,
    with | b | b.limits(25, 10),
    |ctx| {
        // three 10s: each is within per_tx_limit, the sum (30) exceeds the lifetime limit (25).
        let ixs = [
            ctx.transfer_ix(10),
            ctx.transfer_ix(10),
            ctx.transfer_ix(10),
        ];
        let before = ctx.snapshot();
        ctx.send_agent(&ixs)
            .assert_aa_err(aa_err::SPEND_LIMIT_EXCEEDED);
        // atomic: the first two instructions were reverted too
        assert_nothing_moved(&before, &ctx.snapshot());
        assert_eq!(ctx.token_perm().spend_total, 0);

        // 10 + 10 + 5 = 25 == lifetime limit: allowed. A single transaction therefore moved 25 > per_tx_limit (L4).
        let ixs = [ctx.transfer_ix(10), ctx.transfer_ix(10), ctx.transfer_ix(5)];
        let r = ctx.send_agent(&ixs);
        r.assert_ok();
        assert_eq!(r.events().len(), 3);
        let p = ctx.token_perm();
        assert_eq!((p.spend_total, p.call_count), (25, 3));
        assert_eq!(ctx.balance(&ctx.source), ctx.initial_source_balance - 25);
        assert_eq!(ctx.balance(&ctx.recipients[0]), 25);
        // exhausted
        agent_aa_err(ctx, ctx.transfer_ix(1), aa_err::SPEND_LIMIT_EXCEEDED);
    }
);

dual_token!(
    ar_03_split_transfers_bounded_by_delegated_amount,
    with | b | b.delegated(15),
    |ctx| {
        // the SPL allowance (15) is the hard cap: the second 10 hits it and the whole tx reverts
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(10), ctx.transfer_ix(10)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        assert_nothing_moved(&before, &ctx.snapshot());
        // 10 + 5 uses it up exactly, and the Token program clears the delegate
        ctx.send_agent(&[ctx.transfer_ix(10), ctx.transfer_ix(5)])
            .assert_ok();
        let s = ctx.token(&ctx.source);
        assert_eq!((s.delegated_amount, s.delegate), (0, None));
        assert_eq!(ctx.balance(&ctx.source), ctx.initial_source_balance - 15);
    }
);

// ---------------------------------------------------------------------------------------------
// AR-04 replay of an identical signed transaction
// ---------------------------------------------------------------------------------------------

dual_token!(ar_04_identical_signed_transaction_twice, |ctx| {
    let tx = ctx.build_tx_as(&[Who::Agent], &[ctx.transfer_ix(1_000)]);
    ctx.send_prebuilt(tx.clone()).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, 1_000);
    let before = ctx.snapshot();
    let r = ctx.send_prebuilt(tx);
    match &r.result {
        Err(f) => assert_eq!(
            f.err,
            TransactionError::AlreadyProcessed,
            "replay must be AlreadyProcessed"
        ),
        Ok(_) => panic!("the identical signed transaction was accepted twice"),
    }
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.token_perm().spend_total, 1_000, "replay booked nothing");
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000);
});

// ---------------------------------------------------------------------------------------------
// AR-05 two transfer instructions in one transaction read fresh balances
// ---------------------------------------------------------------------------------------------

dual_token!(ar_05_two_transfers_in_one_transaction, |ctx| {
    let r = ctx.send_agent(&[
        ctx.transfer_ix(1_000),
        ctx.transfer_ix_to(&ctx.recipients[1].clone(), 2_500),
    ]);
    r.assert_ok();
    // both exact-delta checks passed on fresh balances
    assert_eq!(ctx.balance(&ctx.source), ctx.initial_source_balance - 3_500);
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000);
    assert_eq!(ctx.balance(&ctx.recipients[1]), 2_500);
    assert_eq!(
        ctx.token(&ctx.source).delegated_amount,
        ctx.initial_delegated - 3_500
    );
    let p = ctx.token_perm();
    assert_eq!((p.spend_total, p.call_count), (3_500, 2));
    let evs = r.events();
    assert_eq!(evs.len(), 2);
    assert!(matches!(
        evs[0],
        RelayEvent::TransferExecuted { amount: 1_000, .. }
    ));
    assert!(matches!(
        evs[1],
        RelayEvent::TransferExecuted { amount: 2_500, .. }
    ));
    // same destination twice: the second reads the balance the first produced
    ctx.send_agent(&[ctx.transfer_ix(7), ctx.transfer_ix(9)])
        .assert_ok();
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000 + 16);
});

// ---------------------------------------------------------------------------------------------
// AR-06 evil Token program that raises the source balance during the CPI (needs EVIL_TOKEN_SO)
// ---------------------------------------------------------------------------------------------

#[test]
fn ar_06_evil_token_raises_the_source_balance() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).try_build() else {
        return;
    };
    if !ctx.install_evil_token() {
        return;
    }
    let mint = MintAcct::new(ctx.token_program, ctx.decimals)
        .supply(1 << 40)
        .evil_mode(token::evil::RAISE_SOURCE);
    token::put_mint(&mut ctx.svm, ctx.mint, &mint);
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    // 106 (delta differs) or 114 (checked subtraction underflowed): never success, never a wrap
    let code = common::assert::custom_code(&r.result);
    assert!(
        code == Some(relay_err::BALANCE_DELTA_VIOLATION)
            || code == Some(relay_err::ARITHMETIC_OVERFLOW),
        "expected relay 106 or 114, got {:?}\n{}",
        r.result.as_ref().err().map(|f| &f.err),
        r.pretty_logs()
    );
    r.assert_err(&RELAY_ID, code.unwrap());
    assert_nothing_moved(&before, &ctx.snapshot());
}
