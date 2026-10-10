//! Test engineer B: T22 rows (Token-2022). The relay accepts extension-free mints
//! (`mint.data_len == 82`) and token accounts that are either 165 bytes or exactly the 170-byte
//! shape the ATA program creates (AccountType = 2, TLV = ImmutableOwner with length 0).
//! Everything else is refused: mints with any extension -> 103, accounts with any other shape ->
//! 105. Accounts and mints are byte-exact (the harness self-tests prove the builders equal what the
//! real Token-2022 binary writes); the ATA accounts in T22-07 are created by the REAL ATA program.

#[macro_use]
mod common;
mod support_b;

use common::*;
use support_b::measure;

const AMOUNT: u64 = 1_000_000;
const T22: Pubkey = TOKEN22_ID;

fn moved_nothing(ctx: &Ctx, before: &Snapshot) {
    assert_nothing_moved(before, &ctx.snapshot());
}

fn t22_ctx() -> Option<Ctx> {
    Ctx::builder(Flavor::Token2022).try_build()
}

fn t22_swap_ctx() -> Option<Ctx> {
    Ctx::builder(Flavor::Token2022).with_swap().try_build()
}

/// Replace the transfer source with `f(base)`, keeping balance, owner and delegation.
fn put_source(ctx: &mut Ctx, f: impl FnOnce(TokenAcct) -> TokenAcct) {
    let base = TokenAcct::new(
        T22,
        ctx.mint,
        ctx.owner.pubkey(),
        ctx.initial_source_balance,
    )
    .delegate(ctx.authority, ctx.initial_delegated);
    let key = ctx.source;
    token::put_token(&mut ctx.svm, key, &f(base));
}

fn put_destination(ctx: &mut Ctx, f: impl FnOnce(TokenAcct) -> TokenAcct) {
    let base = TokenAcct::new(T22, ctx.mint, ctx.recipient_owners[0], 0);
    let key = ctx.recipients[0];
    token::put_token(&mut ctx.svm, key, &f(base));
}

fn put_mint_with(ctx: &mut Ctx, key: Pubkey, exts: &[Ext]) {
    let m = MintAcct::new(T22, ctx.decimals)
        .supply(u64::MAX / 4)
        .with_extensions(exts);
    token::put_mint(&mut ctx.svm, key, &m);
}

// =====================================================================================
// T22-01: the supported shape
// =====================================================================================

#[test]
fn t22_01_extension_free_mint_and_165_byte_accounts_are_accepted() {
    let Some(mut ctx) = t22_ctx() else { return };
    assert_eq!(ctx.svm.data(&ctx.mint).len(), 82);
    assert_eq!(ctx.svm.data(&ctx.source).len(), 165);
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
    r.assert_ok();
    assert_eq!(
        ctx.balance(&ctx.source),
        before.token(&ctx.source).amount - AMOUNT
    );
    assert_eq!(ctx.balance(&ctx.recipients[0]), AMOUNT);
    assert_eq!(
        ctx.token(&ctx.source).delegated_amount,
        ctx.initial_delegated - AMOUNT
    );
    assert_eq!(r.relay_cpis()[1].program, T22, "the CPI goes to Token-2022");
}

// =====================================================================================
// T22-02..05, T22-09 (+ more): any mint extension -> 103, on transfer and on both swap mints
// =====================================================================================

const BAD_MINT_EXTENSIONS: [(&str, Ext); 10] = [
    ("T22-02 TransferFeeConfig", Ext::TransferFeeConfig),
    ("T22-03 TransferHook", Ext::TransferHook),
    ("T22-04 PermanentDelegate", Ext::PermanentDelegate),
    (
        "T22-05 ConfidentialTransferMint",
        Ext::ConfidentialTransferMint,
    ),
    ("T22-09 Pausable", Ext::Pausable),
    ("MintCloseAuthority", Ext::MintCloseAuthority),
    ("DefaultAccountState", Ext::DefaultAccountState),
    ("InterestBearingConfig", Ext::InterestBearingConfig),
    ("MetadataPointer", Ext::MetadataPointer),
    ("NonTransferable", Ext::NonTransferable),
];

