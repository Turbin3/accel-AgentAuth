//! LiteSVM tests of `gated-example` against the REAL `agent_auth.so` and the real `gated_example.so`.
//!
//! Programs are found through `AGENT_AUTH_SO` / `GATED_EXAMPLE_SO` or `$CARGO_TARGET_DIR/deploy`
//! (default `<repo>/target/deploy`, build with `scripts/build-all.sh`). A missing .so is a HARD
//! FAILURE unless `AGENT_AUTH_ALLOW_SKIP=1`.
//!
//! Error attribution: the example uses `agent-auth-cpi`, which refuses malformed calls BEFORE the CPI with
//! `Custom(0x4141_000n)` (`CpiError`); everything about the mandate's content (expiry, limits, allow-lists,
//! paused) is AgentAuth's own `Custom(1..=22)`, asserted together with the failing program in the logs.
#![allow(clippy::result_large_err)]

use std::path::PathBuf;

use agent_auth_cpi::{CpiError, AGENT_AUTH_ID};
use gated_example::{GATED_ACTION_DISC, GATED_EXAMPLE_ID};
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
const FAR_FUTURE: i64 = 4_000_000_000;
const OTHER_DISC: [u8; 8] = [2, 0, 0, 0, 0, 0, 0, 0];

// AgentAuth core error codes (locked)
const NOT_ACTIVE: u32 = 4;
const EXPIRED: u32 = 5;
const PROGRAM_NOT_ALLOWED: u32 = 6;
const DISC_NOT_ALLOWED: u32 = 7;
const PER_TX_EXCEEDED: u32 = 8;
const SPEND_LIMIT_EXCEEDED: u32 = 9;

fn aa() -> Pubkey {
    Pubkey::new_from_array(AGENT_AUTH_ID)
}
fn gated() -> Pubkey {
    Pubkey::new_from_array(GATED_EXAMPLE_ID)
}
/// An unrelated address that hosts a byte-for-byte copy of the real AgentAuth binary.
fn fake_aa() -> Pubkey {
    Pubkey::new_from_array([0xFA; 32])
}
fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &gated()).0
}
fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"mandate", owner.as_ref(), agent.as_ref()], &aa()).0
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
    panic!("{file} not found (set {env_var} or run scripts/build-all.sh; AGENT_AUTH_ALLOW_SKIP=1 skips)");
}

struct Env {
    svm: LiteSVM,
    owner: Keypair, // the owner this deployment honours (set by `init`)
    agent: Keypair,
}

fn clone_kp(k: &Keypair) -> Keypair {
    Keypair::try_from(k.to_bytes().as_slice()).unwrap()
}

/// Fresh chain: real core, gated-example, a fake-AgentAuth copy; `init` done by `owner`.
fn env() -> Option<Env> {
    let mut svm = LiteSVM::new();
    let core = locate("AGENT_AUTH_SO", "agent_auth.so")?;
    svm.add_program_from_file(aa(), &core).unwrap();
    svm.add_program_from_file(fake_aa(), &core).unwrap();
    svm.add_program_from_file(gated(), locate("GATED_EXAMPLE_SO", "gated_example.so")?)
        .unwrap();
    let (owner, agent) = (Keypair::new(), Keypair::new());
    for k in [&owner, &agent] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let mut e = Env { svm, owner, agent };
    let init = init_ix(&e.owner.pubkey(), config_pda());
    let o = clone_kp(&e.owner);
    send(&mut e.svm, &[&o], &[init]).unwrap();
    Some(e)
}

