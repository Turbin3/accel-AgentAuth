//! The one LiteSVM harness shared by every integration test file.
//!
//! Use it with
//! ```ignore
//! mod common;
//! use common::integration::*;
//! ```
//!
//! Rules it enforces:
//!
//! * The compiled program is mandatory. A missing `.so` is a hard failure with
//!   the command that builds it; only `AGENT_AUTH_ALLOW_SKIP=1` opts out.
//! * Every send expires the blockhash first, so two byte-identical
//!   transactions are never rejected as `AlreadyProcessed` (a test could
//!   otherwise "pass" for the wrong reason).
//! * Errors are compared by numeric code, never by substring.
//! * Builders exist for all seven instructions (`create_ix`, `add_ix`,
//!   `remove_ix`, `verify_ix`, `revoke_ix`, `set_active_ix`, `update_ix`) and
//!   `Env` wraps each of them (`create`, `add`, ...), plus `set_time` /
//!   `warp` to move the LiteSVM clock.

#![allow(dead_code, unused_imports)]

pub use agent_auth::*;
pub use litesvm::LiteSVM;
pub use solana_account::Account;
pub use solana_clock::Clock;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_message::Message;
pub use solana_pubkey::Pubkey;
pub use solana_signer::Signer;
pub use solana_transaction::Transaction;

pub use agent_auth::MandateError as E;

pub const DISC: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0];
pub const NOW: i64 = 1_000_000;
pub const FUTURE: i64 = 4_000_000_000;

pub fn program_id() -> Pubkey {
    "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        .parse()
        .unwrap()
}

// --- loading the program ------------------------------------------------------

/// Path of the compiled program, from `AGENT_AUTH_SO` or the default build dir.
pub fn program_path() -> String {
    std::env::var("AGENT_AUTH_SO").unwrap_or_else(|_| "target/deploy/agent_auth.so".into())
}

/// Load the program into a fresh LiteSVM. Panics with an actionable message when
/// the binary is missing, unless `AGENT_AUTH_ALLOW_SKIP=1` (then `None`).
pub fn load_svm() -> Option<LiteSVM> {
    let path = program_path();
    if !std::path::Path::new(&path).exists() {
        if std::env::var("AGENT_AUTH_ALLOW_SKIP").as_deref() == Ok("1") {
            eprintln!("AGENT_AUTH_ALLOW_SKIP=1: skipping, no program binary at {path}");
            return None;
        }
        panic!(
            "program binary not found at {path}.\n  build it:  export PATH=\"$HOME/.cargo/bin:$PATH\" && cargo build-sbf\n  then point the tests at it:  AGENT_AUTH_SO=<target>/deploy/agent_auth.so cargo test\n  (AGENT_AUTH_ALLOW_SKIP=1 skips program-backed tests on purpose)"
        );
    }
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), &path).unwrap();
    set_time(&mut svm, NOW);
    Some(svm)
}

pub struct Env {
    pub svm: LiteSVM,
    pub owner: Keypair,
    pub agent: Keypair,
}

/// A fresh VM with the program loaded, the clock at `NOW`, and funded owner and
/// agent keypairs.
pub fn env() -> Option<Env> {
    let mut svm = load_svm()?;
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
    Some(Env { svm, owner, agent })
}

/// A fresh funded keypair.
pub fn funded(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), lamports).unwrap();
    k
}

// --- clock ------------------------------------------------------------------------

pub fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// Move the clock forward by `seconds`.
pub fn warp(svm: &mut LiteSVM, seconds: i64) {
    let t = now(svm) + seconds;
    set_time(svm, t);
}

// --- addresses ----------------------------------------------------------------------

pub fn pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &program_id(),
    )
}

/// Same as [`pda`]; the name the devnet suite uses.
pub fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    pda(owner, agent)
}

// --- sending ------------------------------------------------------------------------

pub type Sent = litesvm::types::TransactionResult;

