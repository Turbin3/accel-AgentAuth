//! End-to-end tests of `agent-auth-cpi` in LiteSVM, against the REAL `agent_auth.so` and a tiny
//! third-party program (`tests/fixture-caller`) that uses the crate.
//!
//! Build the programs once with `crates/agent-auth-cpi/build-fixtures.sh`; the tests find them via
//! `AGENT_AUTH_SO`, `FIXTURE_CALLER_SO`, `FIXTURE_YES_MAN_SO` or `$CARGO_TARGET_DIR/deploy` (default
//! `<repo>/target/deploy`). A missing .so is a HARD FAILURE unless `AGENT_AUTH_ALLOW_SKIP=1`.
//!
//! Each "attack" test pairs the safe helper with a NEGATIVE CONTROL (the same payload against a bare,
//! unchecked verify CPI succeeds), so the tests prove the attack is real and that the helper stops it.
#![allow(clippy::too_many_arguments, clippy::result_large_err)]

use std::path::PathBuf;

use agent_auth_cpi::{CpiError, AGENT_AUTH_ID};
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYS: Pubkey = Pubkey::new_from_array([0u8; 32]);
const SYS_TRANSFER_DISC: [u8; 8] = [2, 0, 0, 0, 0, 0, 0, 0];
const FAR_FUTURE: i64 = 4_000_000_000;
const RECIPIENT_BASE: u64 = 1_000_000_000;

// core program error codes (locked, see the core README)
const CORE_NOT_ACTIVE: u32 = 4;
const CORE_EXPIRED: u32 = 5;
const CORE_PROGRAM_NOT_ALLOWED: u32 = 6;
const CORE_DISC_NOT_ALLOWED: u32 = 7;
const CORE_PER_TX_EXCEEDED: u32 = 8;
const CORE_SPEND_LIMIT_EXCEEDED: u32 = 9;

// fixture-caller modes
const HELPER: u8 = 0;
const RAW: u8 = 1;
const NO_VERIFY: u8 = 2;
const HELPER_PDA: u8 = 3;
const HELD_BORROW: u8 = 4;
const PREFLIGHT: u8 = 5;
const NAIVE_ID: u8 = 6;

fn aa() -> Pubkey {
    Pubkey::new_from_array(AGENT_AUTH_ID)
}
fn caller_id() -> Pubkey {
    Pubkey::new_from_array([0xC1; 32])
}
fn yes_man_id() -> Pubkey {
    Pubkey::new_from_array([0xE5; 32])
}

fn locate(env_var: &str, file: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(env_var) {
        return Some(PathBuf::from(p));
    }
    let target = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    let p = target.join("deploy").join(file);
    if p.exists() {
        return Some(p);
    }
    if std::env::var("AGENT_AUTH_ALLOW_SKIP").as_deref() == Ok("1") {
        return None;
    }
    panic!(
        "{file} not found (set {env_var} or run crates/agent-auth-cpi/build-fixtures.sh; \
         AGENT_AUTH_ALLOW_SKIP=1 skips these tests)"
    );
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair, // the legitimate owner whose treasury the fixture protects
    agent: Keypair,
    recipient: Pubkey,
    config: Pubkey,
}

fn env() -> Option<Env> {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(aa(), locate("AGENT_AUTH_SO", "agent_auth.so")?)
        .unwrap();
    svm.add_program_from_file(
        caller_id(),
        locate("FIXTURE_CALLER_SO", "fixture_caller.so")?,
    )
    .unwrap();
    svm.add_program_from_file(
        yes_man_id(),
        locate("FIXTURE_YES_MAN_SO", "fixture_yes_man.so")?,
    )
    .unwrap();
    let payer = Keypair::new();
    let owner = Keypair::new();
    let agent = Keypair::new();
    for k in [&payer, &owner, &agent] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let recipient = Pubkey::new_unique();
    svm.airdrop(&recipient, RECIPIENT_BASE).unwrap();
    // program state: "this deployment protects the treasury of `owner`"
    let config = Pubkey::new_unique();
    svm.set_account(
        config,
        Account {
            lamports: 1_000_000,
            data: owner.pubkey().to_bytes().to_vec(),
            owner: caller_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let (t, _) = treasury(&owner.pubkey());
    svm.airdrop(&t, 5_000_000_000).unwrap();
    Some(Env {
        svm,
        payer,
        owner,
        agent,
        recipient,
        config,
    })
}

macro_rules! env_or_skip {
    () => {
        match env() {
            Some(e) => e,
            None => return,
        }
    };
}

fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"mandate", owner.as_ref(), agent.as_ref()], &aa()).0
}
fn treasury(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"treasury", owner.as_ref()], &caller_id())
}
fn agent_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"agent"], &caller_id())
}

