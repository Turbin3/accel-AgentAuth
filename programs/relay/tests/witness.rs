//! Witness tests: one targeted regression test per behaviour that the hand-mutation rounds on
//! `programs/relay/src` showed to be unpinned. Each test PASSES on the real relay and FAILS on the
//! mutants named in its banner (ids are the mutation-catalogue ids: C = checks.rs, D = set_paused,
//! L = close_policy, N = init_policy, S = swap, T = transfer, K = token.rs, V = state.rs,
//! G = grouped mutants).
//!
//! Where a mutated check is "masked" by another check in normal flows (policy header bindings,
//! source/destination token-account fields, error precedence), the test flips exactly one
//! input at a time or plants a state the relay's own `init_policy` could never write.

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::policy::off;
use common::*;

#[track_caller]
fn agent_relay_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_relay_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// Restore an account after a destructive edit.
fn put_back(ctx: &mut Ctx, key: Pubkey, good: &solana_account::Account) {
    ctx.svm.put(key, good.clone());
}

// ---------------------------------------------------------------------------------------------
// W01  C15 C16 C17 (G01): the policy header bindings are only exercised all at once (TR-18 swaps
// the WHOLE policy, so the authority binding catches it). Flip one header field at a time.
// ---------------------------------------------------------------------------------------------
dual_token!(w01_policy_header_bindings_one_field_at_a_time, |ctx| {
    let p = ctx.policy;
    let good = ctx.svm.get_account(&p).unwrap();
    for (name, offset) in [
        ("mandate", off::MANDATE),
        ("owner", off::OWNER),
        ("agent", off::AGENT),
        ("authority", off::AUTHORITY),
    ] {
        ctx.edit_account(&p, |a| a.data[offset] ^= 0x55);
        let ix = ctx.transfer_ix(1_000);
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ix]);
        assert!(r.result.is_err(), "{name}: transfer succeeded");
        r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        assert_nothing_moved(&before, &ctx.snapshot());
        put_back(ctx, p, &good);
    }
});

dual_token!(
    w01b_policy_header_bindings_on_swap,
    with | b | b.with_swap(),
    |ctx| {
        let p = ctx.policy;
        let good = ctx.svm.get_account(&p).unwrap();
        for (name, offset) in [
            ("mandate", off::MANDATE),
            ("owner", off::OWNER),
            ("agent", off::AGENT),
        ] {
            ctx.edit_account(&p, |a| a.data[offset] ^= 0x55);
            let ix = ctx.swap_ix_default(1_000);
            let r = ctx.send_agent(&[ix]);
            assert!(r.result.is_err(), "{name}: swap succeeded");
            r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
            put_back(ctx, p, &good);
        }
    }
);

// ---------------------------------------------------------------------------------------------
// W02  C20: the stale-policy guard compares all 8 expiry bytes
// ---------------------------------------------------------------------------------------------
dual_token!(w02_stale_guard_sees_high_expiry_bytes, |ctx| {
    let e = ctx.expiry + (1i64 << 40); // still far in the future, differs only above bit 32
    ctx.set_mandate_expiry_raw(e);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::STALE_POLICY);
});

// ---------------------------------------------------------------------------------------------
// W03  C07 C08 (G06): runtime mandate shape (length, discriminator) is 117, not a core error
// ---------------------------------------------------------------------------------------------
dual_token!(w03_runtime_mandate_shape_rows, |ctx| {
    let m = ctx.mandate;
    let good = ctx.svm.get_account(&m).unwrap();
    type Edit = Box<dyn Fn(&mut solana_account::Account)>;
    let rows: Vec<(&str, Edit)> = vec![
        ("length 2137", Box::new(|a| a.data.push(0))),
        ("length 2135", Box::new(|a| a.data.truncate(2135))),
        ("disc 2", Box::new(|a| a.data[0] = 2)),
        ("disc 0", Box::new(|a| a.data[0] = 0)),
    ];
    for (name, edit) in rows {
        ctx.edit_account(&m, |a| edit(a));
        let ix = ctx.transfer_ix(1_000);
        let r = ctx.send_agent(&[ix]);
        assert!(r.result.is_err(), "{name}: transfer succeeded");
        r.assert_relay_err(relay_err::INVALID_MANDATE);
        put_back(ctx, m, &good);
    }
});

