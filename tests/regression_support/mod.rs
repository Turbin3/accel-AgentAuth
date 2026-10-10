//! Strict LiteSVM harness for the regression tests.
//!
//! * The compiled program is mandatory: a missing `.so` is a hard failure.
//!   Set `AGENT_AUTH_ALLOW_SKIP=1` to opt out explicitly.
//! * Every send expires the blockhash first, so two byte-identical
//!   transactions are never rejected as `AlreadyProcessed` and a test cannot
//!   pass for that reason.
//! * Errors are compared by numeric code, not by substring.

#![allow(dead_code, unused_imports)]

use agent_auth::*;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use agent_auth::MandateError as E;

pub const DISC: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0];
pub const NOW: i64 = 1_000_000;
pub const FUTURE: i64 = 4_000_000_000;

pub fn program_id() -> Pubkey {
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

pub struct Env {
    pub svm: LiteSVM,
    pub owner: Keypair,
    pub agent: Keypair,
}

/// A fresh VM with the program loaded, the clock at `NOW`, and funded
/// owner and agent keypairs. `None` only when `AGENT_AUTH_ALLOW_SKIP=1` and the
/// binary is absent.
pub fn env() -> Option<Env> {
    let path =
        std::env::var("AGENT_AUTH_SO").unwrap_or_else(|_| "target/deploy/agent_auth.so".into());
    if !std::path::Path::new(&path).exists() {
        if std::env::var("AGENT_AUTH_ALLOW_SKIP").as_deref() == Ok("1") {
            eprintln!("AGENT_AUTH_ALLOW_SKIP=1: skipping, no program binary at {path}");
            return None;
        }
        panic!("program binary not found at {path}: run `cargo build-sbf` and set AGENT_AUTH_SO");
    }
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), &path).unwrap();
    set_time(&mut svm, NOW);
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
    Some(Env { svm, owner, agent })
}

pub fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

pub fn pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &program_id(),
    )
}

pub type Sent = litesvm::types::TransactionResult;