fn send(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> TransactionResult {
    svm.expire_blockhash();
    let tx = Transaction::new(
        signers,
        Message::new(ixs, Some(&signers[0].pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

// ---- AgentAuth core instruction builders (wire format of the core program) ----
fn create_ix(owner: &Pubkey, agent: &Pubkey, expiry: i64) -> Instruction {
    let mut d = vec![0u8];
    d.extend_from_slice(&expiry.to_le_bytes());
    Instruction::new_with_bytes(
        aa(),
        &d,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(mandate_pda(owner, agent), false),
            AccountMeta::new_readonly(SYS, false),
        ],
    )
}
fn add_perm_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target: &Pubkey,
    spend: u64,
    per_tx: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    let mut d = vec![1u8];
    d.extend_from_slice(target.as_ref());
    d.extend_from_slice(&spend.to_le_bytes());
    d.extend_from_slice(&per_tx.to_le_bytes());
    d.push(discs.len() as u8);
    for x in discs {
        d.extend_from_slice(x);
    }
    Instruction::new_with_bytes(
        aa(),
        &d,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate_pda(owner, agent), false),
        ],
    )
}
fn revoke_ix(owner: &Pubkey, agent: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        aa(),
        &[4u8],
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(mandate_pda(owner, agent), false),
            AccountMeta::new_readonly(SYS, false),
        ],
    )
}

/// `owner` creates a mandate for `agent` allowing System::Transfer with the given limits.
fn provision(e: &mut Env, owner: &Keypair, agent: &Pubkey, expiry: i64, spend: u64, per_tx: u64) {
    let o = owner.pubkey();
    send(
        &mut e.svm,
        &[owner],
        &[
            create_ix(&o, agent, expiry),
            add_perm_ix(&o, agent, &SYS, spend, per_tx, &[SYS_TRANSFER_DISC]),
        ],
    )
    .unwrap();
}

/// The fixture-caller instruction. Accounts: auth, mandate, owner, agent, treasury, recipient, system, config.
struct Call {
    mode: u8,
    amount: u64,
    auth: Pubkey,
    mandate: Pubkey,
    owner: Pubkey,
    agent: Pubkey,
    agent_signer: bool,
    mandate_writable: bool,
    treasury: Pubkey,
    treasury_bump: u8,
    agent_bump: u8,
}

fn call(e: &Env, mode: u8, amount: u64) -> Call {
    let (o, a) = (e.owner.pubkey(), e.agent.pubkey());
    let (t, tb) = treasury(&o);
    Call {
        mode,
        amount,
        auth: aa(),
        mandate: mandate_pda(&o, &a),
        owner: o,
        agent: a,
        agent_signer: true,
        mandate_writable: true,
        treasury: t,
        treasury_bump: tb,
        agent_bump: 0,
    }
}

impl Call {
    fn ix(&self, e: &Env) -> Instruction {
        let mut d = vec![self.mode];
        d.extend_from_slice(&self.amount.to_le_bytes());
        d.push(self.treasury_bump);
        d.push(self.agent_bump);
        Instruction::new_with_bytes(
            caller_id(),
            &d,
            vec![
                AccountMeta::new_readonly(self.auth, false),
                AccountMeta {
                    pubkey: self.mandate,
                    is_signer: false,
                    is_writable: self.mandate_writable,
                },
                AccountMeta::new_readonly(self.owner, false),
                AccountMeta {
                    pubkey: self.agent,
                    is_signer: self.agent_signer,
                    is_writable: false,
                },
                AccountMeta::new(self.treasury, false),
                AccountMeta::new(e.recipient, false),
                AccountMeta::new_readonly(SYS, false),
                AccountMeta::new_readonly(e.config, false),
            ],
        )
    }
}

fn run(e: &mut Env, c: &Call, signer: &Keypair) -> TransactionResult {
    let ix = c.ix(e);
    let payer = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    send(&mut e.svm, &[&payer, signer], &[ix])
}