/// Sign with `signers` (the first one pays) and send. The blockhash is expired
/// first so identical transactions are distinct.
pub fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Sent {
    svm.expire_blockhash();
    let tx = Transaction::new(
        signers,
        Message::new(ixs, Some(&signers[0].pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// Send paying with `payer`, signing with exactly the keypairs in `keys` that
/// the instructions mark as signers (so a test can leave a signer out by
/// clearing its `is_signer` flag without hand-picking keypairs).
pub fn send_signed_as_marked(
    svm: &mut LiteSVM,
    payer: &Keypair,
    keys: &[&Keypair],
    ixs: &[Instruction],
) -> Sent {
    let mut signers: Vec<&Keypair> = vec![payer];
    for ix in ixs {
        for meta in ix.accounts.iter().filter(|m| m.is_signer) {
            if signers.iter().any(|k| k.pubkey() == meta.pubkey) {
                continue;
            }
            let key = keys
                .iter()
                .find(|k| k.pubkey() == meta.pubkey)
                .unwrap_or_else(|| panic!("no keypair for signer {}", meta.pubkey));
            signers.push(key);
        }
    }
    send(svm, &signers, ixs)
}

// --- reading results ----------------------------------------------------------------

/// The program's custom error code, if the transaction failed with one.
pub fn code(result: &Sent) -> Option<u32> {
    let err = result.as_ref().err()?;
    custom_code(&format!("{:?}", err.err))
}

/// Parse `Custom(n)` out of a transaction error's Debug text.
pub fn custom_code(text: &str) -> Option<u32> {
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

/// Success; returns the compute units consumed.
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

// --- the environment's convenience layer -----------------------------------------

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

    /// Send one instruction signed (and paid) by the owner.
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

    /// Replace the mandate account wholesale (test setup for states the
    /// instruction set cannot reach).
    pub fn put_account(&mut self, address: Pubkey, account: Account) {
        self.svm.set_account(address, account).unwrap();
    }

    /// Overwrite bytes of the mandate account in place.
    pub fn patch(&mut self, at: usize, bytes: &[u8]) {
        let mandate = self.mandate();
        let mut acc = self.svm.get_account(&mandate).unwrap();
        acc.data[at..at + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(mandate, acc).unwrap();
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

// --- observing state ------------------------------------------------------------------

/// Everything observable about a set of accounts, for "a failed instruction
/// changes nothing" assertions.
#[derive(Clone, PartialEq, Eq)]
pub struct Snapshot(Vec<(Pubkey, AccountEntry)>);

/// `(lamports, owner, data, executable)` of an account that exists.
pub type AccountEntry = Option<(u64, Pubkey, Vec<u8>, bool)>;

impl std::fmt::Debug for Snapshot {
    // account data is 2 KB per mandate: print a summary, not the bytes
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (key, entry) in &self.0 {
            match entry {
                None => writeln!(f, "{key}: absent")?,
                Some((lamports, owner, data, _)) => writeln!(
                    f,
                    "{key}: {lamports} lamports, owner {owner}, {} data bytes",
                    data.len()
                )?,
            }
        }
        Ok(())
    }
}

impl Snapshot {
    pub fn take(svm: &LiteSVM, keys: &[Pubkey]) -> Self {
        Snapshot(
            keys.iter()
                .map(|k| {
                    (
                        *k,
                        svm.get_account(k)
                            .map(|a| (a.lamports, a.owner, a.data, a.executable)),
                    )
                })
                .collect(),
        )
    }

    /// `(lamports, owner, data, executable)` of `key` as captured, if it existed.
    pub fn entry(&self, key: &Pubkey) -> AccountEntry {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.clone())
    }

    /// Panic naming the first account that differs.
    #[track_caller]
    pub fn assert_same(&self, after: &Snapshot, context: &str) {
        for (b, a) in self.0.iter().zip(after.0.iter()) {
            assert!(b == a, "{context}: account {} changed", b.0);
        }
    }
}

/// Little-endian readers over the raw account bytes.
pub fn u64_at(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

pub fn slot_base(slot: usize) -> usize {
    HEADER_SIZE + slot * PERMISSION_SIZE
}

pub fn spend_total(data: &[u8], slot: usize) -> u64 {
    u64_at(data, slot_base(slot) + P_SPEND_TOTAL)
}

pub fn spend_limit(data: &[u8], slot: usize) -> u64 {
    u64_at(data, slot_base(slot) + P_SPEND_LIMIT)
}

pub fn per_tx_limit(data: &[u8], slot: usize) -> u64 {
    u64_at(data, slot_base(slot) + P_PER_TX_LIMIT)
}

pub fn call_count(data: &[u8], slot: usize) -> u32 {
    let off = slot_base(slot) + P_CALL_COUNT;
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}

pub fn perm_len(data: &[u8]) -> u16 {
    u16::from_le_bytes(data[OFF_PERM_LEN..OFF_PERM_LEN + 2].try_into().unwrap())
}

pub fn slot_program(data: &[u8], slot: usize) -> &[u8] {
    &data[slot_base(slot)..slot_base(slot) + 32]
}

pub fn slot_discs(data: &[u8], slot: usize) -> Vec<[u8; 8]> {
    let base = slot_base(slot);
    let n = data[base + P_DISC_LEN] as usize;
    (0..n)
        .map(|i| {
            let off = base + P_DISCRIMINATORS + i * 8;
            data[off..off + 8].try_into().unwrap()
        })
        .collect()
}

pub fn expiry_of(data: &[u8]) -> i64 {
    i64::from_le_bytes(data[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap())
}

// --- instruction builders --------------------------------------------------------------

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

/// A System Program transfer (used to pre-fund or re-fund a mandate address).
pub fn system_transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction::new_with_bytes(
        solana_sdk_ids::system_program::ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
    )
}

// --- pair-keyed builders (the shape the devnet suite uses) --------------------------

pub fn create_mandate_ix(owner: &Pubkey, agent: &Pubkey, expiry: i64) -> Instruction {
    create_ix(owner, agent, expiry)
}

pub fn add_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    add_ix(
        owner,
        &pda(owner, agent).0,
        target_program,
        spend_limit,
        per_tx_limit,
        discs,
    )
}

pub fn remove_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
) -> Instruction {
    remove_ix(owner, &pda(owner, agent).0, target_program)
}

pub fn revoke_mandate_ix(owner: &Pubkey, agent: &Pubkey) -> Instruction {
    revoke_ix(owner, &pda(owner, agent).0)
}

// --- a tiny deterministic PRNG for property and fuzz tests ------------------------------

/// xorshift64*: seeded, reproducible, no dependency. Print the seed on failure.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform-ish in `0..n` (`n > 0`).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
    /// Amounts weighted toward the boundaries that matter.
    pub fn amount(&mut self) -> u64 {
        match self.below(8) {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            3 => u64::MAX - self.below(3),
            4 => self.below(5_000),
            _ => self.below(300),
        }
    }
}

/// Number of random cases a property or fuzz test runs: the default, or
/// `AGENT_AUTH_PROP_CASES` to scale a run up or down.
pub fn prop_cases(default: u64) -> u64 {
    std::env::var("AGENT_AUTH_PROP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