macro_rules! env_or_skip {
    () => {
        match env() {
            Some(e) => e,
            None => return,
        }
    };
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

// ---- AgentAuth core builders (wire format of the locked core ABI) ----
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
    owner_ix(owner, agent, d)
}
fn owner_ix(owner: &Pubkey, agent: &Pubkey, data: Vec<u8>) -> Instruction {
    Instruction::new_with_bytes(
        aa(),
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(mandate_pda(owner, agent), false),
            AccountMeta::new_readonly(SYS, false),
        ],
    )
}
fn remove_perm_ix(owner: &Pubkey, agent: &Pubkey, target: &Pubkey) -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(target.as_ref());
    owner_ix(owner, agent, d)
}
fn revoke_ix(owner: &Pubkey, agent: &Pubkey) -> Instruction {
    owner_ix(owner, agent, vec![4u8])
}
fn set_active_ix(owner: &Pubkey, agent: &Pubkey, on: bool) -> Instruction {
    owner_ix(owner, agent, vec![5u8, on as u8])
}
/// A bare, top-level core `verify` (what any program or agent can do on its own: it is advisory).
fn core_verify_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target: &Pubkey,
    disc: [u8; 8],
    amount: u64,
) -> Instruction {
    let mut d = vec![3u8];
    d.extend_from_slice(target.as_ref());
    d.extend_from_slice(&disc);
    d.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        aa(),
        &d,
        vec![
            AccountMeta::new(mandate_pda(owner, agent), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*agent, true),
        ],
    )
}

fn init_ix(authority: &Pubkey, config: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        gated(),
        &[0],
        vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(SYS, false),
        ],
    )
}

/// `gated_action` accounts: [agent S, mandate W, owner R, agentauth_program R, config R].
struct Call {
    amount: u64,
    agent: Pubkey,
    agent_signer: bool,
    mandate: Pubkey,
    mandate_writable: bool,
    owner: Pubkey,
    auth: Pubkey,
    config: Pubkey,
}
fn call(e: &Env, amount: u64) -> Call {
    let (o, a) = (e.owner.pubkey(), e.agent.pubkey());
    Call {
        amount,
        agent: a,
        agent_signer: true,
        mandate: mandate_pda(&o, &a),
        mandate_writable: true,
        owner: o,
        auth: aa(),
        config: config_pda(),
    }
}
impl Call {
    fn ix(&self) -> Instruction {
        let mut d = vec![1u8];
        d.extend_from_slice(&self.amount.to_le_bytes());
        Instruction::new_with_bytes(
            gated(),
            &d,
            vec![
                AccountMeta {
                    pubkey: self.agent,
                    is_signer: self.agent_signer,
                    is_writable: false,
                },
                AccountMeta {
                    pubkey: self.mandate,
                    is_signer: false,
                    is_writable: self.mandate_writable,
                },
                AccountMeta::new_readonly(self.owner, false),
                AccountMeta::new_readonly(self.auth, false),
                AccountMeta::new_readonly(self.config, false),
            ],
        )
    }
}
/// Send `ix` with `signer` as fee payer and agent signature (agent is the payer in these tests).
fn run(e: &mut Env, c: &Call, signer: &Keypair) -> TransactionResult {
    let payer = clone_kp(&e.owner);
    send(&mut e.svm, &[&payer, signer], &[c.ix()])
}
fn go(e: &mut Env, amount: u64) -> TransactionResult {
    let c = call(e, amount);
    let agent = clone_kp(&e.agent);
    run(e, &c, &agent)
}

/// Owner mints a mandate for the agent with a gated-example permission.
fn provision(e: &mut Env, spend: u64, per_tx: u64, discs: &[[u8; 8]]) {
    let o = clone_kp(&e.owner);
    let ixs = [
        create_ix(&o.pubkey(), &e.agent.pubkey(), FAR_FUTURE),
        add_perm_ix(
            &o.pubkey(),
            &e.agent.pubkey(),
            &gated(),
            spend,
            per_tx,
            discs,
        ),
    ];
    send(&mut e.svm, &[&o], &ixs).unwrap();
}
/// The demo permission: lifetime 100, per-call 10, `gated_action` only.
fn provision_demo(e: &mut Env) {
    provision(e, 100, 10, &[GATED_ACTION_DISC]);
}

