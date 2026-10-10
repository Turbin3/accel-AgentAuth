//! Proof that the byte-exact token builders equal what the REAL Token / p-token / Token-2022
//! binaries write. Needs no AgentAuth or relay binary.

use super::*;
use solana_account::Account;

fn blank(svm: &mut litesvm::LiteSVM, key: Pubkey, len: usize, program: Pubkey) {
    let lamports = svm.rent(len);
    svm.put(
        key,
        Account {
            lamports,
            data: vec![0u8; len],
            owner: program,
            executable: false,
            rent_epoch: 0,
        },
    );
}

fn init_mint2(
    tp: &Pubkey,
    mint: &Pubkey,
    decimals: u8,
    auth: &Pubkey,
    freeze: &Pubkey,
) -> Instruction {
    let mut d = vec![20u8, decimals];
    d.extend_from_slice(auth.as_ref());
    d.push(1);
    d.extend_from_slice(freeze.as_ref());
    Instruction::new_with_bytes(*tp, &d, vec![AccountMeta::new(*mint, false)])
}

fn init_account3(tp: &Pubkey, account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut d = vec![18u8];
    d.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(
        *tp,
        &d,
        vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
        ],
    )
}

fn mint_to(tp: &Pubkey, mint: &Pubkey, dest: &Pubkey, auth: &Pubkey, amount: u64) -> Instruction {
    let mut d = vec![7u8];
    d.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        *tp,
        &d,
        vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*auth, true),
        ],
    )
}

fn freeze(tp: &Pubkey, account: &Pubkey, mint: &Pubkey, auth: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        *tp,
        &[10u8],
        vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*auth, true),
        ],
    )
}

fn run(svm: &mut litesvm::LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    send_keys(svm, &signers, ixs).assert_ok();
}

fn assert_bytes_eq(what: &str, got: &[u8], want: &[u8]) {
    assert_eq!(got.len(), want.len(), "{what}: length differs");
    if let Some(i) = (0..got.len()).find(|&i| got[i] != want[i]) {
        panic!(
            "{what}: first differing byte at offset {i}: real program wrote 0x{:02x}, builder wrote 0x{:02x}",
            got[i], want[i]
        );
    }
}

fn builders_equal_real_programs(flavor: Flavor) {
    let mut svm = new_svm(flavor);
    let tp = flavor.token_program();
    let payer = Keypair::new();
    let mint_auth = Keypair::new();
    let freeze_auth = Keypair::new();
    let owner = Keypair::new();
    let delegate = Keypair::new();
    let close_auth = Pubkey::new_unique();
    for k in [&payer, &delegate] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = Pubkey::new_unique();
    let acct = Pubkey::new_unique();
    let acct2 = Pubkey::new_unique();

    // --- mint
    blank(&mut svm, mint, 82, tp);
    run(
        &mut svm,
        &payer,
        &[],
        &[init_mint2(
            &tp,
            &mint,
            6,
            &mint_auth.pubkey(),
            &freeze_auth.pubkey(),
        )],
    );
    let want = MintAcct::new(tp, 6)
        .mint_authority(mint_auth.pubkey())
        .freeze_authority(freeze_auth.pubkey());
    assert_bytes_eq("fresh mint", &svm.data(&mint), &want.data());

    // --- fresh account
    blank(&mut svm, acct, 165, tp);
    blank(&mut svm, acct2, 165, tp);
    run(
        &mut svm,
        &payer,
        &[],
        &[
            init_account3(&tp, &acct, &mint, &owner.pubkey()),
            init_account3(&tp, &acct2, &mint, &Pubkey::new_unique()),
        ],
    );
    assert_bytes_eq(
        "fresh account",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 0).data(),
    );

    // --- amount + supply
    run(
        &mut svm,
        &payer,
        &[&mint_auth],
        &[mint_to(&tp, &mint, &acct, &mint_auth.pubkey(), 1_000_000)],
    );
    assert_bytes_eq(
        "funded account",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 1_000_000).data(),
    );
    assert_bytes_eq(
        "mint after MintTo",
        &svm.data(&mint),
        &want.clone().supply(1_000_000).data(),
    );

    // --- real Approve
    run(
        &mut svm,
        &payer,
        &[&owner],
        &[token::spl_approve(
            &tp,
            &acct,
            &delegate.pubkey(),
            &owner.pubkey(),
            400_000,
        )],
    );
    assert_bytes_eq(
        "after Approve",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 1_000_000)
            .delegate(delegate.pubkey(), 400_000)
            .data(),
    );

    // --- delegate spends part: delegated_amount decrements
    run(
        &mut svm,
        &payer,
        &[&delegate],
        &[token::spl_transfer_checked(
            &tp,
            &acct,
            &mint,
            &acct2,
            &delegate.pubkey(),
            100_000,
            6,
        )],
    );
    assert_bytes_eq(
        "after partial delegate spend",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 900_000)
            .delegate(delegate.pubkey(), 300_000)
            .data(),
    );

    // --- delegate spends the rest: the Token program clears the delegate (TR-05)
    run(
        &mut svm,
        &payer,
        &[&delegate],
        &[token::spl_transfer_checked(
            &tp,
            &acct,
            &mint,
            &acct2,
            &delegate.pubkey(),
            300_000,
            6,
        )],
    );
    assert_bytes_eq(
        "after exhausting the delegation",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 600_000)
            .cleared_delegate_for(flavor, delegate.pubkey())
            .data(),
    );

    // --- Approve then Revoke
    run(
        &mut svm,
        &payer,
        &[&owner],
        &[token::spl_approve(
            &tp,
            &acct,
            &delegate.pubkey(),
            &owner.pubkey(),
            7,
        )],
    );
    run(
        &mut svm,
        &payer,
        &[&owner],
        &[token::spl_revoke(&tp, &acct, &owner.pubkey())],
    );
    assert_bytes_eq(
        "after Revoke",
        &svm.data(&acct),
        &TokenAcct::new(tp, mint, owner.pubkey(), 600_000)
            .cleared_delegate_for(flavor, delegate.pubkey())
            .data(),
    );

    // --- close authority
    run(
        &mut svm,
        &payer,
        &[&owner],
        &[token::spl_set_authority(
            &tp,
            &acct,
            &owner.pubkey(),
            token::AUTH_CLOSE_ACCOUNT,
            Some(&close_auth),
        )],
    );
    let with_close = TokenAcct::new(tp, mint, owner.pubkey(), 600_000)
        .cleared_delegate_for(flavor, delegate.pubkey())
        .close_authority(close_auth);
    assert_bytes_eq(
        "after SetAuthority(CloseAccount)",
        &svm.data(&acct),
        &with_close.data(),
    );

    // --- frozen
    run(
        &mut svm,
        &payer,
        &[&freeze_auth],
        &[freeze(&tp, &acct, &mint, &freeze_auth.pubkey())],
    );
    assert_bytes_eq(
        "after Freeze",
        &svm.data(&acct),
        &with_close.clone().frozen().data(),
    );

    // --- the builder's TokenView decodes what the real program wrote
    let v = TokenView::parse(&svm.data(&acct));
    assert_eq!(v.state, token::STATE_FROZEN);
    assert_eq!(v.close_authority, Some(close_auth));
    assert_eq!(v.delegate, None);
    assert_eq!(v.amount, 600_000);
    let m = MintView::parse(&svm.data(&mint));
    assert_eq!((m.supply, m.decimals, m.initialized), (1_000_000, 6, 1));
    assert_eq!(m.mint_authority, Some(mint_auth.pubkey()));
    assert_eq!(m.freeze_authority, Some(freeze_auth.pubkey()));
}

