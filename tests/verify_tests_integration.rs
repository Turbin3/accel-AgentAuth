use agent_auth::*;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_id() -> Pubkey {
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

fn setup() -> Option<(LiteSVM, Keypair)> {
    let program_path = std::env::var("AGENT_AUTH_SO")
        .unwrap_or_else(|_| "target/deploy/agent_auth.so".to_string());
    if !std::path::Path::new(&program_path).exists() {
        eprintln!("skipping LiteSVM integration test; program binary not found at {program_path}");
        return None;
    }

    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), program_path)
        .unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    Some((svm, payer))
}

fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &program_id(),
    )
}

fn mandate_data(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    spend_total: u64,
    call_count: u32,
) -> Vec<u8> {
    let mut data = vec![0u8; ACCOUNT_SIZE];

    data[OFF_DISC] = MANDATE_DISCRIMINATOR;
    data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(owner.as_ref());
    data[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(agent.as_ref());
    data[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&i64::MAX.to_le_bytes());
    data[OFF_ACTIVE] = 1;
    data[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&1u16.to_le_bytes());

    let base = HEADER_SIZE;
    data[base + P_PROGRAM_ID..base + P_PROGRAM_ID + 32].copy_from_slice(target_program.as_ref());
    data[base + P_SPEND_LIMIT..base + P_SPEND_LIMIT + 8]
        .copy_from_slice(&spend_limit.to_le_bytes());
    data[base + P_PER_TX_LIMIT..base + P_PER_TX_LIMIT + 8]
        .copy_from_slice(&per_tx_limit.to_le_bytes());
    data[base + P_SPEND_TOTAL..base + P_SPEND_TOTAL + 8]
        .copy_from_slice(&spend_total.to_le_bytes());
    data[base + P_CALL_COUNT..base + P_CALL_COUNT + 4].copy_from_slice(&call_count.to_le_bytes());
    data[base + P_DISC_LEN] = 1;
    data[base + P_DISCRIMINATORS..base + P_DISCRIMINATORS + 8].copy_from_slice(&DISC);

    data
}

fn seed_mandate(
    svm: &mut LiteSVM,
    mandate: Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    spend_total: u64,
    call_count: u32,
) {
    svm.set_account(
        mandate,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE),
            data: mandate_data(
                owner,
                agent,
                target_program,
                spend_limit,
                per_tx_limit,
                spend_total,
                call_count,
            ),
            owner: program_id(),
            ..Default::default()
        },
    )
    .unwrap();
}

fn verify_ix(
    mandate: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(disc);
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*mandate, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*agent, true),
        ],
    )
}

fn send_verify(
    svm: &mut LiteSVM,
    payer: &Keypair,
    agent: &Keypair,
    mandate: &Pubkey,
    owner: &Pubkey,
    target_program: &Pubkey,
    amount: u64,
) -> litesvm::types::TransactionResult {
    let ix = verify_ix(
        mandate,
        owner,
        &agent.pubkey(),
        target_program,
        &DISC,
        amount,
    );
    let tx = Transaction::new(
        &[payer, agent],
        Message::new(&[ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

fn spend_total_and_call_count(account_data: &[u8]) -> (u64, u32) {
    let base = HEADER_SIZE;
    let spend_total = u64::from_le_bytes(
        account_data[base + P_SPEND_TOTAL..base + P_SPEND_TOTAL + 8]
            .try_into()
            .unwrap(),
    );
    let call_count = u32::from_le_bytes(
        account_data[base + P_CALL_COUNT..base + P_CALL_COUNT + 4]
            .try_into()
            .unwrap(),
    );
    (spend_total, call_count)
}

const DISC: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0];

#[test]
fn verify_happy_ok() {
    let Some((mut svm, payer)) = setup() else {
        return;
    };
    let owner = Keypair::new();
    let agent = Keypair::new();
    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    seed_mandate(
        &mut svm,
        mandate,
        &owner.pubkey(),
        &agent.pubkey(),
        &target_program,
        1_000,
        500,
        0,
        0,
    );

    send_verify(
        &mut svm,
        &payer,
        &agent,
        &mandate,
        &owner.pubkey(),
        &target_program,
        100,
    )
    .unwrap();

    let account = svm.get_account(&mandate).unwrap();
    assert_eq!(spend_total_and_call_count(&account.data), (100, 1));
}

#[test]
fn verify_rejects_spend_limit_exceeded() {
    let Some((mut svm, payer)) = setup() else {
        return;
    };
    let owner = Keypair::new();
    let agent = Keypair::new();
    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    seed_mandate(
        &mut svm,
        mandate,
        &owner.pubkey(),
        &agent.pubkey(),
        &target_program,
        500,
        0,
        0,
        0,
    );

    let err = send_verify(
        &mut svm,
        &payer,
        &agent,
        &mandate,
        &owner.pubkey(),
        &target_program,
        600,
    )
    .unwrap_err();

    let err_text = format!("{:?}", err.err);
    assert!(
        err_text.contains("Custom(9)"),
        "expected SpendLimitExceeded custom error 9, got {err_text}"
    );
}

#[test]
fn verify_writeback_accumulates() {
    let Some((mut svm, payer)) = setup() else {
        return;
    };
    let owner = Keypair::new();
    let agent = Keypair::new();
    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    seed_mandate(
        &mut svm,
        mandate,
        &owner.pubkey(),
        &agent.pubkey(),
        &target_program,
        10_000,
        0,
        0,
        0,
    );

    for amount in [100u64, 250u64] {
        send_verify(
            &mut svm,
            &payer,
            &agent,
            &mandate,
            &owner.pubkey(),
            &target_program,
            amount,
        )
        .unwrap();
    }

    let account = svm.get_account(&mandate).unwrap();
    assert_eq!(spend_total_and_call_count(&account.data), (350, 2));
}

#[test]
fn verify_cu_under_2500() {
    let Some((mut svm, payer)) = setup() else {
        return;
    };
    let owner = Keypair::new();
    let agent = Keypair::new();
    let target_program = Pubkey::new_unique();
    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    seed_mandate(
        &mut svm,
        mandate,
        &owner.pubkey(),
        &agent.pubkey(),
        &target_program,
        0,
        0,
        0,
        0,
    );

    let result = send_verify(
        &mut svm,
        &payer,
        &agent,
        &mandate,
        &owner.pubkey(),
        &target_program,
        0,
    )
    .unwrap();
    let cu_used = result.compute_units_consumed;

    println!("verify CU: {cu_used}");
    assert!(cu_used < 2500, "verify used {cu_used} CU, budget is 2500");
}
