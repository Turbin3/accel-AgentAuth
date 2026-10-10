//! Regression tests for the relay red-team findings (RT-F1 .. RT-F6), written against the real
//! `.so` files in LiteSVM.
//!
//! | finding | what is pinned here |
//! |---|---|
//! | RT-F1 | `per_tx_limit` is per `verify` call: 21 relay transfers fit in one transaction, the 22nd does not; the loss is still bounded by the lifetime limit and the SPL allowance (accepted, spec E08 / L4) |
//! | RT-F2 | revoke + re-create with the SAME expiry re-binds an un-closed policy (accepted, spec D8 / L8, needs a core generation id); with a different expiry it is refused (118); the unwind closes it |
//! | RT-F3 | Token-2022's native mint is refused like the classic one at `init_policy` |
//! | RT-F4 | `set_paused` / `close_policy` with a read-only mutated account fail with a relay code, not a runtime error |
//! | RT-F5 | the relay's CPI account lists are exactly the pinned ones: the AMM never receives the agent, the mandate, the owner, the policy, the relay or AgentAuth |

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use agent_auth_relay::ids::NATIVE_MINT_2022 as RELAY_NATIVE_MINT_2022;

// ---------------------------------------------------------------------------------------------
// RT-F1: per_tx_limit is per verify call (accepted, documented, measured)
// ---------------------------------------------------------------------------------------------

/// One transaction of `n` one-unit relay transfers: the highest `n` that the runtime accepts is
/// 21 (64-entry instruction trace, three entries per transfer), regardless of `per_tx_limit`.
fn n_transfers_tx(ctx: &mut Ctx, n: usize, amount: u64) -> Exec {
    let ixs: Vec<Instruction> = (0..n).map(|_| ctx.transfer_ix(amount)).collect();
    ctx.send_agent(&ixs)
}

dual_token!(
    rt_f1_per_tx_limit_is_per_call_and_21_transfers_fit_one_tx,
    with | b | b.limits(1_000_000, 1_000),
    |ctx| {
        // a single call above per_tx_limit is refused ...
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(1_001)])
            .assert_aa_err(aa_err::PER_TX_EXCEEDED);
        assert_nothing_moved(&before, &ctx.snapshot());

        // ... but 21 calls at the limit land in ONE transaction: 21 x per_tx_limit moved.
        let r = n_transfers_tx(ctx, 21, 1_000);
        r.assert_ok();
        assert!(r.tx_size <= 1232, "tx is {} bytes", r.tx_size);
        assert_eq!(ctx.balance(&ctx.recipients[0]), 21_000);
        assert_eq!(ctx.token_perm().call_count, 21);

        // the 22nd instruction exceeds the 64-entry instruction trace: whole tx refused.
        let before = ctx.snapshot();
        let r = n_transfers_tx(ctx, 22, 1);
        assert_failed(&r.result);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
);

// ---------------------------------------------------------------------------------------------
// RT-F2: same-expiry re-creation re-binds an un-closed policy (accepted); the unwind closes it
// ---------------------------------------------------------------------------------------------

dual_token!(rt_f2_recreated_mandate_with_new_expiry_is_stale, |ctx| {
    // revoke_mandate alone leaves policy and delegation in place; the agent is dead (117) ...
    ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
    ctx.send_agent(&[ctx.transfer_ix(1_000)])
        .assert_relay_err(relay_err::INVALID_MANDATE);

    // ... a re-created mandate with a DIFFERENT expiry does not re-activate the old policy (118).
    let tp = ctx.token_program;
    ctx.send_owner(&[
        ctx.create_mandate_ix(ctx.expiry + 1),
        ctx.add_permission_ix(&tp, 5_000, 500, &[TRANSFER_CHECKED_DISC]),
    ])
    .assert_ok();
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(100)])
        .assert_relay_err(relay_err::STALE_POLICY);
    assert_nothing_moved(&before, &ctx.snapshot());
});

dual_token!(
    rt_f2_unwind_closes_policy_so_recreation_cannot_rebind,
    |ctx| {
        let unwind = ctx.unwind_ixs();
        ctx.send_owner(&unwind).assert_ok();
        assert!(ctx.svm.get_account(&ctx.policy).is_none(), "policy closed");
        assert_eq!(ctx.token(&ctx.source).delegate, None, "delegation revoked");

        // re-create with the SAME expiry: there is no old policy or delegation left to re-bind.
        let tp = ctx.token_program;
        ctx.send_owner(&[
            ctx.create_mandate_ix(ctx.expiry),
            ctx.add_permission_ix(&tp, 5_000, 500, &[TRANSFER_CHECKED_DISC]),
        ])
        .assert_ok();
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(100)])
            .assert_relay_err(relay_err::INVALID_POLICY);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
);