#[test]
fn builders_equal_real_classic_token() {
    builders_equal_real_programs(Flavor::Classic);
}

#[test]
fn builders_equal_real_p_token() {
    builders_equal_real_programs(Flavor::PToken);
}

#[test]
fn builders_equal_real_token_2022_base_accounts() {
    builders_equal_real_programs(Flavor::Token2022);
}

fn native_account_matches(flavor: Flavor) {
    let mut svm = new_svm(flavor);
    let tp = flavor.token_program();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    // the native mint is an ordinary initialised 82-byte mint at a fixed address
    let native_mint = if flavor == Flavor::Token2022 {
        NATIVE_MINT_2022
    } else {
        NATIVE_MINT
    };
    token::put_mint(&mut svm, native_mint, &MintAcct::new(tp, 9));
    let acct = Pubkey::new_unique();
    let reserve = svm.rent(165);
    svm.put(
        acct,
        Account {
            lamports: reserve + 5_000,
            data: vec![0u8; 165],
            owner: tp,
            executable: false,
            rent_epoch: 0,
        },
    );
    let owner = Pubkey::new_unique();
    run(
        &mut svm,
        &payer,
        &[],
        &[init_account3(&tp, &acct, &native_mint, &owner)],
    );
    let want = TokenAcct::new(tp, native_mint, owner, 5_000).native(reserve);
    eprintln!(
        "{}: real native account = {:?} (reserve {reserve})",
        flavor.name(),
        TokenView::parse(&svm.data(&acct))
    );
    assert_bytes_eq("native account", &svm.data(&acct), &want.data());
    assert_eq!(TokenView::parse(&svm.data(&acct)).is_native, Some(reserve));
}

#[test]
fn native_account_builder_equals_real_programs() {
    for f in Flavor::ALL {
        native_account_matches(f);
    }
}

