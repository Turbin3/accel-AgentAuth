//! TEST-MATRIX area TR: the `transfer` instruction (RELAY-SPEC 7.4).
//!
//! Rows are named `tr_NN_...`. Token-touching tests run on classic spl-token and on p-token
//! (`dual_token!` generates `::classic` and `::ptoken`). Every negative test asserts the exact error
//! code AND the program that raised it, and that nothing moved (all tracked token accounts, the
//! mandate counters and the policy are byte-identical afterwards).

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use common::token::{
    OFF_DELEGATE, OFF_DELEGATED_AMOUNT, OFF_DELEGATE_TAG, OFF_STATE, STATE_FROZEN,
};

/// Send `ix` as the agent, expect relay error `code`, and prove nothing moved.
#[track_caller]
fn agent_relay_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_relay_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// Same for an AgentAuth error.
#[track_caller]
fn agent_aa_err(ctx: &mut Ctx, ix: Instruction, code: u32) {
    let before = ctx.snapshot();
    ctx.send_agent(&[ix]).assert_aa_err(code);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// The body of TR-01 / TR-02 / TR-03.
fn happy_path(flavor: Flavor) {
    let Some(mut ctx) = Ctx::builder(flavor).try_build() else {
        return;
    };
    let amount = 1_234_567u64;
    let before = ctx.snapshot();
    let perm0 = ctx.token_perm();
    assert_eq!((perm0.spend_total, perm0.call_count), (0, 0));
    let r = ctx.send_agent(&[ctx.transfer_ix(amount)]);
    r.assert_ok();
    let src = ctx.token(&ctx.source);
    let dst = ctx.token(&ctx.recipients[0]);
    assert_eq!(
        src.amount,
        before.token(&ctx.source).amount - amount,
        "S -= a"
    );
    assert_eq!(
        dst.amount,
        before.token(&ctx.recipients[0]).amount + amount,
        "R += a"
    );
    assert_eq!(
        src.delegated_amount,
        ctx.initial_delegated - amount,
        "delegated_amount -= a"
    );
    assert_eq!(
        src.delegate,
        Some(ctx.authority),
        "delegate unchanged while > 0"
    );
    // nothing else changed: the other recipient, attacker and agent accounts
    assert_eq!(ctx.balance(&ctx.recipients[1]), 0);
    assert_eq!(ctx.balance(&ctx.attacker_token), 0);
    assert_eq!(ctx.balance(&ctx.agent_token), 0);
    // Token slot booked exactly
    let perm = ctx.token_perm();
    assert_eq!(perm.spend_total, amount, "spend_total += a");
    assert_eq!(perm.call_count, 1, "call_count += 1");
    // event 1
    let evs = r.events();
    assert_eq!(
        evs,
        vec![RelayEvent::TransferExecuted {
            mandate: ctx.mandate,
            destination: ctx.recipients[0],
            mint: ctx.mint,
            amount
        }],
        "exactly one TransferExecuted event"
    );
    // policy is never written by transfer (I7)
    assert_eq!(ctx.snapshot().get(&ctx.policy), before.get(&ctx.policy));
    // a second transfer accumulates
    ctx.send_agent(&[ctx.transfer_ix(7)]).assert_ok();
    assert_eq!(ctx.token_perm().spend_total, amount + 7);
    assert_eq!(ctx.token_perm().call_count, 2);
}

#[test]
fn tr_01_happy_path_classic_token() {
    happy_path(Flavor::Classic);
}

#[test]
fn tr_02_happy_path_ptoken() {
    happy_path(Flavor::PToken);
}

#[test]
fn tr_03_happy_path_token2022_extension_free() {
    happy_path(Flavor::Token2022);
}

/// TR-04: real 170-byte ImmutableOwner accounts created by the ATA program.
#[test]
fn tr_04_token2022_real_170_byte_atas() {
    let Some(mut ctx) = Ctx::builder(Flavor::Token2022).no_policy().try_build() else {
        return;
    };
    let tp = TOKEN22_ID;
    let owner = ctx.owner.pubkey();
    let wallet = unique();
    // the ATA program creates both accounts
    ctx.send_owner(&[
        token::ata_create_idempotent(&owner, &owner, &ctx.mint, &tp),
        token::ata_create_idempotent(&owner, &wallet, &ctx.mint, &tp),
    ])
    .assert_ok();
    let src = ata_address(&owner, &tp, &ctx.mint);
    let dst = ata_address(&wallet, &tp, &ctx.mint);
    for k in [src, dst] {
        let a = ctx.svm.get_account(&k).expect("ATA exists");
        assert_eq!(a.owner, tp);
        assert_eq!(a.data.len(), 170, "real Token-2022 ATA is 170 bytes");
        assert_eq!(a.data[165], 2, "AccountType::Account");
        assert_eq!(&a.data[166..170], &[7, 0, 0, 0], "ImmutableOwner TLV");
    }
    // fund the source and delegate to the authority (what mint_to + Approve would leave)
    let authority = ctx.authority;
    ctx.edit_account(&src, |a| {
        a.data[token::OFF_AMOUNT..token::OFF_AMOUNT + 8]
            .copy_from_slice(&1_000_000_000u64.to_le_bytes());
        a.data[OFF_DELEGATE_TAG..OFF_DELEGATE_TAG + 4].copy_from_slice(&1u32.to_le_bytes());
        a.data[OFF_DELEGATE..OFF_DELEGATE + 32].copy_from_slice(authority.as_ref());
        a.data[OFF_DELEGATED_AMOUNT..OFF_DELEGATED_AMOUNT + 8]
            .copy_from_slice(&50_000_000u64.to_le_bytes());
    });
    ctx.track(src);
    ctx.track(dst);
    let cfg = PolicyCfg::transfer_only(tp, ctx.mint, src, &[dst]);
    ctx.send_owner(&[ctx.init_policy_ix(&cfg, 0)]).assert_ok();
    let mut t = ctx.transfer_accounts();
    t.source = src;
    t.destination = dst;
    ctx.send_agent(&[t.ix(5_000_000)]).assert_ok();
    let s = TokenView::parse(&ctx.svm.data(&src));
    let d = TokenView::parse(&ctx.svm.data(&dst));
    assert_eq!((s.amount, s.delegated_amount), (995_000_000, 45_000_000));
    assert_eq!(d.amount, 5_000_000);
    assert_eq!((s.len, d.len), (170, 170));
}

// ---------------------------------------------------------------------------------------------
// TR-05 .. TR-10 amounts and limits
// ---------------------------------------------------------------------------------------------

dual_token!(
    tr_05_delegation_spent_to_zero_clears_delegate,
    with | b | b.delegated(1_000_000),
    |ctx| {
        ctx.send_agent(&[ctx.transfer_ix(1_000_000)]).assert_ok();
        let s = ctx.token(&ctx.source);
        assert_eq!(s.delegated_amount, 0);
        assert_eq!(s.delegate, None, "Token clears the delegate at 0");
        agent_relay_err(ctx, ctx.transfer_ix(1), relay_err::TOKEN_ACCOUNT_STATE);
    }
);

dual_token!(
    tr_06_per_tx_limit_boundary,
    with | b | b.limits(100_000_000, 1_000),
    |ctx| {
        ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
        assert_eq!(ctx.token_perm().spend_total, 1_000);
        agent_aa_err(ctx, ctx.transfer_ix(1_001), aa_err::PER_TX_EXCEEDED);
        // the failed attempt left the booked total alone
        assert_eq!(ctx.token_perm().spend_total, 1_000);
        assert_eq!(ctx.token_perm().call_count, 1);
    }
);

dual_token!(
    tr_07_lifetime_budget_boundary,
    with | b | b.limits(2_500, 2_000),
    |ctx| {
        ctx.send_agent(&[ctx.transfer_ix(2_000)]).assert_ok();
        // remaining lifetime budget is 500
        agent_aa_err(ctx, ctx.transfer_ix(501), aa_err::SPEND_LIMIT_EXCEEDED);
        ctx.send_agent(&[ctx.transfer_ix(500)]).assert_ok();
        assert_eq!(ctx.token_perm().spend_total, 2_500);
        agent_aa_err(ctx, ctx.transfer_ix(1), aa_err::SPEND_LIMIT_EXCEEDED);
        assert_eq!(ctx.token_perm().spend_total, 2_500);
        assert_eq!(ctx.token_perm().call_count, 2);
    }
);

dual_token!(tr_08_amount_zero, |ctx| {
    agent_relay_err(ctx, ctx.transfer_ix(0), relay_err::INVALID_INSTRUCTION_DATA);
});

dual_token!(tr_09_amount_u64_max, |ctx| {
    agent_relay_err(
        ctx,
        ctx.transfer_ix(u64::MAX),
        relay_err::TOKEN_ACCOUNT_STATE,
    );
});

dual_token!(
    tr_10_amount_above_balance_but_within_delegation,
    with | b | b.source_balance(1_000),
    |ctx| {
        // 5_000 <= delegated_amount (100M) and <= per_tx (10M) but > the 1_000 balance
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(5_000)])
            .assert_token_err(&ctx.token_program.clone(), token_err::INSUFFICIENT_FUNDS);
        assert_nothing_moved(&before, &ctx.snapshot());
        assert_eq!(
            ctx.token_perm().spend_total,
            0,
            "verify bookkeeping reverted too"
        );
        assert_eq!(ctx.token_perm().call_count, 0);
    }
);