dual_token!(
    rt_f2_known_limit_same_expiry_recreation_rebinds_an_unclosed_policy,
    |ctx| {
        // Documents the accepted residual (spec D8 / L8): the relay compares only the 8 expiry
        // bytes, so an un-closed policy plus an un-revoked delegation revive with a re-created
        // mandate that reuses the expiry, with fresh counters. The mandate limits still apply.
        ctx.send_owner(&[ctx.revoke_mandate_ix()]).assert_ok();
        let tp = ctx.token_program;
        ctx.send_owner(&[
            ctx.create_mandate_ix(ctx.expiry),
            ctx.add_permission_ix(&tp, 5_000, 500, &[TRANSFER_CHECKED_DISC]),
        ])
        .assert_ok();
        ctx.send_agent(&[ctx.transfer_ix(500)]).assert_ok();
        // the NEW mandate's limits bound it
        ctx.send_agent(&[ctx.transfer_ix(501)])
            .assert_aa_err(aa_err::PER_TX_EXCEEDED);
        assert_eq!(ctx.token_perm().spend_total, 500);
    }
);

// ---------------------------------------------------------------------------------------------
// RT-F3: the Token-2022 native mint is refused like the classic one
// ---------------------------------------------------------------------------------------------

#[test]
fn rt_f3_relay_constant_equals_the_token_2022_native_mint() {
    assert_eq!(RELAY_NATIVE_MINT_2022, NATIVE_MINT_2022.to_bytes());
    assert_ne!(NATIVE_MINT_2022, NATIVE_MINT);
}

/// `init_policy` with `tweak` applied to a valid swap-enabled config is refused with 113 and
/// creates nothing.
fn init_refused(flavor: Flavor, tweak: impl FnOnce(&mut PolicyCfg)) {
    let Some(mut ctx) = Ctx::builder(flavor).with_swap().no_policy().try_build() else {
        return;
    };
    let mut cfg = ctx.cfg.clone();
    tweak(&mut cfg);
    let before = ctx.snapshot();
    ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)])
        .assert_relay_err(relay_err::INVALID_CONFIG);
    assert!(
        ctx.svm.get_account(&ctx.policy).is_none(),
        "nothing created"
    );
    assert_nothing_moved(&before, &ctx.snapshot());
}

#[test]
fn rt_f3_budget_mint_token_2022_native_refused() {
    for flavor in Flavor::ALL {
        init_refused(flavor, |c| c.budget_mint = NATIVE_MINT_2022);
    }
}

#[test]
fn rt_f3_in_mint_token_2022_native_refused() {
    for flavor in Flavor::ALL {
        init_refused(flavor, |c| c.in_mint = NATIVE_MINT_2022);
    }
}

#[test]
fn rt_f3_native_mint_still_allowed_as_swap_output() {
    // Spec 5.2: the native mint may be the swap OUTPUT mint. The Token-2022 native mint is the
    // same case. Only the validation outcome is asserted (the harness cannot build a wSOL pool).
    for flavor in Flavor::ALL {
        let Some(mut ctx) = Ctx::builder(flavor).with_swap().no_policy().try_build() else {
            return;
        };
        let mut cfg = ctx.cfg.clone();
        cfg.out_mint = NATIVE_MINT_2022;
        let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
        r.assert_ok();
    }
}

// ---------------------------------------------------------------------------------------------
// RT-F4: owner instructions with a read-only mutated account fail with relay 102
// ---------------------------------------------------------------------------------------------

dual_token!(rt_f4_set_paused_readonly_policy_is_a_relay_error, |ctx| {
    let before = ctx.snapshot();
    let policy_before = ctx.policy_bytes();
    ctx.send_owner(&[ctx.set_paused_ix(1).with_writable(1, false)])
        .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.policy_bytes(), policy_before);
    // the control: the same instruction with the right flags works and is reversible
    ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
    ctx.send_agent(&[ctx.transfer_ix(1)])
        .assert_relay_err(relay_err::PAUSED);
    ctx.send_owner(&[ctx.set_paused_ix(0)]).assert_ok();
    ctx.send_agent(&[ctx.transfer_ix(1)]).assert_ok();
});