/// Build the default call for `mode` and run it.
fn go(e: &mut Env, mode: u8, amount: u64, signer: &Keypair) -> TransactionResult {
    let c = call(e, mode, amount);
    run(e, &c, signer)
}

fn cu(r: &TransactionResult) -> u64 {
    match r {
        Ok(m) => m.compute_units_consumed,
        Err(e) => e.meta.compute_units_consumed,
    }
}
fn logs(r: &TransactionResult) -> Vec<String> {
    match r {
        Ok(m) => m.logs.clone(),
        Err(e) => e.meta.logs.clone(),
    }
}
/// The `Custom(n)` code of a failed transaction, if it failed with one.
fn custom_code(r: &TransactionResult) -> Option<u32> {
    let err = format!("{:?}", r.as_ref().err()?.err);
    let n = err.split("Custom(").nth(1)?;
    n.split(')').next()?.parse().ok()
}
fn expect_cpi_error(r: &TransactionResult, want: CpiError) {
    assert_eq!(
        custom_code(r),
        Some(want.code()),
        "wanted {want:?}, got {:?}",
        r.as_ref().err().map(|x| &x.err)
    );
    assert!(
        !logs(r)
            .iter()
            .any(|l| l.contains(&format!("Program {} invoke", aa()))),
        "{want:?} must be raised BEFORE any CPI into AgentAuth; logs: {:#?}",
        logs(r)
    );
}
fn expect_core_error(r: &TransactionResult, code: u32) {
    assert_eq!(
        custom_code(r),
        Some(code),
        "wanted core error {code}, got {:?}",
        r.as_ref().err().map(|x| &x.err)
    );
    assert!(
        logs(r)
            .iter()
            .any(|l| l.contains(&format!("Program {} invoke", aa()))),
        "the core error must come from the AgentAuth program itself"
    );
}
fn received(e: &Env) -> u64 {
    e.svm.get_balance(&e.recipient).unwrap() - RECIPIENT_BASE
}
/// (spend_total, call_count) of permission slot 0 of the mandate.
fn counters(e: &Env, mandate: &Pubkey) -> (u64, u32) {
    let m = e.svm.get_account(mandate).unwrap();
    let base = 88;
    (
        u64::from_le_bytes(m.data[base + 48..base + 56].try_into().unwrap()),
        u32::from_le_bytes(m.data[base + 56..base + 60].try_into().unwrap()),
    )
}

// =============================================================================================

#[test]
fn happy_path_verifies_then_transfers_and_bumps_counters() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(
        &mut e,
        &owner,
        &agent.pubkey(),
        FAR_FUTURE,
        1_000_000,
        400_000,
    );
    let c = call(&e, HELPER, 300_000);
    let r = run(&mut e, &c, &agent);
    r.as_ref()
        .unwrap_or_else(|x| panic!("{:?}\n{:#?}", x.err, x.meta.logs));
    assert_eq!(received(&e), 300_000);
    assert_eq!(counters(&e, &c.mandate), (300_000, 1));
    // a second call accumulates
    run(&mut e, &c, &agent).unwrap();
    assert_eq!(received(&e), 600_000);
    assert_eq!(counters(&e, &c.mandate), (600_000, 2));
}

#[test]
fn wrong_agentauth_program_is_rejected_before_any_cpi() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    // The attacker has NO mandate at all; they pass a yes-man program in the AgentAuth slot.
    let mut atk = call(&e, NAIVE_ID, 3_000_000_000);
    atk.auth = yes_man_id();
    atk.mandate = Pubkey::new_unique();
    // NEGATIVE CONTROL: an integrator that takes the program id from the tx is drained.
    run(&mut e, &atk, &agent).unwrap();
    assert_eq!(
        received(&e),
        3_000_000_000,
        "negative control: the naive integrator must be drainable"
    );

    // The helper rejects the identical payload, before anything is invoked.
    let before = received(&e);
    let mut safe = call(&e, HELPER, 1_000_000_000);
    safe.auth = yes_man_id();
    safe.mandate = atk.mandate;
    let r = run(&mut e, &safe, &agent);
    expect_cpi_error(&r, CpiError::WrongAgentAuthProgram);
    assert!(!logs(&r)
        .iter()
        .any(|l| l.contains(&format!("Program {} invoke", yes_man_id()))));
    assert_eq!(received(&e), before);

    // Any other program in the slot (even the System program) is rejected the same way.
    let mut sys = call(&e, HELPER, 1);
    sys.auth = SYS;
    expect_cpi_error(&run(&mut e, &sys, &agent), CpiError::WrongAgentAuthProgram);
}