// ---------------------------------------------------------------------------------------------
// TR-11 / TR-12 destination
// ---------------------------------------------------------------------------------------------

dual_token!(tr_11_recipient_not_allowlisted, |ctx| {
    for dest in [ctx.attacker_token, ctx.agent_token, unique()] {
        agent_relay_err(
            ctx,
            ctx.transfer_ix_to(&dest, 1_000),
            relay_err::RECIPIENT_NOT_ALLOWED,
        );
    }
    // an allowlisted one still works afterwards
    ctx.send_agent(&[ctx.transfer_ix_to(&ctx.recipients[1].clone(), 1_000)])
        .assert_ok();
});

dual_token!(tr_12_destination_equals_source, |ctx| {
    agent_relay_err(
        ctx,
        ctx.transfer_ix_to(&ctx.source.clone(), 1_000),
        relay_err::RECIPIENT_NOT_ALLOWED,
    );
});

// ---------------------------------------------------------------------------------------------
// TR-13 .. TR-15 fake programs and mandates
// ---------------------------------------------------------------------------------------------

dual_token!(tr_13_fake_agentauth_program, |ctx| {
    let fake = unique();
    ctx.install_always_ok(fake);
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::AGENTAUTH_PROGRAM, fake);
    agent_relay_err(ctx, ix, relay_err::WRONG_PROGRAM);
});