/// Real ATA program output: 165 bytes on Token, 170 bytes (ImmutableOwner TLV) on Token-2022.
#[test]
fn ata_program_accounts_equal_the_builders() {
    for flavor in [Flavor::Classic, Flavor::Token2022] {
        let mut svm = new_svm(flavor);
        let tp = flavor.token_program();
        let funder = Keypair::new();
        svm.airdrop(&funder.pubkey(), 10_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        token::put_mint(&mut svm, mint, &MintAcct::new(tp, 6));
        let wallet = Pubkey::new_unique();
        let ix = token::ata_create_idempotent(&funder.pubkey(), &wallet, &mint, &tp);
        run(&mut svm, &funder, &[], &[ix]);
        let ata = ata_address(&wallet, &tp, &mint);
        let want = if flavor == Flavor::Token2022 {
            TokenAcct::new(tp, mint, wallet, 0).immutable_owner_170()
        } else {
            TokenAcct::new(tp, mint, wallet, 0)
        };
        assert_bytes_eq(
            &format!("ATA ({})", flavor.name()),
            &svm.data(&ata),
            &want.data(),
        );
        if flavor == Flavor::Token2022 {
            assert_eq!(svm.data(&ata).len(), token::IMMUTABLE_OWNER_ACCOUNT_LEN);
            assert_eq!(svm.data(&ata)[165], 2, "AccountType::Account");
            assert_eq!(
                &svm.data(&ata)[166..170],
                &[7, 0, 0, 0],
                "ImmutableOwner TLV"
            );
        }
    }
}

/// Extension-bearing mints and accounts parse in the real Token-2022 program.
#[test]
fn extension_builders_are_accepted_by_real_token_2022() {
    let flavor = Flavor::Token2022;
    let mut svm = new_svm(flavor);
    let tp = flavor.token_program();
    let payer = Keypair::new();
    let owner = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    // mints: GetAccountDataSize (tag 21) unpacks the mint with its extensions
    for ext in [
        Ext::TransferFeeConfig,
        Ext::TransferHook,
        Ext::PermanentDelegate,
        Ext::ConfidentialTransferMint,
        Ext::MintCloseAuthority,
        Ext::DefaultAccountState,
        Ext::MetadataPointer,
        Ext::NonTransferable,
        Ext::InterestBearingConfig,
        Ext::Pausable,
    ] {
        let mint = Pubkey::new_unique();
        let m = MintAcct::new(tp, 6).with_extensions(&[ext]);
        token::put_mint(&mut svm, mint, &m);
        assert!(
            svm.data(&mint).len() > token::MINT_LEN,
            "{ext:?}: relay rule needs len != 82"
        );
        assert_eq!(svm.data(&mint)[165], 1, "AccountType::Mint");
        let ix =
            Instruction::new_with_bytes(tp, &[21u8], vec![AccountMeta::new_readonly(mint, false)]);
        let r = send_keys(&mut svm, &[&payer], &[ix]);
        assert!(
            r.is_ok(),
            "real Token-2022 rejected the {ext:?} mint builder:\n{}",
            r.pretty_logs()
        );
    }

    // accounts: Revoke (owner signs) unpacks the account with its extensions
    let mint = Pubkey::new_unique();
    token::put_mint(&mut svm, mint, &MintAcct::new(tp, 6));
    for exts in [
        vec![Ext::ImmutableOwner],
        vec![Ext::CpiGuard],
        vec![Ext::MemoTransfer],
        vec![Ext::TransferHookAccount],
        vec![Ext::TransferFeeAmount],
        vec![Ext::ImmutableOwner, Ext::CpiGuard],
    ] {
        let a = Pubkey::new_unique();
        let t = TokenAcct::new(tp, mint, owner.pubkey(), 0).with_extensions(&exts);
        token::put_token(&mut svm, a, &t);
        let r = send_keys(
            &mut svm,
            &[&payer, &owner],
            &[token::spl_revoke(&tp, &a, &owner.pubkey())],
        );
        assert!(
            r.is_ok(),
            "real Token-2022 rejected the {exts:?} account builder:\n{}",
            r.pretty_logs()
        );
    }
}

/// The flavour switch really swaps the binary: p-token costs a small fraction of classic.
#[test]
fn flavor_switch_selects_the_binary() {
    let mut cus = Vec::new();
    for flavor in [Flavor::Classic, Flavor::PToken] {
        let mut svm = new_svm(flavor);
        let tp = flavor.token_program();
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        token::put_mint(&mut svm, mint, &MintAcct::new(tp, 6));
        token::put_token(&mut svm, a, &TokenAcct::new(tp, mint, owner.pubkey(), 100));
        token::put_token(
            &mut svm,
            b,
            &TokenAcct::new(tp, mint, Pubkey::new_unique(), 0),
        );
        let ix = token::spl_transfer_checked(&tp, &a, &mint, &b, &owner.pubkey(), 10, 6);
        let r = send_keys(&mut svm, &[&owner], &[ix]);
        r.assert_ok();
        cus.push((flavor, r.cu()));
    }
    let (classic, ptoken) = (cus[0].1, cus[1].1);
    eprintln!("raw owner TransferChecked CU: classic = {classic}, p-token = {ptoken}");
    assert!(
        classic > 3_000,
        "classic spl-token should cost thousands of CU, got {classic}"
    );
    assert!(
        ptoken < 1_000,
        "p-token should cost a few hundred CU, got {ptoken}"
    );
}