#[test]
fn fake_mandate_owned_by_another_program_is_rejected() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    // A byte-perfect mandate (victim as owner, attacker as agent, unlimited) but owned by the
    // attacker's program instead of AgentAuth.
    let mut data = vec![0u8; 2136];
    data[0] = 1;
    data[1..33].copy_from_slice(e.owner.pubkey().as_ref());
    data[33..65].copy_from_slice(agent.pubkey().as_ref());
    data[65..73].copy_from_slice(&FAR_FUTURE.to_le_bytes());
    data[73] = 1;
    let fake = Pubkey::new_unique();
    e.svm
        .set_account(
            fake,
            Account {
                lamports: 20_000_000,
                data,
                owner: caller_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let mut c = call(&e, HELPER, 1_000);
    c.mandate = fake;
    let r = run(&mut e, &c, &agent);
    expect_cpi_error(&r, CpiError::MandateNotOwnedByAgentAuth);
    assert_eq!(received(&e), 0);
}

#[test]
fn malformed_mandate_size_and_discriminator_are_rejected() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let c = call(&e, HELPER, 1_000);
    let good = e.svm.get_account(&c.mandate).unwrap();

    // discriminator zeroed
    let mut bad = good.clone();
    bad.data[0] = 0;
    e.svm.set_account(c.mandate, bad).unwrap();
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::MandateBadDiscriminator);

    // wrong size (truncated), still owned by AgentAuth
    let mut short = good.clone();
    short.data.truncate(2000);
    e.svm.set_account(c.mandate, short).unwrap();
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::MandateBadSize);

    // and the good account still works afterwards
    e.svm.set_account(c.mandate, good).unwrap();
    run(&mut e, &c, &agent).unwrap();
}

#[test]
fn attacker_minted_mandate_is_rejected_owner_binding() {
    let mut e = env_or_skip!();
    // The attacker controls two keys: `atk` (owner) and `atk_agent` (agent) of a self-made, UNLIMITED
    // mandate; nobody consented. (The hardened core rejects owner == agent, so two keys are used.)
    let atk = Keypair::new();
    let atk_agent = Keypair::new();
    e.svm.airdrop(&atk.pubkey(), 10_000_000_000).unwrap();
    e.svm.airdrop(&atk_agent.pubkey(), 10_000_000_000).unwrap();
    provision(&mut e, &atk, &atk_agent.pubkey(), FAR_FUTURE, 0, 0);
    let m = mandate_pda(&atk.pubkey(), &atk_agent.pubkey());

    let build = |e: &Env, mode: u8, amount: u64| {
        let mut c = call(e, mode, amount);
        c.mandate = m;
        c.owner = atk.pubkey();
        c.agent = atk_agent.pubkey();
        c
    };

    // NEGATIVE CONTROL: with a bare verify CPI the attacker's mandate drains the VICTIM's treasury,
    // because the integrator never bound the mandate's owner to the funds it moves.
    let c = build(&e, RAW, 4_000_000_000);
    run(&mut e, &c, &atk_agent).unwrap();
    assert_eq!(
        received(&e),
        4_000_000_000,
        "negative control: unbound owner is drainable"
    );

    // The helper: mandate.owner (attacker) != expected owner (victim, from program state).
    let before = received(&e);
    let c = build(&e, HELPER, 1_000_000_000);
    let r = run(&mut e, &c, &atk_agent);
    expect_cpi_error(&r, CpiError::OwnerMismatch);
    assert_eq!(received(&e), before);
}

#[test]
fn owner_account_must_match_expected_owner() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    // genuine mandate (victim as owner) but the tx supplies a different account in the owner slot
    let mut c = call(&e, HELPER, 1_000);
    c.owner = Pubkey::new_unique();
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::OwnerAccountMismatch);
}