// ---------------------------------------------------------------------------------------------
// W04  T12 T13 (G04): the source token account's mint field and owner field are checked by the
// relay itself (105), not left to the Token program (Custom 3) or silently accepted.
// ---------------------------------------------------------------------------------------------
dual_token!(w04_source_account_mint_and_owner_fields, |ctx| {
    let src = ctx.source;
    let good = ctx.svm.get_account(&src).unwrap();
    // mint field
    ctx.edit_account(&src, |a| a.data[0..32].copy_from_slice(unique().as_ref()));
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    put_back(ctx, src, &good);
    // owner field: someone else's account that is (mis)delegated to this mandate's authority PDA
    let attacker = ctx.attacker.pubkey();
    ctx.edit_account(&src, |a| a.data[32..64].copy_from_slice(attacker.as_ref()));
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    put_back(ctx, src, &good);
    // control
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
});

// ---------------------------------------------------------------------------------------------
// W05  S15 S16 S21 (G05): swap in/out account mint and owner fields
// ---------------------------------------------------------------------------------------------
dual_token!(
    w05_swap_account_mint_and_owner_fields,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        for (name, key, offset) in [
            ("in_account mint", s.in_account, 0usize),
            ("in_account owner", s.in_account, 32),
            ("out_account mint", s.out_account, 0),
            ("out_account owner", s.out_account, 32),
        ] {
            let good = ctx.svm.get_account(&key).unwrap();
            ctx.edit_account(&key, |a| {
                a.data[offset..offset + 32].copy_from_slice(unique().as_ref())
            });
            let ix = ctx.swap_ix_default(1_000);
            let r = ctx.send_agent(&[ix]);
            assert!(r.result.is_err(), "{name}: swap succeeded");
            r.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
            put_back(ctx, key, &good);
        }
        ctx.send_agent(&[ctx.swap_ix_default(1_000)]).assert_ok();
    }
);

// ---------------------------------------------------------------------------------------------
// W06  K01 T11 (G03) S12 (G08): token accounts owned by a foreign program are 103
// ---------------------------------------------------------------------------------------------
dual_token!(w06_token_accounts_owned_by_a_foreign_program, |ctx| {
    for key in [ctx.source, ctx.recipients[0]] {
        let good = ctx.svm.get_account(&key).unwrap();
        ctx.edit_account(&key, |a| a.owner = unique());
        let ix = ctx.transfer_ix_to(&ctx.recipients[0].clone(), 1_000);
        let r = ctx.send_agent(&[ix]);
        r.assert_relay_err(relay_err::WRONG_PROGRAM);
        put_back(ctx, key, &good);
    }
});

dual_token!(
    w06b_swap_token_accounts_owned_by_a_foreign_program,
    with | b | b.with_swap(),
    |ctx| {
        let s = ctx.swap_fixture().clone();
        for key in [s.in_account, s.out_account] {
            let good = ctx.svm.get_account(&key).unwrap();
            ctx.edit_account(&key, |a| a.owner = unique());
            let ix = ctx.swap_ix_default(1_000);
            ctx.send_agent(&[ix])
                .assert_relay_err(relay_err::WRONG_PROGRAM);
            put_back(ctx, key, &good);
        }
    }
);

// ---------------------------------------------------------------------------------------------
// W07  V05 V38: recipients_len 9 with eight real recipients, and a duplicate in slot 8
// ---------------------------------------------------------------------------------------------
#[test]
fn w07_recipient_array_boundary() {
    for flavor in Flavor::DUAL {
        let Some(mut ctx) = Ctx::builder(flavor).recipients(8).no_policy().try_build() else {
            return;
        };
        let base = ctx.cfg.clone();
        assert_eq!(base.recipients_len, 8);

        let mut cfg = base.clone();
        cfg.recipients_len = 9;
        ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)])
            .assert_relay_err(relay_err::INVALID_CONFIG);

        for (name, key) in [
            ("duplicate of recipient 0", base.recipients[0]),
            ("equal to source", base.source_account),
            ("equal to the agent", ctx.agent.pubkey()),
            ("equal to the owner", ctx.owner.pubkey()),
            ("equal to the mandate", ctx.mandate),
            ("equal to the authority", ctx.authority),
        ] {
            let mut cfg = base.clone();
            cfg.recipients[7] = key;
            let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
            assert!(r.result.is_err(), "8th recipient {name}: init succeeded");
            r.assert_relay_err(relay_err::INVALID_CONFIG);
        }
        ctx.send_owner(&[ctx.init_policy_ix(&base, 0)]).assert_ok();
    }
}