fn logs(r: &TransactionResult) -> Vec<String> {
    match r {
        Ok(m) => m.logs.clone(),
        Err(f) => f.meta.logs.clone(),
    }
}
fn custom_code(r: &TransactionResult) -> Option<u32> {
    let err = format!("{:?}", r.as_ref().err()?.err);
    err.split("Custom(").nth(1)?.split(')').next()?.parse().ok()
}
/// The failure must be this exact crate error and AgentAuth must never have been invoked.
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
            .any(|l| l.contains(&format!("Program {} invoke [2]", aa()))),
        "{want:?} must be raised before any CPI to AgentAuth"
    );
}
/// The failure must come from the AgentAuth program itself, one level below the example.
fn expect_core_error(r: &TransactionResult, code: u32) {
    assert_eq!(
        custom_code(r),
        Some(code),
        "wanted AgentAuth Custom({code}), got {:?}",
        r.as_ref().err().map(|x| &x.err)
    );
    let l = logs(r);
    let gated_at = l
        .iter()
        .position(|x| x == &format!("Program {} invoke [1]", gated()))
        .expect("gated invoked");
    let aa_at = l
        .iter()
        .position(|x| x == &format!("Program {} invoke [2]", aa()))
        .expect("AgentAuth invoked via CPI");
    assert!(aa_at > gated_at);
    assert!(l
        .iter()
        .any(|x| x.starts_with(&format!("Program {} failed: custom program error", aa()))));
}
/// (spend_total, call_count) of the gated-example permission slot (slot 0).
fn counters(e: &Env, mandate: &Pubkey) -> (u64, u32) {
    let m = e.svm.get_account(mandate).unwrap();
    let base = 88; // header; permission 0 follows
    (
        u64::from_le_bytes(m.data[base + 48..base + 56].try_into().unwrap()),
        u32::from_le_bytes(m.data[base + 56..base + 60].try_into().unwrap()),
    )
}
fn mandate_snapshot(e: &Env, m: &Pubkey) -> Vec<u8> {
    e.svm.get_account(m).unwrap().data
}
fn mandate_of(e: &Env) -> Pubkey {
    mandate_pda(&e.owner.pubkey(), &e.agent.pubkey())
}

// ==================================== GE rows of the test matrix ====================================

#[test]
fn ge01_within_per_tx_succeeds_and_books_the_counters() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let m = mandate_of(&e);
    assert_eq!(counters(&e, &m), (0, 0));

    let r = go(&mut e, 4);
    assert!(r.is_ok(), "{:?}", r.err().map(|x| (x.err, x.meta.logs)));
    assert_eq!(counters(&e, &m), (4, 1));
    // the action logged the verified amount as a program-data event
    let l = logs(&r);
    assert!(
        l.iter()
            .any(|x| x.starts_with("Program data: ") && x.split(' ').count() == 4),
        "{l:?}"
    );
    // exactly one CPI level below the example: AgentAuth verify
    assert!(l.contains(&format!("Program {} invoke [2]", aa())));

    // a second call accumulates; the boundary amount (== per_tx) is allowed
    assert!(go(&mut e, 10).is_ok());
    assert_eq!(counters(&e, &m), (14, 2));
}

#[test]
fn ge02_over_per_tx_limit_is_agentauth_8_and_changes_nothing() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);
    let r = go(&mut e, 11);
    expect_core_error(&r, PER_TX_EXCEEDED);
    assert_eq!(
        mandate_snapshot(&e, &m),
        before,
        "a failed verify must not book anything"
    );
}

