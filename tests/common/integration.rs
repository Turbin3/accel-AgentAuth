//! Shared helpers for LiteSVM integration tests.
//!
//! Import in any integration test file with:
//!   mod common;
//!   use common::integration::*;

#![allow(dead_code, unused_imports)]

pub use agent_auth::*;
pub use litesvm::LiteSVM;
pub use solana_account::Account;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_message::Message;
pub use solana_pubkey::Pubkey;
pub use solana_signer::Signer;
pub use solana_transaction::Transaction;

pub const DISC: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0];

pub fn program_id() -> Pubkey {
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

/// Returns `Some((svm, owner))` when the compiled `.so` is present,
/// `None` otherwise (test is silently skipped).
pub fn setup() -> Option<(LiteSVM, Keypair)> {
    let program_path = std::env::var("AGENT_AUTH_SO")
        .unwrap_or_else(|_| "target/deploy/agent_auth.so".to_string());
    if !std::path::Path::new(&program_path).exists() {
        eprintln!("skipping integration test — binary not found at {program_path}");
        return None;
    }
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), &program_path)
        .unwrap();
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    Some((svm, owner))
}

pub fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &program_id(),
    )
}

/// Seeds an active mandate with no permissions via `svm.set_account()`.
/// Consistent with the approach in `verify_tests_integration.rs`.
/// Returns the mandate PDA pubkey.
pub fn seed_mandate(svm: &mut LiteSVM, owner: &Pubkey, agent: &Pubkey, active: bool) -> Pubkey {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![0u8; ACCOUNT_SIZE];
    data[OFF_DISC] = MANDATE_DISCRIMINATOR;
    data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(owner.as_ref());
    data[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(agent.as_ref());
    data[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&i64::MAX.to_le_bytes());
    data[OFF_ACTIVE] = active as u8;
    data[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&0u16.to_le_bytes());
    svm.set_account(
        mandate,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE),
            data,
            owner: program_id(),
            ..Default::default()
        },
    )
    .unwrap();
    mandate
}

pub fn send(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> litesvm::types::TransactionResult {
    let payer = signers[0];
    let tx = Transaction::new(
        signers,
        Message::new(ixs, Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

// ── instruction builders ──────────────────────────────────────────────────

pub fn create_mandate_ix(owner: &Pubkey, agent: &Pubkey, expiry: i64) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![0u8]; // tag 0
    data.extend_from_slice(&expiry.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    )
}

pub fn add_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![1u8]; // tag 1
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
            AccountMeta::new(mandate, false),
        ],
    )
}

pub fn remove_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![2u8]; // tag 2
    data.extend_from_slice(target_program.as_ref());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate, false),
        ],
    )
}

pub fn verify_ix(
    mandate: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8]; // tag 3
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

pub fn revoke_mandate_ix(owner: &Pubkey, agent: &Pubkey) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    Instruction::new_with_bytes(
        program_id(),
        &[4u8], // tag 4, no payload
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(mandate, false),
            // System program required: revoke_mandate does a Transfer CPI to return rent.
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    )
}
