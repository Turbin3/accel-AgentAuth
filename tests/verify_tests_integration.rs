// tests/verify_integration.rs
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

// load the compiled .so
fn program_id() -> Pubkey {
    // must match declare_id! in lib.rs
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(
        program_id(),
        "target/deploy/mandate.so", // path to your built program
    )
    .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    (svm, payer)
}

fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"mandate", owner.as_ref(), agent.as_ref()], &program_id())
}

fn create_mandate_ix(owner: &Pubkey, agent: &Pubkey, mandate: &Pubkey, expiry: i64) -> Instruction {
    let mut data = vec![1u8]; // tag for CreateMandate
    data.extend_from_slice(&expiry.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(*mandate, false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
    )
}

fn add_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    mandate: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    let mut data = vec![2u8]; // tag for AddPermission
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(&spend_limit.to_le_bytes());
    data.extend_from_slice(&per_tx_limit.to_le_bytes());
    data.push(discs.len() as u8);
    for d in discs {
        data.extend_from_slice(d);
    }
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(*mandate, false),
        ],
    )
}

fn verify_ix(
    mandate: &Pubkey,
    target_program: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8]; // tag for Verify
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(disc);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*mandate, false), // writable
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ],
    )
}

const DISC: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0];

#[test]
fn verify_happy_ok() {
    let (mut svm, payer) = setup();
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    // 1. create mandate
    let ix = create_mandate_ix(&owner.pubkey(), &agent.pubkey(), &mandate, i64::MAX);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // 2. add permission
    let ix = add_permission_ix(
        &owner.pubkey(),
        &agent.pubkey(),
        &mandate,
        &target_program,
        1_000,
        500,
        &[DISC],
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // 3. verify — should pass and write back
    let ix = verify_ix(&mandate, &target_program, &DISC, 100);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // assert writeback
    let account = svm.get_account(&mandate).unwrap();
    let spend_total = u64::from_le_bytes(account.data[88 + 48..88 + 56].try_into().unwrap());
    let call_count = u32::from_le_bytes(account.data[88 + 56..88 + 60].try_into().unwrap());
    assert_eq!(spend_total, 100);
    assert_eq!(call_count, 1);
}

#[test]
fn verify_rejects_spend_limit_exceeded() {
    let (mut svm, payer) = setup();
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    let ix = create_mandate_ix(&owner.pubkey(), &agent.pubkey(), &mandate, i64::MAX);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // spend_limit = 500
    let ix = add_permission_ix(
        &owner.pubkey(),
        &agent.pubkey(),
        &mandate,
        &target_program,
        500,
        0,
        &[DISC],
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // amount = 600 > spend_limit
    let ix = verify_ix(&mandate, &target_program, &DISC, 600);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    let err = svm.send_transaction(tx).unwrap_err();
    assert!(
        err.to_string().contains("SpendLimitExceeded")
            || err.to_string().contains("custom program error: 0x9")
    );
}

#[test]
fn verify_writeback_accumulates() {
    let (mut svm, payer) = setup();
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    let ix = create_mandate_ix(&owner.pubkey(), &agent.pubkey(), &mandate, i64::MAX);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    let ix = add_permission_ix(
        &owner.pubkey(),
        &agent.pubkey(),
        &mandate,
        &target_program,
        10_000,
        0,
        &[DISC],
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // two successive verifies
    for amount in [100u64, 250u64] {
        let ix = verify_ix(&mandate, &target_program, &DISC, amount);
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            svm.latest_blockhash(),
        );
        svm.send_transaction(tx).unwrap();
    }

    let account = svm.get_account(&mandate).unwrap();
    let spend_total = u64::from_le_bytes(account.data[88 + 48..88 + 56].try_into().unwrap());
    let call_count = u32::from_le_bytes(account.data[88 + 56..88 + 60].try_into().unwrap());
    assert_eq!(spend_total, 350);
    assert_eq!(call_count, 2);
}

#[test]
fn verify_cu_under_2500() {
    let (mut svm, payer) = setup();
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    // setup
    let ix = create_mandate_ix(&owner.pubkey(), &agent.pubkey(), &mandate, i64::MAX);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    let ix = add_permission_ix(
        &owner.pubkey(),
        &agent.pubkey(),
        &mandate,
        &target_program,
        0,
        0,
        &[DISC],
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer, &owner],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // measure
    let ix = verify_ix(&mandate, &target_program, &DISC, 0);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(tx).unwrap();
    let cu_used = result.compute_units_consumed;

    println!("verify CU: {}", cu_used);
    assert!(cu_used < 2500, "verify used {} CU, budget is 2500", cu_used);
}