// ---------------------------------------------------------------------------------------------
// W08  D04 D05 D07: pausing / unpausing changes ONLY bit0 (invariant I8) and emits PausedChanged
// ---------------------------------------------------------------------------------------------
dual_token!(
    w08_pause_preserves_strict_top_level,
    with | b | b.strict_top_level(),
    |ctx| {
        assert_eq!(ctx.policy_bytes()[off::FLAGS], FLAG_STRICT_TOP_LEVEL);
        let r = ctx.send_owner(&[ctx.set_paused_ix(1)]);
        r.assert_ok();
        assert!(r.events().contains(&RelayEvent::PausedChanged {
            mandate: ctx.mandate,
            paused: 1
        }));
        assert_eq!(
            ctx.policy_bytes()[off::FLAGS],
            FLAG_PAUSED | FLAG_STRICT_TOP_LEVEL
        );
        let r = ctx.send_owner(&[ctx.set_paused_ix(0)]);
        r.assert_ok();
        assert!(r.events().contains(&RelayEvent::PausedChanged {
            mandate: ctx.mandate,
            paused: 0
        }));
        assert_eq!(ctx.policy_bytes()[off::FLAGS], FLAG_STRICT_TOP_LEVEL);
        // the rest of the policy is byte-identical to a fresh init
        assert_eq!(
            ctx.policy_bytes(),
            ctx.expected_header(FLAG_STRICT_TOP_LEVEL)
                .encode_with(&ctx.cfg)
        );
    }
);

// ---------------------------------------------------------------------------------------------
// W09  L06: close_policy really closes (owner reset to System, data emptied) inside the same
// transaction: a following init_policy in the SAME transaction sees a fresh account.
// ---------------------------------------------------------------------------------------------
dual_token!(w09_close_then_init_in_one_transaction, |ctx| {
    let cfg = ctx.cfg.clone();
    ctx.send_owner(&[ctx.close_policy_ix(), ctx.init_policy_ix(&cfg, 0)])
        .assert_ok();
    assert_eq!(ctx.policy_bytes(), ctx.expected_header(0).encode_with(&cfg));
});

// ---------------------------------------------------------------------------------------------
// W10  C23 C24: error precedence follows the spec order (flags 116 before mandate 117;
// bindings 102 before stale guard 118)
// ---------------------------------------------------------------------------------------------
dual_token!(w10a_paused_beats_invalid_mandate, |ctx| {
    ctx.send_owner(&[ctx.set_paused_ix(1)]).assert_ok();
    let m = ctx.mandate;
    ctx.edit_account(&m, |a| a.owner = unique());
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::PAUSED);
});

dual_token!(w10b_binding_beats_stale_guard, |ctx| {
    let p = ctx.policy;
    ctx.edit_account(&p, |a| a.data[off::OWNER] ^= 0x55); // binding broken
    let e = ctx.expiry + 1;
    ctx.set_mandate_expiry_raw(e); // and the policy is stale
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::ACCOUNT_MISMATCH);
});

// ---------------------------------------------------------------------------------------------
// W11  T09: a (planted) policy whose recipient list contains the source itself
// ---------------------------------------------------------------------------------------------
dual_token!(w11_destination_equal_to_source, |ctx| {
    let src = ctx.source;
    let p = ctx.policy;
    ctx.edit_account(&p, |a| {
        a.data[off::RECIPIENTS..off::RECIPIENTS + 32].copy_from_slice(src.as_ref())
    });
    agent_relay_err(
        ctx,
        ctx.transfer_ix_to(&src, 1_000),
        relay_err::RECIPIENT_NOT_ALLOWED,
    );
});

// ---------------------------------------------------------------------------------------------
// W12  S10: a non-executable account at the pinned AMM address is 103
// ---------------------------------------------------------------------------------------------
dual_token!(
    w12_amm_program_not_executable,
    with | b | b.with_swap(),
    |ctx| {
        ctx.edit_account(&MOCK_AMM_ID, |a| a.executable = false);
        let ix = ctx.swap_ix_default(1_000);
        ctx.send_agent(&[ix])
            .assert_relay_err(relay_err::WRONG_PROGRAM);
    }
);

// ---------------------------------------------------------------------------------------------
// W13  K19 S35: pure post-condition checks (no token program can reach these states)
// ---------------------------------------------------------------------------------------------
fn snap(
    amount: u64,
    delegated: u64,
    delegate: Option<[u8; 32]>,
) -> agent_auth_relay::token::Snapshot {
    let mut delegate_raw = [0u8; 36];
    if let Some(k) = delegate {
        delegate_raw[0] = 1;
        delegate_raw[4..].copy_from_slice(&k);
    }
    agent_auth_relay::token::Snapshot {
        owner_program: TOKEN_ID.to_bytes(),
        data_len: 165,
        owner_field: [2; 32],
        state: 1,
        delegate_raw,
        close_raw: [0; 36],
        amount,
        delegated,
    }
}