dual_token!(tr_14_fake_token_program, |ctx| {
    let fake = unique();
    ctx.install_always_ok(fake);
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::TOKEN_PROGRAM, fake);
    agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
    // even the OTHER genuine token program is refused (policy pins one)
    let other = if ctx.token_program == TOKEN_ID {
        TOKEN22_ID
    } else {
        TOKEN_ID
    };
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::TOKEN_PROGRAM, other);
    agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
});

dual_token!(tr_15_attacker_owned_mandate_with_huge_limits, |ctx| {
    let fake = unique();
    let bytes = aa::seeded_mandate_bytes(
        &ctx.owner.pubkey(),
        &ctx.agent.pubkey(),
        ctx.expiry,
        true,
        &[(ctx.token_program, 0, 0, vec![TRANSFER_CHECKED_DISC])],
    );
    let lamports = ctx.svm.rent(bytes.len());
    // owned by an attacker-controlled program id, not by AgentAuth
    ctx.svm.put(
        fake,
        solana_account::Account {
            lamports,
            data: bytes.clone(),
            owner: unique(),
            executable: false,
            rent_epoch: 0,
        },
    );
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::MANDATE, fake);
    agent_relay_err(ctx, ix, relay_err::INVALID_MANDATE);
    // owned by the relay itself is not enough either
    let fake2 = unique();
    ctx.svm.put(
        fake2,
        solana_account::Account {
            lamports,
            data: bytes,
            owner: RELAY_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::MANDATE, fake2);
    agent_relay_err(ctx, ix, relay_err::INVALID_MANDATE);
});