dual_token!(
    rt_f4_close_policy_readonly_accounts_is_a_relay_error,
    |ctx| {
        let policy_before = ctx.svm.get_account(&ctx.policy);
        // read-only policy
        ctx.send_owner(&[ctx.close_policy_ix().with_writable(1, false)])
            .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        // read-only owner (another account pays the fee, so the owner stays read-only in the message)
        ctx.send_as(
            &[Who::Attacker, Who::Owner],
            &[ctx.close_policy_ix().with_writable(0, false)],
        )
        .assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        assert_eq!(ctx.svm.get_account(&ctx.policy), policy_before);
        // the control: a correct close returns the rent to the owner and removes the policy
        let owner_before = ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap();
        ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
        assert!(ctx.svm.get_account(&ctx.policy).is_none());
        assert!(ctx.svm.get_balance(&ctx.owner.pubkey()).unwrap() > owner_before);
    }
);

dual_token!(rt_f4_wrong_owner_still_reported_before_writability, |ctx| {
    // the authorisation errors keep their precedence: an attacker signing with a read-only
    // policy still gets NotPolicyOwner (109), not the account-flag error.
    let mut ix = ctx.set_paused_ix(1).with_writable(1, false);
    ix.accounts[0].pubkey = ctx.attacker.pubkey();
    ctx.send_attacker(&[ix])
        .assert_relay_err(relay_err::NOT_POLICY_OWNER);
});

// ---------------------------------------------------------------------------------------------
// RT-F5: the CPI account lists are exactly the pinned ones
// ---------------------------------------------------------------------------------------------

/// Keys that must never reach a callee other than `verify`.
fn never_callee_accounts(ctx: &Ctx) -> Vec<(&'static str, Pubkey)> {
    vec![
        ("agent", ctx.agent.pubkey()),
        ("mandate", ctx.mandate),
        ("owner", ctx.owner.pubkey()),
        ("policy", ctx.policy),
        ("relay program", RELAY_ID),
        ("agentauth program", AGENT_AUTH_ID),
    ]
}

dual_token!(
    rt_f5_swap_cpi_account_lists_are_exactly_the_pinned_accounts,
    with | b | b.with_swap(),
    |ctx| {
        let f = ctx.swap_fixture().clone();
        let r = ctx.send_agent(&[ctx.swap_ix_default(20_000)]);
        r.assert_ok();
        let cpis = r.relay_cpis();
        assert_eq!(cpis.len(), 2, "verify + AMM swap only");

        let verify = &cpis[0];
        assert_eq!(verify.program, AGENT_AUTH_ID);
        assert_eq!(
            verify.accounts,
            vec![ctx.mandate, ctx.owner.pubkey(), ctx.agent.pubkey()],
            "verify gets [mandate, owner, agent]"
        );

        let amm = &cpis[1];
        assert_eq!(amm.program, f.amm_program);
        assert_eq!(
            amm.accounts,
            vec![
                ctx.authority,
                f.amm_authority,
                f.amm_config,
                f.pool_state,
                f.in_account,
                f.out_account,
                f.input_vault,
                f.output_vault,
                f.in_token_program,
                f.out_token_program,
                f.in_mint,
                f.out_mint,
                f.observation_state,
            ],
            "the AMM receives exactly the 13 pinned accounts, in Raydium's order"
        );
        for (name, key) in never_callee_accounts(ctx) {
            assert!(
                !amm.accounts.contains(&key),
                "the AMM CPI must not carry the {name}"
            );
        }
    }
);

dual_token!(
    rt_f5_transfer_cpi_account_lists_are_exactly_the_pinned_accounts,
    |ctx| {
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
        r.assert_ok();
        let cpis = r.relay_cpis();
        assert_eq!(cpis.len(), 2, "verify + TransferChecked only");
        assert_eq!(cpis[0].program, AGENT_AUTH_ID);
        assert_eq!(
            cpis[0].accounts,
            vec![ctx.mandate, ctx.owner.pubkey(), ctx.agent.pubkey()]
        );
        let token = &cpis[1];
        assert_eq!(token.program, ctx.token_program);
        assert_eq!(
            token.accounts,
            vec![ctx.source, ctx.mint, ctx.recipients[0], ctx.authority],
            "TransferChecked gets [source, mint, destination, authority]"
        );
        for (name, key) in never_callee_accounts(ctx) {
            assert!(
                !token.accounts.contains(&key),
                "the Token CPI must not carry the {name}"
            );
        }
    }
);