#[test]
fn w13a_input_delegate_cannot_be_repointed_when_delegation_hits_zero() {
    use agent_auth_relay::{ix::swap::check_post, RelayError};
    let pre_in = snap(1000, 10, Some([3; 32]));
    let pre_out = snap(0, 0, None);
    let post_out = snap(95, 0, None);
    // cleared at zero: fine
    assert!(check_post(&pre_in, &pre_out, &snap(990, 0, None), &post_out, 10, 95).is_ok());
    // re-pointed to a different key at zero: violation
    assert_eq!(
        check_post(
            &pre_in,
            &pre_out,
            &snap(990, 0, Some([4; 32])),
            &post_out,
            10,
            95
        ),
        Err(RelayError::AccountInvariantViolated)
    );
}

#[test]
fn w13b_output_account_delegate_may_never_be_cleared() {
    use agent_auth_relay::{ix::swap::check_post, RelayError};
    let pre_in = snap(1000, 10, Some([3; 32]));
    let pre_out = snap(0, 0, Some([5; 32])); // an existing delegate with delegated_amount 0
    assert_eq!(
        check_post(
            &pre_in,
            &pre_out,
            &snap(990, 0, None),
            &snap(95, 0, None),
            10,
            95
        ),
        Err(RelayError::AccountInvariantViolated)
    );
}

// ---------------------------------------------------------------------------------------------
// W14  V37: the largest valid config (8 recipients + swap with a separate in_account, 23 distinct
// keys) is accepted by init_policy
// ---------------------------------------------------------------------------------------------
#[test]
fn w14_maximal_valid_config_is_accepted() {
    for flavor in Flavor::DUAL {
        let Some(ctx) = Ctx::builder(flavor).recipients(8).with_swap().try_build() else {
            return;
        };
        assert_eq!(ctx.cfg.recipients_len, 8);
        assert_eq!(ctx.cfg.swap_enabled, 1);
        assert_eq!(ctx.policy_bytes().len(), 944);
    }
}

// ---------------------------------------------------------------------------------------------
// W15  T11: step 12 (owner program of source/destination, 103) precedes step 13 (source state, 105)
// ---------------------------------------------------------------------------------------------
dual_token!(w15_foreign_destination_owner_beats_frozen_source, |ctx| {
    let src = ctx.source;
    let dst = ctx.recipients[0];
    ctx.edit_account(&src, |a| a.data[108] = 2); // frozen: token_acct_ok(source) would say 105
    ctx.edit_account(&dst, |a| a.owner = unique()); // foreign owner program: step 12 says 103
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::WRONG_PROGRAM);
});

// ---------------------------------------------------------------------------------------------
// W16  N12 N13: the policy PDA must be a fresh system account: a planted account that is
// relay/foreign-owned and empty, or system-owned with data, is 113 (not a System program error)
// ---------------------------------------------------------------------------------------------
dual_token!(
    w16_policy_pda_must_be_fresh,
    with | b | b.no_policy(),
    |ctx| {
        let cfg = ctx.cfg.clone();
        let lamports = ctx.svm.rent(944);
        let rows: [(&str, Pubkey, Vec<u8>); 3] = [
            ("foreign-owned, empty", unique(), vec![]),
            ("relay-owned, empty", RELAY_ID, vec![]),
            ("system-owned, 10 data bytes", SYSTEM_ID, vec![7u8; 10]),
        ];
        for (name, owner, data) in rows {
            ctx.svm.put(
                ctx.policy,
                solana_account::Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            );
            let r = ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]);
            assert!(r.result.is_err(), "{name}: init succeeded");
            r.assert_relay_err(relay_err::INVALID_CONFIG);
        }
    }
);

// ---------------------------------------------------------------------------------------------
// W17  N22 (only differs for a read-only owner meta): policy PDA pre-funded with EXACTLY the rent:
// no top-up transfer is needed, so even a read-only `owner` meta is enough.
// ---------------------------------------------------------------------------------------------
dual_token!(
    w17_exact_rent_prefund_needs_no_transfer,
    with | b | b.no_policy(),
    |ctx| {
        let rent = ctx.svm.rent(944);
        let policy = ctx.policy;
        ctx.svm.airdrop(&policy, rent).unwrap();
        let cfg = ctx.cfg.clone();
        let ix = ctx
            .init_policy_ix(&cfg, 0)
            .with_writable(init_idx::OWNER, false);
        ctx.send_owner(&[ix]).assert_ok();
    }
);