#[test]
fn ge03_no_permission_and_after_remove_permission_is_agentauth_6() {
    // mandate with no permission at all
    let mut e = env_or_skip!();
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[create_ix(&o.pubkey(), &e.agent.pubkey(), FAR_FUTURE)],
    )
    .unwrap();
    expect_core_error(&go(&mut e, 1), PROGRAM_NOT_ALLOWED);

    // permission present, works, then the owner removes it live
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    assert!(go(&mut e, 1).is_ok());
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[remove_perm_ix(&o.pubkey(), &e.agent.pubkey(), &gated())],
    )
    .unwrap();
    expect_core_error(&go(&mut e, 1), PROGRAM_NOT_ALLOWED);

    // permission for a different program only
    let mut e = env_or_skip!();
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[
            create_ix(&o.pubkey(), &e.agent.pubkey(), FAR_FUTURE),
            add_perm_ix(
                &o.pubkey(),
                &e.agent.pubkey(),
                &SYS,
                100,
                10,
                &[GATED_ACTION_DISC],
            ),
        ],
    )
    .unwrap();
    expect_core_error(&go(&mut e, 1), PROGRAM_NOT_ALLOWED);
}

#[test]
fn ge04_agent_not_signing_and_other_agents_key_are_rejected_before_the_cpi() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);

    // the agent's key is named but did not sign (the owner pays and signs the transaction)
    let mut c = call(&e, 1);
    c.agent_signer = false;
    let payer = clone_kp(&e.owner);
    let r = send(&mut e.svm, &[&payer], &[c.ix()]);
    expect_cpi_error(&r, CpiError::AgentNotSigner);

    // another agent's key signs and is passed as the agent for this mandate
    let other = Keypair::new();
    e.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    let mut c = call(&e, 1);
    c.agent = other.pubkey();
    let r = run(&mut e, &c, &other);
    expect_cpi_error(&r, CpiError::AgentMismatch);
    assert_eq!(mandate_snapshot(&e, &m), before);
}

#[test]
fn ge05_fake_agentauth_program_is_rejected_before_any_cpi() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);
    let mut c = call(&e, 1);
    c.auth = fake_aa(); // a working copy of the AgentAuth binary at the wrong address
    let agent = clone_kp(&e.agent);
    let r = run(&mut e, &c, &agent);
    expect_cpi_error(&r, CpiError::WrongAgentAuthProgram);
    assert!(
        !logs(&r).iter().any(|l| l.contains(&fake_aa().to_string())),
        "the fake program must never have been invoked"
    );
    assert_eq!(mandate_snapshot(&e, &m), before);
}

// ==================================== more adversarial cases ====================================

#[test]
fn attacker_minted_mandate_with_the_attacker_as_owner_is_rejected() {
    let mut e = env_or_skip!();
    provision_demo(&mut e); // the legitimate owner's mandate exists too
                            // the attacker mints a mandate for ITS OWN agent key, itself as owner, with unlimited limits
    let attacker = Keypair::new();
    let evil_agent = Keypair::new(); // the core refuses agent == owner
    e.svm.airdrop(&attacker.pubkey(), 5_000_000_000).unwrap();
    send(
        &mut e.svm,
        &[&attacker],
        &[
            create_ix(&attacker.pubkey(), &evil_agent.pubkey(), FAR_FUTURE),
            add_perm_ix(
                &attacker.pubkey(),
                &evil_agent.pubkey(),
                &gated(),
                0,
                0,
                &[GATED_ACTION_DISC],
            ),
        ],
    )
    .unwrap();
    let evil = mandate_pda(&attacker.pubkey(), &evil_agent.pubkey());

    // negative control: a bare AgentAuth verify happily approves it (it IS a valid mandate)
    let ok = send(
        &mut e.svm,
        &[&attacker, &evil_agent],
        &[core_verify_ix(
            &attacker.pubkey(),
            &evil_agent.pubkey(),
            &gated(),
            GATED_ACTION_DISC,
            1_000_000,
        )],
    );
    assert!(ok.is_ok(), "{:?}", ok.err().map(|x| x.err));

    // but the gate only honours mandates of the owner in ITS config
    let c = Call {
        amount: 1,
        agent: evil_agent.pubkey(),
        agent_signer: true,
        mandate: evil,
        mandate_writable: true,
        owner: attacker.pubkey(),
        auth: aa(),
        config: config_pda(),
    };
    let r = send(&mut e.svm, &[&attacker, &evil_agent], &[c.ix()]);
    expect_cpi_error(&r, CpiError::OwnerMismatch);
    // naming the real owner as the owner account does not help: the mandate itself still names the attacker
    let mut c2 = c;
    c2.owner = e.owner.pubkey();
    expect_cpi_error(
        &send(&mut e.svm, &[&attacker, &evil_agent], &[c2.ix()]),
        CpiError::OwnerMismatch,
    );
}