#[test]
fn mandate_naming_a_different_agent_is_rejected() {
    let mut e = env_or_skip!();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    // The victim's legitimate mandate belongs to `other`. `agent` tries to use it.
    let other = Keypair::new();
    provision(&mut e, &owner, &other.pubkey(), FAR_FUTURE, 0, 0);
    let mut c = call(&e, HELPER, 1_000);
    c.mandate = mandate_pda(&owner.pubkey(), &other.pubkey());
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::AgentMismatch);
}

#[test]
fn agent_that_did_not_sign_is_rejected() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let mut c = call(&e, HELPER, 1_000);
    c.agent_signer = false;
    let payer = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let ix = c.ix(&e);
    let r = send(&mut e.svm, &[&payer], &[ix]);
    expect_cpi_error(&r, CpiError::AgentNotSigner);
    assert_eq!(received(&e), 0);
}

#[test]
fn mandate_must_be_writable_and_unborrowed() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let mut c = call(&e, HELPER, 1_000);
    c.mandate_writable = false;
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::MandateNotWritable);

    let c = call(&e, HELD_BORROW, 1_000);
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::MandateBorrowed);
}

#[test]
fn preflight_runs_every_check_without_a_cpi() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let c = call(&e, PREFLIGHT, 1_000);
    let r = run(&mut e, &c, &agent);
    r.as_ref().unwrap_or_else(|x| panic!("{:?}", x.err));
    assert!(
        !logs(&r)
            .iter()
            .any(|l| l.contains(&format!("Program {} invoke", aa()))),
        "preflight must not CPI"
    );
    assert_eq!(counters(&e, &c.mandate), (0, 0));
    let mut bad = call(&e, PREFLIGHT, 1_000);
    bad.auth = yes_man_id();
    expect_cpi_error(&run(&mut e, &bad, &agent), CpiError::WrongAgentAuthProgram);
}

#[test]
fn core_rejections_propagate_unchanged() {
    // expired
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), 100, 1_000_000, 400_000);
    let mut clock = e.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = 200;
    e.svm.set_sysvar(&clock);
    let c = call(&e, HELPER, 1_000);
    let r = run(&mut e, &c, &agent);
    expect_core_error(&r, CORE_EXPIRED);
    assert_eq!(received(&e), 0);
    assert_eq!(counters(&e, &c.mandate), (0, 0));

    // per-tx limit, lifetime limit (exact limit still passes)
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(
        &mut e,
        &owner,
        &agent.pubkey(),
        FAR_FUTURE,
        1_000_000,
        400_000,
    );
    let r = go(&mut e, HELPER, 400_001, &agent);
    expect_core_error(&r, CORE_PER_TX_EXCEEDED);
    for _ in 0..2 {
        go(&mut e, HELPER, 400_000, &agent).unwrap();
    }
    let r = go(&mut e, HELPER, 300_000, &agent);
    expect_core_error(&r, CORE_SPEND_LIMIT_EXCEEDED);
    go(&mut e, HELPER, 200_000, &agent).unwrap();
    assert_eq!(received(&e), 1_000_000);

    // inactive flag
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let c = call(&e, HELPER, 1_000);
    let mut m = e.svm.get_account(&c.mandate).unwrap();
    m.data[73] = 0;
    e.svm.set_account(c.mandate, m).unwrap();
    expect_core_error(&run(&mut e, &c, &agent), CORE_NOT_ACTIVE);

    // program / discriminator not in the mandate: the fixture reports System::Transfer, so build
    // mandates that grant something else
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    let o = owner.pubkey();
    let other_prog = Pubkey::new_unique();
    send(
        &mut e.svm,
        &[&owner],
        &[
            create_ix(&o, &agent.pubkey(), FAR_FUTURE),
            add_perm_ix(&o, &agent.pubkey(), &other_prog, 0, 0, &[SYS_TRANSFER_DISC]),
        ],
    )
    .unwrap();
    expect_core_error(&go(&mut e, HELPER, 1, &agent), CORE_PROGRAM_NOT_ALLOWED);

    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    let o = owner.pubkey();
    send(
        &mut e.svm,
        &[&owner],
        &[
            create_ix(&o, &agent.pubkey(), FAR_FUTURE),
            add_perm_ix(&o, &agent.pubkey(), &SYS, 0, 0, &[[9, 0, 0, 0, 0, 0, 0, 0]]),
        ],
    )
    .unwrap();
    expect_core_error(&go(&mut e, HELPER, 1, &agent), CORE_DISC_NOT_ALLOWED);
}