pub fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Sent {
    svm.expire_blockhash();
    let tx = Transaction::new(
        signers,
        Message::new(ixs, Some(&signers[0].pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// The program's custom error code, if the transaction failed with one.
pub fn code(result: &Sent) -> Option<u32> {
    let err = result.as_ref().err()?;
    let text = format!("{:?}", err.err);
    let digits = text.split("Custom(").nth(1)?;
    digits.split(')').next()?.parse().ok()
}

#[track_caller]
pub fn assert_code(result: Sent, want: MandateError) {
    let got = code(&result);
    assert_eq!(
        got,
        Some(want as u32),
        "expected {want:?} ({}); got {:?}",
        want as u32,
        result.map(|m| m.compute_units_consumed).map_err(|e| e.err)
    );
}

/// The transaction failed with a built-in (non-custom) error whose Debug text
/// contains `needle`, e.g. `InvalidAccountData`.
#[track_caller]
pub fn assert_builtin(result: Sent, needle: &str) {
    match result {
        Ok(_) => panic!("expected {needle}, but the transaction succeeded"),
        Err(e) => {
            let text = format!("{:?}", e.err);
            assert!(
                text.contains(needle) && !text.contains("Custom("),
                "expected {needle}, got {text}"
            );
        }
    }
}

#[track_caller]
pub fn assert_ok(result: Sent) -> u64 {
    match result {
        Ok(meta) => meta.compute_units_consumed,
        Err(e) => panic!(
            "expected success, got {:?}\nlogs: {:#?}",
            e.err, e.meta.logs
        ),
    }
}

impl Env {
    pub fn owner_key(&self) -> Pubkey {
        self.owner.pubkey()
    }
    pub fn agent_key(&self) -> Pubkey {
        self.agent.pubkey()
    }
    pub fn mandate(&self) -> Pubkey {
        pda(&self.owner.pubkey(), &self.agent.pubkey()).0
    }
    pub fn bump(&self) -> u8 {
        pda(&self.owner.pubkey(), &self.agent.pubkey()).1
    }

    pub fn run(&mut self, ix: Instruction) -> Sent {
        let owner = self.owner.insecure_clone();
        send(&mut self.svm, &[&owner], &[ix])
    }

    pub fn run_as(&mut self, signer: &Keypair, ixs: &[Instruction]) -> Sent {
        send(&mut self.svm, &[signer], ixs)
    }

    pub fn create(&mut self, expiry: i64) -> Sent {
        let ix = create_ix(&self.owner_key(), &self.agent_key(), expiry);
        self.run(ix)
    }

    pub fn add(&mut self, target: &Pubkey, spend: u64, per_tx: u64, discs: &[[u8; 8]]) -> Sent {
        let ix = add_ix(
            &self.owner_key(),
            &self.mandate(),
            target,
            spend,
            per_tx,
            discs,
        );
        self.run(ix)
    }

    pub fn update(&mut self, target: &Pubkey, spend: u64, per_tx: u64) -> Sent {
        let ix = update_ix(&self.owner_key(), &self.mandate(), target, spend, per_tx);
        self.run(ix)
    }

    pub fn remove(&mut self, target: &Pubkey) -> Sent {
        let ix = remove_ix(&self.owner_key(), &self.mandate(), target);
        self.run(ix)
    }

    pub fn set_active(&mut self, active: u8) -> Sent {
        let ix = set_active_ix(&self.owner_key(), &self.mandate(), active);
        self.run(ix)
    }

    pub fn revoke(&mut self) -> Sent {
        let ix = revoke_ix(&self.owner_key(), &self.mandate());
        self.run(ix)
    }

    /// `verify` signed by the agent (the owner pays).
    pub fn verify(&mut self, target: &Pubkey, disc: &[u8; 8], amount: u64) -> Sent {
        let ix = verify_ix(
            &self.mandate(),
            &self.owner_key(),
            &self.agent_key(),
            target,
            disc,
            amount,
        );
        let (owner, agent) = (self.owner.insecure_clone(), self.agent.insecure_clone());
        send(&mut self.svm, &[&owner, &agent], &[ix])
    }

    pub fn account(&self) -> Option<Account> {
        self.svm.get_account(&self.mandate())
    }

    pub fn data(&self) -> Vec<u8> {
        self.account().expect("mandate account").data
    }

    /// An active mandate that expires at `FUTURE` with one permission for a
    /// fresh target program allowing `DISC`.
    pub fn with_permission(spend: u64, per_tx: u64) -> Option<(Self, Pubkey)> {
        let mut env = env()?;
        assert_ok(env.create(FUTURE));
        let target = Pubkey::new_unique();
        assert_ok(env.add(&target, spend, per_tx, &[DISC]));
        Some((env, target))
    }
}

/// Little-endian readers over the raw account bytes.
pub fn u64_at(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

pub fn spend_total(data: &[u8], slot: usize) -> u64 {
    u64_at(data, HEADER_SIZE + slot * PERMISSION_SIZE + P_SPEND_TOTAL)
}

pub fn call_count(data: &[u8], slot: usize) -> u32 {
    let off = HEADER_SIZE + slot * PERMISSION_SIZE + P_CALL_COUNT;
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}

pub fn perm_len(data: &[u8]) -> u16 {
    u16::from_le_bytes(data[OFF_PERM_LEN..OFF_PERM_LEN + 2].try_into().unwrap())
}

// --- instruction builders -------------------------------------------------

pub fn create_ix(owner: &Pubkey, agent: &Pubkey, expiry: i64) -> Instruction {
    let mut data = vec![0u8];
    data.extend_from_slice(&expiry.to_le_bytes());
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(pda(owner, agent).0, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    )
}

pub fn add_ix(
    owner: &Pubkey,
    mandate: &Pubkey,
    target: &Pubkey,
    spend: u64,
    per_tx: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    let mut data = vec![1u8];
    data.extend_from_slice(target.as_ref());
    data.extend_from_slice(&spend.to_le_bytes());
    data.extend_from_slice(&per_tx.to_le_bytes());
    data.push(discs.len() as u8);
    for d in discs {
        data.extend_from_slice(d);
    }
    owner_ix(owner, mandate, data)
}

pub fn remove_ix(owner: &Pubkey, mandate: &Pubkey, target: &Pubkey) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(target.as_ref());
    owner_ix(owner, mandate, data)
}

pub fn update_ix(
    owner: &Pubkey,
    mandate: &Pubkey,
    target: &Pubkey,
    spend: u64,
    per_tx: u64,
) -> Instruction {
    let mut data = vec![6u8];
    data.extend_from_slice(target.as_ref());
    data.extend_from_slice(&spend.to_le_bytes());
    data.extend_from_slice(&per_tx.to_le_bytes());
    owner_ix(owner, mandate, data)
}

pub fn set_active_ix(owner: &Pubkey, mandate: &Pubkey, active: u8) -> Instruction {
    owner_ix(owner, mandate, vec![5u8, active])
}

/// `[owner (signer), mandate (writable)]` with arbitrary instruction data.
pub fn owner_ix(owner: &Pubkey, mandate: &Pubkey, data: Vec<u8>) -> Instruction {
    Instruction::new_with_bytes(
        program_id(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*mandate, false),
        ],
    )
}

pub fn revoke_ix(owner: &Pubkey, mandate: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        program_id(),
        &[4u8],
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    )
}

pub fn verify_ix(
    mandate: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    target: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(target.as_ref());
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