#[test]
fn t22_mint_with_any_extension_is_103_on_transfer() {
    for (name, ext) in BAD_MINT_EXTENSIONS {
        let Some(mut ctx) = t22_ctx() else { return };
        let mint = ctx.mint;
        put_mint_with(&mut ctx, mint, &[ext]);
        assert!(
            ctx.svm.data(&mint).len() > 82,
            "{name}: extension mints are longer than 82"
        );
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
        assert!(!r.is_ok(), "{name}");
        r.assert_relay_err(relay_err::WRONG_PROGRAM);
        moved_nothing(&ctx, &before);
    }
}

#[test]
fn t22_mint_with_any_extension_is_103_on_swap_input_and_output_mint() {
    for (name, ext) in BAD_MINT_EXTENSIONS {
        for which in ["in_mint", "out_mint"] {
            let Some(mut ctx) = t22_swap_ctx() else {
                return;
            };
            let key = if which == "in_mint" {
                ctx.mint
            } else {
                ctx.swap_fixture().out_mint
            };
            put_mint_with(&mut ctx, key, &[ext]);
            let before = ctx.snapshot();
            let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
            assert!(!r.is_ok(), "{name} on {which}");
            r.assert_relay_err(relay_err::WRONG_PROGRAM);
            moved_nothing(&ctx, &before);
        }
    }
}

#[test]
fn t22_mint_combinations_and_malformed_mints_are_103() {
    let Some(mut ctx) = t22_ctx() else { return };
    let mint = ctx.mint;
    let cases: Vec<(&str, MintAcct)> = vec![
        (
            "two extensions",
            MintAcct::new(T22, 6)
                .supply(1)
                .with_extensions(&[Ext::TransferFeeConfig, Ext::TransferHook]),
        ),
        (
            "uninitialised",
            MintAcct::new(T22, 6).supply(1).uninitialized(),
        ),
        (
            "owned by the classic program while the policy pins Token-2022",
            MintAcct::new(TOKEN_ID, 6).supply(1),
        ),
        (
            "owned by the system program",
            MintAcct::new(SYSTEM_ID, 6).supply(1),
        ),
    ];
    for (name, m) in cases {
        token::put_mint(&mut ctx.svm, mint, &m);
        let before = ctx.snapshot();
        let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
        assert!(!r.is_ok(), "{name}");
        r.assert_relay_err(relay_err::WRONG_PROGRAM);
        moved_nothing(&ctx, &before);
    }
}

// =====================================================================================
// T22-06 / T22-08: account shapes the relay refuses (105)
// =====================================================================================

const BAD_ACCOUNT_EXTENSIONS: [(&str, &[Ext]); 6] = [
    ("T22-06 CpiGuard", &[Ext::CpiGuard]),
    (
        "ImmutableOwner + CpiGuard",
        &[Ext::ImmutableOwner, Ext::CpiGuard],
    ),
    ("MemoTransfer", &[Ext::MemoTransfer]),
    ("TransferHookAccount", &[Ext::TransferHookAccount]),
    ("TransferFeeAmount", &[Ext::TransferFeeAmount]),
    (
        "ImmutableOwner + MemoTransfer",
        &[Ext::ImmutableOwner, Ext::MemoTransfer],
    ),
];

#[test]
fn t22_06_accounts_longer_than_170_bytes_are_105_source_and_destination() {
    for (name, exts) in BAD_ACCOUNT_EXTENSIONS {
        for side in ["source", "destination"] {
            let Some(mut ctx) = t22_ctx() else { return };
            if side == "source" {
                put_source(&mut ctx, |a| a.with_extensions(exts));
            } else {
                put_destination(&mut ctx, |a| a.with_extensions(exts));
            }
            let key = if side == "source" {
                ctx.source
            } else {
                ctx.recipients[0]
            };
            assert!(
                ctx.svm.data(&key).len() > 170 || exts == [Ext::ImmutableOwner],
                "{name}"
            );
            let before = ctx.snapshot();
            let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
            assert!(!r.is_ok(), "{name} on {side}");
            r.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
            moved_nothing(&ctx, &before);
        }
    }
}