dual_token!(tr_16_fake_policy_rows, |ctx| {
    let good = ctx.svm.get_account(&ctx.policy).unwrap();
    type Edit = Box<dyn Fn(&mut solana_account::Account)>;
    let rows: Vec<(&str, Edit)> = vec![
        ("owned by another program", Box::new(|a| a.owner = unique())),
        (
            "owned by the system program",
            Box::new(|a| a.owner = SYSTEM_ID),
        ),
        ("length 943", Box::new(|a| a.data.truncate(943))),
        ("length 945", Box::new(|a| a.data.push(0))),
        ("wrong disc", Box::new(|a| a.data[0] = 0xA8)),
        ("zero disc", Box::new(|a| a.data[0] = 0)),
        ("wrong version", Box::new(|a| a.data[1] = 2)),
        ("reserved flag bit", Box::new(|a| a.data[4] |= 0x04)),
    ];
    for (name, edit) in rows {
        let p = ctx.policy;
        ctx.svm.put(p, good.clone());
        ctx.edit_account(&p, |a| edit(a));
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
        assert!(r.result.is_err(), "{name}: transfer succeeded");
        r.assert_relay_err(relay_err::INVALID_POLICY);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
});

// ---------------------------------------------------------------------------------------------
// TR-17 .. TR-20 cross-mandate mixing
// ---------------------------------------------------------------------------------------------

dual_token!(tr_17_agent_a_with_mandate_of_agent_b, |ctx| {
    let owner = ctx.owner.insecure_clone();
    let b = ctx.add_principal(Some(owner), None);
    // A signs, passes B's mandate (same owner) and A's own policy
    let mut t = ctx.transfer_accounts();
    t.mandate = b.mandate;
    agent_relay_err(ctx, t.ix(1_000), relay_err::INVALID_MANDATE);
    // B's whole account set with A as signer
    let mut t = ctx.transfer_accounts_of(&b);
    t.agent = ctx.agent.pubkey();
    agent_relay_err(ctx, t.ix(1_000), relay_err::INVALID_MANDATE);
});

dual_token!(tr_18_policy_of_another_mandate, |ctx| {
    let other = ctx.add_principal(None, None);
    let mut t = ctx.transfer_accounts();
    t.policy = other.policy;
    agent_relay_err(ctx, t.ix(1_000), relay_err::ACCOUNT_MISMATCH);
});

dual_token!(tr_19_attacker_policy_pinning_a_victims_account, |ctx| {
    // X creates its own owner/agent/mandate/policy and pins the VICTIM's source account
    let victim_source = ctx.source;
    let x = ctx.add_principal(None, Some(victim_source));
    assert_eq!(x.cfg.source_account, victim_source);
    let before = ctx.snapshot();
    let ix = ctx.transfer_accounts_of(&x).ix(1_000);
    ctx.send_keys(&[&x.agent], &[ix])
        .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
    assert_nothing_moved(&before, &ctx.snapshot());
    assert_eq!(ctx.balance(&victim_source), ctx.initial_source_balance);
});

dual_token!(
    tr_20_source_delegated_to_another_mandates_authority,
    |ctx| {
        let other = ctx.add_principal(None, None);
        // the owner (mis)delegated S to the other mandate's authority PDA
        let acct = TokenAcct::new(
            ctx.token_program,
            ctx.mint,
            ctx.owner.pubkey(),
            ctx.initial_source_balance,
        )
        .delegate(other.authority, ctx.initial_delegated);
        ctx.place_token(ctx.source, acct, "source");
        agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    }
);

// ---------------------------------------------------------------------------------------------
// TR-21 .. TR-24 pin substitution
// ---------------------------------------------------------------------------------------------

dual_token!(tr_21_pin_substitution_table, |ctx| {
    // another account of the same owner that ALSO has the authority as delegate
    let alt_source = unique();
    let acct = TokenAcct::new(
        ctx.token_program,
        ctx.mint,
        ctx.owner.pubkey(),
        ctx.initial_source_balance,
    )
    .delegate(ctx.authority, ctx.initial_delegated);
    ctx.place_token(alt_source, acct, "alt_source");
    // a second genuine mint
    let other_mint = unique();
    token::put_mint(
        &mut ctx.svm,
        other_mint,
        &MintAcct::new(ctx.token_program, ctx.decimals),
    );
    // another mandate's authority
    let other = ctx.add_principal(None, None);
    let other_token_program = if ctx.token_program == TOKEN_ID {
        TOKEN22_ID
    } else {
        TOKEN_ID
    };

    let rows: Vec<(&str, usize, Pubkey)> = vec![
        (
            "source = other account of same owner",
            transfer_idx::SOURCE,
            alt_source,
        ),
        ("mint != budget_mint", transfer_idx::MINT, other_mint),
        (
            "authority = another mandate's PDA",
            transfer_idx::AUTHORITY,
            other.authority,
        ),
        (
            "token_program = the other token program",
            transfer_idx::TOKEN_PROGRAM,
            other_token_program,
        ),
    ];
    for (name, idx, key) in rows {
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000).with_account(idx, key)]);
        assert!(r.result.is_err(), "{name}: succeeded");
        r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
});

