//! Self-tests of the mock-AMM fixture helpers (needs `mock_amm.so`).

use super::*;

/// Direct mock swap with hand-built accounts: payer = a keypair that owns the input account.
#[test]
fn mock_swap_against_hand_built_pool() {
    for flavor in Flavor::DUAL {
        let mut svm = new_svm(flavor);
        if !svm::load_mock_amm(&mut svm) {
            return;
        }
        let tp = flavor.token_program();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let (mint_in, mint_out) = (unique(), unique());
        token::put_mint(&mut svm, mint_in, &MintAcct::new(tp, 6));
        token::put_mint(&mut svm, mint_out, &MintAcct::new(tp, 6));
        let (in_acct, out_acct, in_vault, out_vault) = (unique(), unique(), unique(), unique());
        token::put_token(
            &mut svm,
            in_acct,
            &TokenAcct::new(tp, mint_in, payer.pubkey(), 1_000_000),
        );
        token::put_token(
            &mut svm,
            out_acct,
            &TokenAcct::new(tp, mint_out, payer.pubkey(), 0),
        );
        token::put_token(
            &mut svm,
            in_vault,
            &TokenAcct::new(tp, mint_in, amm::pool_authority(), 1_000_000_000),
        );
        token::put_token(
            &mut svm,
            out_vault,
            &TokenAcct::new(tp, mint_out, amm::pool_authority(), 1_000_000_000),
        );
        let pool = unique();
        let lamports = svm.rent(amm::POOL_STATE_LEN);
        svm.put(
            pool,
            PoolState::normal(in_vault, out_vault).account(lamports),
        );
        let (cfg, obs) = (unique(), unique());
        let ix = amm::mock_swap_ix(
            &payer.pubkey(),
            &pool,
            &cfg,
            &in_acct,
            &out_acct,
            &in_vault,
            &out_vault,
            &tp,
            &tp,
            &mint_in,
            &mint_out,
            &obs,
            1_000_000,
            0,
        );
        let r = send_keys(&mut svm, &[&payer], &[ix]);
        r.assert_ok();
        let want_out = amm::amount_out(1_000_000_000, 1_000_000_000, 1_000_000).unwrap();
        assert_eq!(TokenView::parse(&svm.data(&out_acct)).amount, want_out);
        assert_eq!(TokenView::parse(&svm.data(&in_acct)).amount, 0);
        assert_eq!(
            TokenView::parse(&svm.data(&in_vault)).amount,
            1_001_000_000 - 1_000_000 + 1_000_000
        );
        eprintln!("mock swap CU ({}): {}", flavor.name(), r.cu());
    }
}

#[test]
fn mock_slippage_error_is_attributed_to_the_mock() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    // pool price is ~0.999; ask for far more than the pool can pay
    let r = ctx.send_agent(&[ctx.swap_ix(1_000_000, u64::MAX, ctx.deadline(10))]);
    // the relay's floor math raises its own error or the mock raises 7001; either way it is a
    // clean, attributable failure
    assert!(!r.is_ok());
    let code = custom_code_of(&r);
    assert!(
        code.is_some(),
        "expected a custom error, got {:?}\n{}",
        r.result.as_ref().err().map(|e| &e.err),
        r.pretty_logs()
    );
}

fn custom_code_of(r: &Exec) -> Option<u32> {
    assert::custom_code(&r.result)
}

#[test]
fn swap_smoke_through_the_relay() {
    for flavor in Flavor::DUAL {
        let Some(mut ctx) = Ctx::builder(flavor).with_swap().try_build() else {
            return;
        };
        let s = ctx.swap_fixture().clone();
        let before = ctx.snapshot();
        let amount_in = 1_000_000u64;
        let want_out = ctx.expected_amount_out(amount_in);
        let min = required_min_out(amount_in, s.floor_out, s.floor_in).unwrap();
        assert!(
            want_out >= min,
            "default pool price must clear the default floor"
        );
        let r = ctx.send_agent(&[ctx.swap_ix(amount_in, 0, ctx.deadline(100))]);
        r.assert_ok();
        eprintln!("swap CU ({}): {}", flavor.name(), r.cu());
        assert_eq!(
            ctx.balance(&s.in_account),
            before.token(&s.in_account).amount - amount_in
        );
        assert_eq!(ctx.balance(&s.out_account), want_out);
        assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, amount_in);
        assert_eq!(
            r.events(),
            vec![RelayEvent::SwapExecuted {
                mandate: ctx.mandate,
                pool_state: s.pool_state,
                amount_in_requested: amount_in,
                in_delta: amount_in,
                out_delta: want_out
            }]
        );
    }
}

#[test]
fn proxy_runs_the_relay_at_stack_height_three() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    let inner = ctx.transfer_ix(5);
    let r = ctx.send_agent(&[amm::proxy_ix(&inner)]);
    r.assert_ok();
    // relay called at height 2 by the proxy; its own CPIs are at height 3
    assert!(
        r.max_stack_height() >= 3,
        "max height {}",
        r.max_stack_height()
    );
    assert_eq!(r.relay_cpis().len(), 2);
}

#[test]
fn strict_top_level_flag_rejects_the_proxy_path() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic)
        .with_swap()
        .strict_top_level()
        .try_build()
    else {
        return;
    };
    ctx.send_agent(&[ctx.transfer_ix(5)]).assert_ok();
    let inner = ctx.transfer_ix(5);
    ctx.send_agent(&[amm::proxy_ix(&inner)])
        .assert_relay_err(relay_err::NOT_TOP_LEVEL);
}