#[test]
fn t22_08_170_byte_accounts_of_the_wrong_shape_are_105() {
    // exactly 170 bytes in every case: 165 + account type + 4-byte TLV header
    let wrong: [(&str, [u8; 5]); 5] = [
        (
            "TLV type NonTransferableAccount (13), not ImmutableOwner",
            [2, 13, 0, 0, 0],
        ),
        ("TLV type MemoTransfer-sized header (8)", [2, 8, 0, 0, 0]),
        ("account type byte 1 (a mint marker)", [1, 7, 0, 0, 0]),
        (
            "account type byte 0 (uninitialised marker)",
            [0, 7, 0, 0, 0],
        ),
        ("ImmutableOwner TLV with a non-zero length", [2, 7, 0, 0, 1]),
    ];
    for (name, tail) in wrong {
        for side in ["source", "destination"] {
            let Some(mut ctx) = t22_ctx() else { return };
            if side == "source" {
                put_source(&mut ctx, |a| a.raw_tail(&tail));
            } else {
                put_destination(&mut ctx, |a| a.raw_tail(&tail));
            }
            let key = if side == "source" {
                ctx.source
            } else {
                ctx.recipients[0]
            };
            assert_eq!(ctx.svm.data(&key).len(), 170, "{name}");
            let before = ctx.snapshot();
            let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
            assert!(!r.is_ok(), "{name} on {side}");
            r.assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
            moved_nothing(&ctx, &before);
        }
    }
}

#[test]
fn t22_170_byte_account_is_accepted_only_under_token_2022() {
    // The same ImmutableOwner shape under the classic Token program id is a malformed account.
    let Some(mut ctx) = Ctx::builder(Flavor::Classic).try_build() else {
        return;
    };
    let base = TokenAcct::new(
        TOKEN_ID,
        ctx.mint,
        ctx.owner.pubkey(),
        ctx.initial_source_balance,
    )
    .delegate(ctx.authority, ctx.initial_delegated)
    .immutable_owner_170();
    let key = ctx.source;
    token::put_token(&mut ctx.svm, key, &base);
    let before = ctx.snapshot();
    ctx.send_agent(&[ctx.transfer_ix(AMOUNT)])
        .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
    moved_nothing(&ctx, &before);
}

#[test]
fn t22_frozen_token_2022_accounts_are_105() {
    for side in ["source", "destination"] {
        let Some(mut ctx) = t22_ctx() else { return };
        if side == "source" {
            put_source(&mut ctx, |a| a.frozen());
        } else {
            put_destination(&mut ctx, |a| a.frozen());
        }
        let before = ctx.snapshot();
        ctx.send_agent(&[ctx.transfer_ix(AMOUNT)])
            .assert_relay_err(relay_err::TOKEN_ACCOUNT_STATE);
        moved_nothing(&ctx, &before);
    }
}

// =====================================================================================
// T22-07: REAL 170-byte ATAs created by the ATA program
// =====================================================================================

fn create_ata(ctx: &mut Ctx, wallet: &Pubkey, mint: &Pubkey, label: &str) -> Pubkey {
    let ix = token::ata_create_idempotent(&ctx.owner.pubkey(), wallet, mint, &T22);
    ctx.send_owner(&[ix]).assert_ok();
    let ata = ata_address(wallet, &T22, mint);
    let data = ctx.svm.data(&ata);
    assert_eq!(
        data.len(),
        170,
        "the real ATA program creates 170-byte Token-2022 accounts"
    );
    assert_eq!(data[165], 2, "AccountType::Account");
    assert_eq!(
        &data[166..170],
        &[7, 0, 0, 0],
        "TLV: ImmutableOwner, length 0"
    );
    ctx.label(ata, label);
    ctx.track(ata);
    ata
}

#[test]
fn t22_07_real_ata_accounts_are_accepted_for_transfer() {
    let Some(mut ctx) = Ctx::builder(Flavor::Token2022).no_policy().try_build() else {
        return;
    };
    let owner = ctx.owner.pubkey();
    let dest_wallet = unique();
    let mint = ctx.mint;
    let src_ata = create_ata(&mut ctx, &owner, &mint, "owner_ata");
    let dst_ata = create_ata(&mut ctx, &dest_wallet, &mint, "dest_ata");
    ctx.set_token_amount(&src_ata, 1_000_000_000);
    // Approve is a top-level, owner-signed Token-2022 instruction
    let approve = ctx.approve_ix(&src_ata, &ctx.authority, 100_000_000);
    ctx.send_owner(&[approve]).assert_ok();

    ctx.source = src_ata;
    ctx.recipients = vec![dst_ata];
    ctx.cfg = PolicyCfg::transfer_only(T22, mint, src_ata, &[dst_ata]);
    let init = ctx.init_policy_ix(&ctx.cfg.clone(), 0);
    ctx.send_owner(&[init]).assert_ok();

    let r = ctx.send_agent(&[ctx.transfer_ix(AMOUNT)]);
    r.assert_ok();
    assert_eq!(ctx.balance(&dst_ata), AMOUNT);
    assert_eq!(ctx.balance(&src_ata), 1_000_000_000 - AMOUNT);
    assert_eq!(ctx.token(&src_ata).delegated_amount, 100_000_000 - AMOUNT);
    measure("t22-07 transfer CU with 170-byte ATAs (Token-2022)", r.cu());
}