#[test]
fn owner_account_that_is_not_the_configured_owner_is_rejected() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let mut c = call(&e, 1);
    c.owner = Pubkey::new_unique();
    let agent = clone_kp(&e.agent);
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::OwnerAccountMismatch);
}

#[test]
fn expired_mandate_is_agentauth_5() {
    let mut e = env_or_skip!();
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[
            create_ix(&o.pubkey(), &e.agent.pubkey(), 100),
            add_perm_ix(
                &o.pubkey(),
                &e.agent.pubkey(),
                &gated(),
                100,
                10,
                &[GATED_ACTION_DISC],
            ),
        ],
    )
    .unwrap();
    assert!(go(&mut e, 1).is_ok(), "valid before expiry (clock is 0)");
    let mut clock = e.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = 200;
    e.svm.set_sysvar(&clock);
    expect_core_error(&go(&mut e, 1), EXPIRED);
}

#[test]
fn revoked_mandate_cannot_be_used() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    assert!(go(&mut e, 1).is_ok());
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[revoke_ix(&o.pubkey(), &e.agent.pubkey())],
    )
    .unwrap();
    // revoke closes the account: it is no longer owned by AgentAuth, so the helper refuses it
    expect_cpi_error(&go(&mut e, 1), CpiError::MandateNotOwnedByAgentAuth);
}

#[test]
fn paused_mandate_is_agentauth_4_and_resumes() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[set_active_ix(&o.pubkey(), &e.agent.pubkey(), false)],
    )
    .unwrap();
    expect_core_error(&go(&mut e, 1), NOT_ACTIVE);
    send(
        &mut e.svm,
        &[&o],
        &[set_active_ix(&o.pubkey(), &e.agent.pubkey(), true)],
    )
    .unwrap();
    assert!(go(&mut e, 1).is_ok());
}

#[test]
fn lifetime_limit_is_agentauth_9_and_exact_budget_still_passes() {
    let mut e = env_or_skip!();
    provision(&mut e, 25, 10, &[GATED_ACTION_DISC]);
    let m = mandate_of(&e);
    assert!(go(&mut e, 10).is_ok());
    assert!(go(&mut e, 10).is_ok());
    assert_eq!(counters(&e, &m), (20, 2));
    let before = mandate_snapshot(&e, &m);
    expect_core_error(&go(&mut e, 6), SPEND_LIMIT_EXCEEDED); // 20 + 6 > 25
    assert_eq!(mandate_snapshot(&e, &m), before);
    assert!(go(&mut e, 5).is_ok()); // exactly the remaining budget
    assert_eq!(counters(&e, &m), (25, 3));
    expect_core_error(&go(&mut e, 1), SPEND_LIMIT_EXCEEDED);
}

#[test]
fn discriminator_not_allowed_is_agentauth_7() {
    let mut e = env_or_skip!();
    // the owner allowed this program, but a different instruction only
    provision(&mut e, 100, 10, &[OTHER_DISC]);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);
    expect_core_error(&go(&mut e, 1), DISC_NOT_ALLOWED);
    assert_eq!(mandate_snapshot(&e, &m), before);
}