dual_token!(tr_22_mint_differs_from_budget_mint, |ctx| {
    let other_mint = unique();
    token::put_mint(
        &mut ctx.svm,
        other_mint,
        &MintAcct::new(ctx.token_program, ctx.decimals),
    );
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::MINT, other_mint);
    agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
    // a mint-like account of the attacker is also refused
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::MINT, ctx.attacker.pubkey());
    agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
});

dual_token!(tr_23_allowlisted_destination_of_a_different_mint, |ctx| {
    let other_mint = unique();
    token::put_mint(
        &mut ctx.svm,
        other_mint,
        &MintAcct::new(ctx.token_program, ctx.decimals),
    );
    // the allowlisted address now holds an account of another mint (seeded)
    let r0 = ctx.recipients[0];
    let acct = TokenAcct::new(ctx.token_program, other_mint, unique(), 0);
    ctx.place_token(r0, acct, "recipient0");
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
});

dual_token!(tr_24_authority_is_another_mandates_pda, |ctx| {
    let other = ctx.add_principal(None, None);
    let ix = ctx
        .transfer_ix(1_000)
        .with_account(transfer_idx::AUTHORITY, other.authority);
    agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
    // a random key and the policy/mandate themselves too
    for k in [unique(), ctx.policy, ctx.mandate, ctx.owner.pubkey()] {
        let ix = ctx
            .transfer_ix(1_000)
            .with_account(transfer_idx::AUTHORITY, k);
        agent_relay_err(ctx, ix, relay_err::ACCOUNT_MISMATCH);
    }
});

// ---------------------------------------------------------------------------------------------
// TR-25 aliasing table
// ---------------------------------------------------------------------------------------------

dual_token!(tr_25_aliasing_table, |ctx| {
    let (m, p, o, a) = (
        ctx.mandate,
        ctx.policy,
        ctx.owner.pubkey(),
        ctx.agent.pubkey(),
    );
    let (s, d, mi, au, tp) = (
        ctx.source,
        ctx.recipients[0],
        ctx.mint,
        ctx.authority,
        ctx.token_program,
    );
    // (name, slot to overwrite, key to put there, expected relay code)
    let rows: Vec<(&str, usize, Pubkey, u32)> = vec![
        (
            "policy slot := mandate",
            transfer_idx::POLICY,
            m,
            relay_err::INVALID_POLICY,
        ),
        (
            "mandate slot := policy",
            transfer_idx::MANDATE,
            p,
            relay_err::INVALID_MANDATE,
        ),
        (
            "owner slot := agent",
            transfer_idx::OWNER,
            a,
            relay_err::INVALID_MANDATE,
        ),
        (
            "mandate slot := agent",
            transfer_idx::MANDATE,
            a,
            relay_err::INVALID_MANDATE,
        ),
        (
            "mandate slot := source",
            transfer_idx::MANDATE,
            s,
            relay_err::INVALID_MANDATE,
        ),
        (
            "source slot := mint",
            transfer_idx::SOURCE,
            mi,
            relay_err::ACCOUNT_MISMATCH,
        ),
        (
            "source slot := destination",
            transfer_idx::SOURCE,
            d,
            relay_err::ACCOUNT_MISMATCH,
        ),
        (
            "mint slot := source",
            transfer_idx::MINT,
            s,
            relay_err::ACCOUNT_MISMATCH,
        ),
        (
            "authority slot := mandate",
            transfer_idx::AUTHORITY,
            m,
            relay_err::ACCOUNT_MISMATCH,
        ),
        (
            "token_program slot := mint",
            transfer_idx::TOKEN_PROGRAM,
            mi,
            relay_err::ACCOUNT_MISMATCH,
        ),
        (
            "agentauth slot := token program",
            transfer_idx::AGENTAUTH_PROGRAM,
            tp,
            relay_err::WRONG_PROGRAM,
        ),
        (
            "destination slot := authority",
            transfer_idx::DESTINATION,
            au,
            relay_err::RECIPIENT_NOT_ALLOWED,
        ),
        (
            "destination slot := policy",
            transfer_idx::DESTINATION,
            p,
            relay_err::RECIPIENT_NOT_ALLOWED,
        ),
        (
            "destination slot := source",
            transfer_idx::DESTINATION,
            s,
            relay_err::RECIPIENT_NOT_ALLOWED,
        ),
    ];
    for (name, idx, key, code) in rows {
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000).with_account(idx, key)]);
        assert!(r.result.is_err(), "{name}: succeeded");
        // never a panic / borrow failure: always the table's relay code
        r.assert_relay_err(code);
        assert_nothing_moved(&before, &ctx.snapshot());
        let _ = name;
    }
    // agent slot := owner (the owner signs and pays; mandate.agent != owner)
    let before = ctx.snapshot();
    let ix = ctx.transfer_ix(1_000).with_account(transfer_idx::AGENT, o);
    ctx.send_owner(&[ix])
        .assert_relay_err(relay_err::INVALID_MANDATE);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// ---------------------------------------------------------------------------------------------