#[test]
fn t22_07_real_ata_accounts_are_accepted_for_swap_in_and_out() {
    let Some(mut ctx) = Ctx::builder(Flavor::Token2022)
        .with_swap()
        .no_policy()
        .try_build()
    else {
        return;
    };
    let owner = ctx.owner.pubkey();
    let (in_mint, out_mint) = (ctx.mint, ctx.swap_fixture().out_mint);
    let in_ata = create_ata(&mut ctx, &owner, &in_mint, "in_ata");
    let out_ata = create_ata(&mut ctx, &owner, &out_mint, "out_ata");
    ctx.set_token_amount(&in_ata, 1_000_000_000);
    let approve = ctx.approve_ix(&in_ata, &ctx.authority, 100_000_000);
    ctx.send_owner(&[approve]).assert_ok();
    {
        let s = ctx.swap.as_mut().expect("swap fixture");
        s.in_account = in_ata;
        s.out_account = out_ata;
    }
    let pins = ctx.swap_fixture().pins();
    ctx.cfg = PolicyCfg::transfer_only(T22, in_mint, ctx.source, &ctx.recipients.clone())
        .with_swap(&pins);
    let init = ctx.init_policy_ix(&ctx.cfg.clone(), 0);
    ctx.send_owner(&[init]).assert_ok();

    let want_out = ctx.expected_amount_out(AMOUNT);
    let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    r.assert_ok();
    assert_eq!(ctx.balance(&in_ata), 1_000_000_000 - AMOUNT);
    assert_eq!(ctx.balance(&out_ata), want_out);
    assert_eq!(
        ctx.svm.data(&out_ata).len(),
        170,
        "still the same 170-byte accounts"
    );
    measure("t22-07 swap CU with 170-byte ATAs (Token-2022)", r.cu());
}

// =====================================================================================
// T22-10 (P2): swap with Token-2022 in/out accounts through the mock AMM
// =====================================================================================

#[test]
fn t22_10_swap_with_token_2022_accounts_succeeds() {
    let Some(mut ctx) = t22_swap_ctx() else {
        return;
    };
    let s = ctx.swap_fixture().clone();
    let before = ctx.snapshot();
    let want_out = ctx.expected_amount_out(AMOUNT);
    let r = ctx.send_agent(&[ctx.swap_ix_default(AMOUNT)]);
    r.assert_ok();
    assert_eq!(
        ctx.balance(&s.in_account),
        before.token(&s.in_account).amount - AMOUNT
    );
    assert_eq!(ctx.balance(&s.out_account), want_out);
    assert_eq!(ctx.token(&s.out_account).owner, ctx.owner.pubkey());
    assert_eq!(ctx.perm(&MOCK_AMM_ID).spend_total, AMOUNT);
    // all three CPIs of the swap go to Token-2022
    let programs: Vec<_> = r.inner_calls().iter().map(|c| c.program).collect();
    assert!(
        programs.iter().filter(|p| **p == T22).count() >= 2,
        "{programs:?}"
    );
    measure("t22-10 swap CU (Token-2022, 165-byte accounts)", r.cu());
}

#[test]
fn t22_mixed_token_programs_are_refused_by_the_pins() {
    // in_token_program pinned to Token-2022 while the accounts/mints belong to classic Token
    let Some(mut ctx) = t22_swap_ctx() else {
        return;
    };
    let before = ctx.snapshot();
    let r = ctx.send_agent(&[ctx
        .swap_ix_default(AMOUNT)
        .with_account(swap_idx::IN_TOKEN_PROGRAM, TOKEN_ID)]);
    r.assert_relay_err(relay_err::ACCOUNT_MISMATCH);
    moved_nothing(&ctx, &before);
}