// ---------------------------------------------------------------------------------------------
// W18  N10 (error precedence only): agent == owner is reported before the policy-PDA check
// ---------------------------------------------------------------------------------------------
dual_token!(
    w18_agent_equals_owner_is_reported_first,
    with | b | b.no_policy(),
    |ctx| {
        let owner = ctx.owner.pubkey();
        let m = ctx.mandate;
        ctx.edit_account(&m, |a| {
            a.data[agent_auth::OFF_AGENT..agent_auth::OFF_AGENT + 32]
                .copy_from_slice(owner.as_ref());
        });
        let cfg = ctx.cfg.clone();
        let ix = ctx
            .init_policy_ix(&cfg, 0)
            .with_account(init_idx::POLICY, unique());
        ctx.send_owner(&[ix])
            .assert_relay_err(relay_err::INVALID_CONFIG);
    }
);

// ---------------------------------------------------------------------------------------------
// W19  T07: a policy whose token program is some other program (planted bytes: init_policy can
// never write one) is refused with 103 even when every pin and every account matches it.
// ---------------------------------------------------------------------------------------------
dual_token!(w19_fake_token_program_in_the_policy_is_103, |ctx| {
    let f = unique();
    ctx.install_always_ok(f);
    let (mint, src, dst, p) = (ctx.mint, ctx.source, ctx.recipients[0], ctx.policy);
    for key in [mint, src, dst] {
        ctx.edit_account(&key, |a| a.owner = f);
    }
    ctx.edit_account(&p, |a| {
        a.data[off::TOKEN_PROGRAM..off::TOKEN_PROGRAM + 32].copy_from_slice(f.as_ref())
    });
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::TOKEN_PROGRAM, f);
    ctx.send_agent(&[ix])
        .assert_relay_err(relay_err::WRONG_PROGRAM);
});

// ---------------------------------------------------------------------------------------------
// W20  S12: same for the swap's in/out token programs
// ---------------------------------------------------------------------------------------------
dual_token!(
    w20_fake_swap_token_programs_in_the_policy_are_103,
    with | b | b.with_swap(),
    |ctx| {
        let f = unique();
        ctx.install_always_ok(f);
        let s = ctx.swap_fixture().clone();
        for key in [s.in_mint, s.out_mint, s.in_account, s.out_account] {
            ctx.edit_account(&key, |a| a.owner = f);
        }
        let p = ctx.policy;
        ctx.edit_account(&p, |a| {
            a.data[off::IN_TOKEN_PROGRAM..off::IN_TOKEN_PROGRAM + 32].copy_from_slice(f.as_ref());
            a.data[off::OUT_TOKEN_PROGRAM..off::OUT_TOKEN_PROGRAM + 32].copy_from_slice(f.as_ref());
        });
        let ix = ctx
            .swap_ix_default(1_000)
            .with_account(swap_idx::IN_TOKEN_PROGRAM, f)
            .with_account(swap_idx::OUT_TOKEN_PROGRAM, f);
        ctx.send_agent(&[ix])
            .assert_relay_err(relay_err::WRONG_PROGRAM);
    }
);

// ---------------------------------------------------------------------------------------------
// W21  S41 S42 (G09): a swap whose OUTPUT side lives under a different token program than the
// input side (classic in, Token-2022 out; extension-free layouts are byte-compatible). No fixture
// exercises in_token_program != out_token_program, so an out_account validated against the input
// token program (S41) or snapshotted with the input account's owner program (S42) goes unnoticed.
// ---------------------------------------------------------------------------------------------
#[test]
fn w21_mixed_token_programs_swap() {
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).with_swap().try_build() else {
        return;
    };
    let s = ctx.swap_fixture().clone();
    for key in [s.out_mint, s.out_account, s.output_vault] {
        ctx.edit_account(&key, |a| a.owner = TOKEN22_ID);
    }
    let p = ctx.policy;
    ctx.edit_account(&p, |a| {
        a.data[off::OUT_TOKEN_PROGRAM..off::OUT_TOKEN_PROGRAM + 32]
            .copy_from_slice(TOKEN22_ID.as_ref())
    });
    let ix = ctx
        .swap_ix_default(1_000)
        .with_account(swap_idx::OUT_TOKEN_PROGRAM, TOKEN22_ID);
    ctx.send_agent(&[ix]).assert_ok();
}