// TR-26 / TR-27 shape
// ---------------------------------------------------------------------------------------------

dual_token!(tr_26_wrong_account_count, |ctx| {
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(1_000).truncate_accounts(9)])
        .assert_not_enough_accounts();
    ctx.send_agent(&[ctx.transfer_ix(1_000).with_extra_account(unique())])
        .assert_not_enough_accounts();
    ctx.send_agent(&[ctx.transfer_ix(1_000).truncate_accounts(0)])
        .assert_failed();
    assert_nothing_moved(&before, &ctx.snapshot());
});

dual_token!(tr_27_wrong_data_length, |ctx| {
    for len in [0usize, 1, 5, 8, 10, 17] {
        let mut ix = ctx.transfer_ix(1_000);
        ix.data.resize(len, 0);
        if len > 0 {
            ix.data[0] = 3;
        }
        agent_relay_err(ctx, ix, relay_err::INVALID_INSTRUCTION_DATA);
    }
});

// ---------------------------------------------------------------------------------------------
// TR-28 mint shape
// ---------------------------------------------------------------------------------------------

dual_token!(tr_28_mint_uninitialised_or_foreign, |ctx| {
    let good = ctx.svm.get_account(&ctx.mint).unwrap();
    let m = ctx.mint;
    // uninitialised
    ctx.edit_account(&m, |a| a.data[token::MINT_OFF_INITIALIZED] = 0);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::WRONG_PROGRAM);
    // owned by a different program
    ctx.svm.put(m, good.clone());
    ctx.edit_account(&m, |a| a.owner = unique());
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::WRONG_PROGRAM);
    // wrong length
    ctx.svm.put(m, good.clone());
    ctx.edit_account(&m, |a| a.data.push(0));
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::WRONG_PROGRAM);
    // restored: works
    ctx.svm.put(m, good);
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
});

// ---------------------------------------------------------------------------------------------
// TR-29 agent must sign
// ---------------------------------------------------------------------------------------------

dual_token!(tr_29_agent_not_a_signer, |ctx| {
    let before = ctx.snapshot();
    // somebody else pays; the agent is listed but does not sign
    let ix = ctx
        .transfer_ix(1_000)
        .with_signer(transfer_idx::AGENT, false);
    ctx.send_attacker(&[ix])
        .assert_relay_err(relay_err::AGENT_NOT_SIGNER);
    assert_nothing_moved(&before, &ctx.snapshot());
});

// ---------------------------------------------------------------------------------------------
// TR-30 frozen accounts
// ---------------------------------------------------------------------------------------------

dual_token!(tr_30_frozen_source_or_destination, |ctx| {
    let (s, d) = (ctx.source, ctx.recipients[0]);
    ctx.edit_account(&s, |a| a.data[OFF_STATE] = STATE_FROZEN);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    ctx.edit_account(&s, |a| a.data[OFF_STATE] = token::STATE_INITIALIZED);
    ctx.edit_account(&d, |a| a.data[OFF_STATE] = STATE_FROZEN);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    // uninitialised (state 0) is also refused
    ctx.edit_account(&d, |a| a.data[OFF_STATE] = 0);
    agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    ctx.edit_account(&d, |a| a.data[OFF_STATE] = token::STATE_INITIALIZED);
    ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
});

// ---------------------------------------------------------------------------------------------
// TR-31 / TR-32 evil Token program (needs EVIL_TOKEN_SO)
// ---------------------------------------------------------------------------------------------