#[test]
fn mandate_for_another_program_slot_does_not_leak_into_this_one() {
    // the example reports target = ITS OWN id: a generous slot for the System program is irrelevant
    let mut e = env_or_skip!();
    let o = clone_kp(&e.owner);
    send(
        &mut e.svm,
        &[&o],
        &[
            create_ix(&o.pubkey(), &e.agent.pubkey(), FAR_FUTURE),
            add_perm_ix(
                &o.pubkey(),
                &e.agent.pubkey(),
                &SYS,
                0,
                0,
                &[GATED_ACTION_DISC, OTHER_DISC],
            ),
        ],
    )
    .unwrap();
    expect_core_error(&go(&mut e, 1), PROGRAM_NOT_ALLOWED);
}

#[test]
fn mandate_that_is_not_writable_or_not_a_mandate_is_refused() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let agent = clone_kp(&e.agent);
    let mut c = call(&e, 1);
    c.mandate_writable = false;
    expect_cpi_error(&run(&mut e, &c, &agent), CpiError::MandateNotWritable);

    // an attacker-owned look-alike with the mandate's size and discriminator
    let mut data = vec![0u8; 2136];
    data[0] = 1;
    data[1..33].copy_from_slice(e.owner.pubkey().as_ref());
    data[33..65].copy_from_slice(e.agent.pubkey().as_ref());
    let fake = Pubkey::new_unique();
    e.svm
        .set_account(
            fake,
            Account {
                lamports: 10_000_000,
                data,
                owner: SYS,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let mut c = call(&e, 1);
    c.mandate = fake;
    expect_cpi_error(
        &run(&mut e, &c, &agent),
        CpiError::MandateNotOwnedByAgentAuth,
    );
}

// ==================================== config / init ====================================

#[test]
fn a_config_the_caller_picked_is_not_trusted() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let agent = clone_kp(&e.agent);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);

    // program-owned, correct size, right content, but NOT at the config PDA address
    let mut data = vec![0u8; 33];
    data[..32].copy_from_slice(e.owner.pubkey().as_ref());
    let fake_cfg = Pubkey::new_unique();
    e.svm
        .set_account(
            fake_cfg,
            Account {
                lamports: 10_000_000,
                data: data.clone(),
                owner: gated(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let mut c = call(&e, 1);
    c.config = fake_cfg;
    let r = run(&mut e, &c, &agent);
    assert!(format!("{:?}", r.as_ref().err().unwrap().err).contains("InvalidSeeds"));

    // a config account owned by somebody else
    e.svm
        .set_account(
            fake_cfg,
            Account {
                lamports: 10_000_000,
                data,
                owner: SYS,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    c.config = fake_cfg;
    let r = run(&mut e, &c, &agent);
    assert!(format!("{:?}", r.as_ref().err().unwrap().err).contains("InvalidAccountData"));
    assert_eq!(mandate_snapshot(&e, &m), before);
}

#[test]
fn config_holds_the_initialising_authority_and_init_runs_once() {
    let mut e = env_or_skip!();
    let cfg = e.svm.get_account(&config_pda()).unwrap();
    assert_eq!(cfg.owner, gated());
    assert_eq!(cfg.data.len(), 33);
    assert_eq!(&cfg.data[..32], e.owner.pubkey().as_ref());
    assert_eq!(
        cfg.data[32],
        Pubkey::find_program_address(&[b"config"], &gated()).1
    );

    // a second init (even by someone else) cannot overwrite it
    let squatter = Keypair::new();
    e.svm.airdrop(&squatter.pubkey(), 1_000_000_000).unwrap();
    let r = send(
        &mut e.svm,
        &[&squatter],
        &[init_ix(&squatter.pubkey(), config_pda())],
    );
    assert!(r.is_err());
    assert_eq!(
        &e.svm.get_account(&config_pda()).unwrap().data[..32],
        e.owner.pubkey().as_ref()
    );
}

#[test]
fn init_requires_a_signature_and_the_pda_address() {
    let mut e = env_or_skip!();
    e.svm.set_account(config_pda(), Account::default()).unwrap(); // pretend nothing was initialised
    let a = Keypair::new();
    e.svm.airdrop(&a.pubkey(), 1_000_000_000).unwrap();
    // authority not a signer (somebody else pays)
    let mut ix = init_ix(&a.pubkey(), config_pda());
    ix.accounts[0].is_signer = false;
    let payer = Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    assert!(send(&mut e.svm, &[&payer], &[ix]).is_err());
    // a config address that is not the PDA
    assert!(send(
        &mut e.svm,
        &[&a],
        &[init_ix(&a.pubkey(), Pubkey::new_unique())]
    )
    .is_err());
    // the real thing works
    assert!(send(&mut e.svm, &[&a], &[init_ix(&a.pubkey(), config_pda())]).is_ok());
    assert_eq!(
        &e.svm.get_account(&config_pda()).unwrap().data[..32],
        a.pubkey().as_ref()
    );
}

#[test]
fn pre_funding_the_config_pda_cannot_block_init() {
    let mut e = env_or_skip!();
    e.svm
        .set_account(
            config_pda(),
            Account {
                lamports: 1,
                ..Account::default()
            },
        )
        .unwrap(); // griefer sent 1 lamport
    let a = Keypair::new();
    e.svm.airdrop(&a.pubkey(), 1_000_000_000).unwrap();
    assert!(send(&mut e.svm, &[&a], &[init_ix(&a.pubkey(), config_pda())]).is_ok());
    assert_eq!(e.svm.get_account(&config_pda()).unwrap().owner, gated());
}

// ==================================== instruction shape ====================================

#[test]
fn malformed_instructions_are_rejected() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    let m = mandate_of(&e);
    let before = mandate_snapshot(&e, &m);
    let agent = clone_kp(&e.agent);
    let payer = clone_kp(&e.owner);
    let base = call(&e, 1).ix();

    let with_data = |data: Vec<u8>| Instruction {
        data,
        ..base.clone()
    };
    for bad in [
        vec![],
        vec![9],
        vec![1],
        vec![1, 0, 0, 0],
        vec![1, 1, 0, 0, 0, 0, 0, 0],
        vec![1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
        vec![0, 0],
    ] {
        let r = send(&mut e.svm, &[&payer, &agent], &[with_data(bad.clone())]);
        assert!(r.is_err(), "data {bad:?} must fail");
    }
    // too few accounts
    let mut short = base.clone();
    short.accounts.pop();
    assert!(send(&mut e.svm, &[&payer, &agent], &[short]).is_err());
    // an extra trailing account is not accepted either (exact account list)
    let mut long = base;
    long.accounts.push(AccountMeta::new_readonly(SYS, false));
    assert!(send(&mut e.svm, &[&payer, &agent], &[long]).is_err());
    assert_eq!(mandate_snapshot(&e, &m), before);
}

#[test]
fn gated_action_in_a_failing_transaction_unwinds_earlier_bookings() {
    // two calls in one transaction: the second exceeds the lifetime budget, so BOTH are rolled back
    let mut e = env_or_skip!();
    provision(&mut e, 15, 10, &[GATED_ACTION_DISC]);
    let m = mandate_of(&e);
    let agent = clone_kp(&e.agent);
    let payer = clone_kp(&e.owner);
    let ix = call(&e, 10).ix();
    let r = send(&mut e.svm, &[&payer, &agent], &[ix.clone(), ix]);
    expect_core_error(&r, SPEND_LIMIT_EXCEEDED);
    assert_eq!(counters(&e, &m), (0, 0));
}

#[test]
fn compute_units_are_recorded() {
    let mut e = env_or_skip!();
    provision_demo(&mut e);
    assert!(go(&mut e, 1).is_ok()); // warm: second call has equal account loading
    let r = go(&mut e, 1);
    let cu = r.as_ref().unwrap().compute_units_consumed;
    println!("gated_action CU (LiteSVM, second call): {cu}");
    assert!(cu < 30_000, "gated_action used {cu} CU");
}