#[test]
fn revoked_mandate_cannot_be_used() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let c = call(&e, HELPER, 1_000);
    run(&mut e, &c, &agent).unwrap();
    send(
        &mut e.svm,
        &[&owner],
        &[revoke_ix(&owner.pubkey(), &agent.pubkey())],
    )
    .unwrap();
    let r = run(&mut e, &c, &agent);
    // Today revoke closes the PDA, so the helper sees a system-owned account; a core that keeps the
    // account and clears `active` would surface NotActive from the core instead. Either way: refused.
    let code = custom_code(&r);
    println!(
        "INFO | call after revoke failed with {code:?}; account now: {:?}",
        e.svm
            .get_account(&c.mandate)
            .map(|a| (a.owner, a.data.len()))
    );
    assert!(
        code == Some(CpiError::MandateNotOwnedByAgentAuth.code()) || code == Some(CORE_NOT_ACTIVE),
        "revoked mandate must be refused, got {:?}",
        r.as_ref().err().map(|x| &x.err)
    );
    assert_eq!(received(&e), 1_000, "only the pre-revoke call moved funds");
}

#[test]
fn pda_agent_signs_via_invoke_signed() {
    let mut e = env_or_skip!();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    let (apda, abump) = agent_pda();
    provision(&mut e, &owner, &apda, FAR_FUTURE, 1_000_000, 0);
    let mut c = call(&e, HELPER_PDA, 5_000);
    c.agent = apda;
    c.agent_bump = abump;
    c.agent_signer = false; // a PDA cannot sign the outer transaction
    c.mandate = mandate_pda(&owner.pubkey(), &apda);
    let payer = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let ix = c.ix(&e);
    let r = send(&mut e.svm, &[&payer], &[ix]);
    r.as_ref()
        .unwrap_or_else(|x| panic!("{:?}\n{:#?}", x.err, x.meta.logs));
    assert_eq!(received(&e), 5_000);
    assert_eq!(counters(&e, &c.mandate), (5_000, 1));

    // Seeds that do not derive the mandate's agent: a mandate for a plain key that never signs.
    let ghost = Keypair::new();
    provision(&mut e, &owner, &ghost.pubkey(), FAR_FUTURE, 0, 0);
    let mut c = call(&e, HELPER_PDA, 5_000);
    c.agent = ghost.pubkey();
    c.agent_bump = abump;
    c.agent_signer = false;
    c.mandate = mandate_pda(&owner.pubkey(), &ghost.pubkey());
    let ix = c.ix(&e);
    let r = send(&mut e.svm, &[&payer], &[ix]);
    assert!(
        r.is_err(),
        "wrong PDA seeds must not produce the agent's signature"
    );
    assert_eq!(received(&e), 5_000);
}

#[test]
fn cu_overhead_of_the_helper_over_a_raw_cpi() {
    let mut e = env_or_skip!();
    let agent = Keypair::try_from(e.agent.to_bytes().as_slice()).unwrap();
    let owner = Keypair::try_from(e.owner.to_bytes().as_slice()).unwrap();
    provision(&mut e, &owner, &agent.pubkey(), FAR_FUTURE, 0, 0);
    let measure = |e: &mut Env, mode: u8| -> u64 {
        // warm-up call, then take the second measurement (fixed state, same amount)
        let c = call(e, mode, 1_000);
        run(e, &c, &agent).unwrap();
        cu(&run(e, &c, &agent))
    };
    let none = measure(&mut e, NO_VERIFY);
    let raw = measure(&mut e, RAW);
    let helper = measure(&mut e, HELPER);
    println!("CU | transfer only (no verify)          = {none}");
    println!(
        "CU | transfer + raw verify CPI          = {raw}  (verify cost incl. CPI = {})",
        raw - none
    );
    println!(
        "CU | transfer + agent-auth-cpi helper   = {helper}  (verify cost incl. CPI = {})",
        helper - none
    );
    println!(
        "CU | helper overhead over the raw CPI   = {}",
        helper as i64 - raw as i64
    );
    assert!(
        helper > raw,
        "the helper does strictly more work than a raw CPI"
    );
    assert!(
        helper - raw < 1_000,
        "helper checks should stay well under 1,000 CU, got {}",
        helper - raw
    );
}