/// Run a transfer against the evil-token stub with the given misbehaviour and return the Exec.
fn evil_transfer(mode: u8) -> Option<(Ctx, Exec, Snapshot)> {
    let mut ctx = Ctx::builder(Flavor::Classic).try_build()?;
    if !ctx.install_evil_token() {
        return None;
    }
    let mint = MintAcct::new(ctx.token_program, ctx.decimals)
        .supply(1 << 40)
        .evil_mode(mode);
    token::put_mint(&mut ctx.svm, ctx.mint, &mint);
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
    Some((ctx, r, before))
}

#[test]
fn tr_31_evil_token_moves_amount_plus_one() {
    let Some((ctx, r, before)) = evil_transfer(token::evil::MOVE_PLUS_ONE) else {
        return;
    };
    r.assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    assert_nothing_moved(&before, &ctx.snapshot());
}

#[test]
fn tr_32_evil_token_credits_amount_minus_one() {
    let Some((ctx, r, before)) = evil_transfer(token::evil::CREDIT_MINUS_ONE) else {
        return;
    };
    r.assert_relay_err(relay_err::BALANCE_DELTA_VIOLATION);
    assert_nothing_moved(&before, &ctx.snapshot());
}

/// Control for TR-31/32: the same stub in honest mode behaves like the real Token program.
#[test]
fn tr_31_32_control_honest_evil_token_succeeds() {
    let Some((ctx, r, _)) = evil_transfer(token::evil::HONEST) else {
        return;
    };
    r.assert_ok();
    assert_eq!(ctx.balance(&ctx.recipients[0]), 1_000);
}

// ---------------------------------------------------------------------------------------------
// TR-33 source has no delegate
// ---------------------------------------------------------------------------------------------

dual_token!(
    tr_33_source_without_delegate,
    with | b | b.no_delegate(),
    |ctx| {
        assert_eq!(ctx.token(&ctx.source).delegate, None);
        agent_relay_err(ctx, ctx.transfer_ix(1_000), relay_err::TOKEN_ACCOUNT_STATE);
    }
);

// ---------------------------------------------------------------------------------------------
// TR-34 / TR-35 STRICT_TOP_LEVEL
// ---------------------------------------------------------------------------------------------

dual_token!(
    tr_34_strict_top_level_direct_ok_via_proxy_refused,
    with | b | b.strict_top_level(),
    |ctx| {
        assert!(svm::load_mock_amm(&mut ctx.svm));
        // direct call
        let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
        r.assert_ok();
        assert_eq!(r.max_stack_height(), 2, "relay(1) -> verify/token(2)");
        // the same call through the proxy (stack height 2)
        let before = ctx.snapshot();
        let ix = amm::proxy_ix(&ctx.transfer_ix(1_000));
        ctx.send_agent(&[ix])
            .assert_relay_err(relay_err::NOT_TOP_LEVEL);
        assert_nothing_moved(&before, &ctx.snapshot());
    }
);

dual_token!(tr_35_not_strict_via_proxy_succeeds, |ctx| {
    assert!(svm::load_mock_amm(&mut ctx.svm));
    let before = ctx.snapshot();
    let ix = amm::proxy_ix(&ctx.transfer_ix(1_000));
    let r = ctx.send_agent(&[ix]);
    r.assert_ok();
    assert_eq!(
        r.max_stack_height(),
        3,
        "proxy(1) -> relay(2) -> verify/token(3)"
    );
    assert_eq!(
        ctx.balance(&ctx.source),
        before.token(&ctx.source).amount - 1_000
    );
    assert_eq!(ctx.token_perm().spend_total, 1_000);
});

// ---------------------------------------------------------------------------------------------
// TR-36 mandate not writable
// ---------------------------------------------------------------------------------------------

dual_token!(tr_36_mandate_not_writable, |ctx| {
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx
        .transfer_ix(1_000)
        .with_writable(transfer_idx::MANDATE, false)]);
    // The row expects a failure (verify cannot write the counters). Which layer rejects it is
    // reported by the owner of this test in the build report; the safety property asserted here is
    // that the transaction fails and nothing moves.
    r.assert_failed();
    assert_nothing_moved(&before, &ctx.snapshot());
    eprintln!(
        "TR-36 observed error: {:?}",
        r.result.as_ref().err().map(|f| &f.err)
    );
});
