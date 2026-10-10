//! LiteSVM smoke tests for the relay: the transfer money path (with a CU
//! measurement against the spec gate) and one swap against the mock AMM.
//!
//! These are deliberately few; the full TEST-MATRIX belongs to the test
//! harness. Programs are loaded from env vars and a missing `.so` is a HARD
//! failure unless `AGENT_AUTH_ALLOW_SKIP=1`:
//!
//! * `AGENT_AUTH_SO`  core program;
//! * `AGENT_AUTH_RELAY_SO` relay built with default features (transfer tests);
//! * `AGENT_AUTH_RELAY_TESTAMM_SO` relay built with `--features test-amm` and
//!   `MOCK_AMM_SO` the mock AMM (swap test).
//!
//! Run with `--nocapture` to see the measured compute units.

#![allow(clippy::result_large_err)]

use agent_auth_relay::state::{
    CONFIG_LEN, CONFIG_OFF, OFF_AMM_AUTHORITY, OFF_AMM_CONFIG, OFF_AMM_PROGRAM, OFF_BUDGET_MINT,
    OFF_FLOOR_IN, OFF_FLOOR_OUT, OFF_INPUT_VAULT, OFF_IN_ACCOUNT, OFF_IN_MINT,
    OFF_IN_TOKEN_PROGRAM, OFF_MAX_DEADLINE_SLOTS, OFF_OBSERVATION_STATE, OFF_OUTPUT_VAULT,
    OFF_OUT_ACCOUNT, OFF_OUT_MINT, OFF_OUT_TOKEN_PROGRAM, OFF_POOL_STATE, OFF_RECIPIENTS,
    OFF_RECIPIENTS_LEN, OFF_SOURCE, OFF_SWAP_ENABLED, OFF_TOKEN_PROGRAM,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const CORE_ID: &str = "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if";
const RELAY_ID: &str = "33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6";
const MOCK_AMM_ID: &str = "6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw";
const TOKEN_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TRANSFER_CHECKED_DISC: [u8; 8] = [12, 0, 0, 0, 0, 0, 0, 0];
const SWAP_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

fn pk(s: &str) -> Pubkey {
    s.parse().unwrap()
}

/// `Some(path)` if the env var points at an existing file; hard failure
/// otherwise, unless `AGENT_AUTH_ALLOW_SKIP=1`.
fn so_path(var: &str) -> Option<String> {
    let skip = std::env::var("AGENT_AUTH_ALLOW_SKIP").as_deref() == Ok("1");
    match std::env::var(var) {
        Ok(p) if std::path::Path::new(&p).exists() => Some(p),
        other => {
            assert!(skip, "{var} is not set to an existing file ({other:?}); build the .so and set it, or set AGENT_AUTH_ALLOW_SKIP=1");
            eprintln!("skipping: {var} missing");
            None
        }
    }
}

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    mandate: Pubkey,
    policy: Pubkey,
    authority: Pubkey,
    mint: Pubkey,
    source: Pubkey,
    recipient: Pubkey,
    relay: Pubkey,
    /// Token program of the budget mint (Token unless a test switches it).
    token: Pubkey,
}

fn token_account(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    delegate: Option<(&Pubkey, u64)>,
) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    if let Some((del, dam)) = delegate {
        d[72..76].copy_from_slice(&1u32.to_le_bytes());
        d[76..108].copy_from_slice(del.as_ref());
        d[121..129].copy_from_slice(&dam.to_le_bytes());
    }
    d[108] = 1;
    d
}

fn mint_account(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1;
    d
}

fn put(svm: &mut LiteSVM, key: Pubkey, owner: &Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        key,
        Account {
            lamports,
            data,
            owner: *owner,
            ..Default::default()
        },
    )
    .unwrap();
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ixs: &[Instruction],
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let tx = Transaction::new(
        &[payer],
        Message::new(ixs, Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
}

/// `n` of `InstructionError(_, Custom(n))`, if that is how the transaction failed.
fn custom(r: &litesvm::types::TransactionResult) -> Option<u32> {
    let dbg = format!("{:?}", r.as_ref().err()?.err);
    let n = dbg.split("Custom(").nth(1)?;
    n.split(')').next()?.parse().ok()
}

/// Build the instruction first (it borrows `e`), then send it.
macro_rules! tx {
    ($e:ident, $signer:ident, $ix:expr) => {{
        let ix = $ix;
        send(&mut $e.svm, &$signer, &[ix])
    }};
}

/// Feature id of `replace_spl_token_with_p_token` (RELAY-SPEC section 11).
const P_TOKEN_FEATURE: &str = "ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP";

/// LiteSVM with the mainnet feature set. `LiteSVM::new()` has the p-token
/// feature active (the "Token" program id then runs the p-token binary); for
/// the classic spl-token binary the feature is switched off before the
/// default programs are loaded.
fn new_svm(classic_token: bool) -> LiteSVM {
    if !classic_token {
        return LiteSVM::new();
    }
    let mut features = LiteSVM::mainnet_feature_set();
    features.deactivate(&pk(P_TOKEN_FEATURE));
    LiteSVM::default()
        .with_feature_set(features)
        .with_builtins()
        .with_lamports(1_000_000 * 1_000_000_000)
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
}

fn setup(relay_so: &str, core_so: &str, classic_token: bool) -> Env {
    let mut svm = new_svm(classic_token);
    let core = pk(CORE_ID);
    let relay = pk(RELAY_ID);
    svm.add_program_from_file(core, core_so).unwrap();
    svm.add_program_from_file(relay, relay_so).unwrap();
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();

    let (mandate, _) = Pubkey::find_program_address(
        &[b"mandate", owner.pubkey().as_ref(), agent.pubkey().as_ref()],
        &core,
    );
    let (policy, _) = Pubkey::find_program_address(&[b"policy", mandate.as_ref()], &relay);
    let (authority, _) = Pubkey::find_program_address(&[b"authority", mandate.as_ref()], &relay);

    let token = pk(TOKEN_ID);
    let mint = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    put(&mut svm, mint, &token, mint_account(6));
    put(
        &mut svm,
        source,
        &token,
        token_account(
            &mint,
            &owner.pubkey(),
            10_000_000,
            Some((&authority, 4_000_000)),
        ),
    );
    put(
        &mut svm,
        recipient,
        &token,
        token_account(&mint, &Pubkey::new_unique(), 0, None),
    );

    // Mandate through the real core instructions.
    let mut create = vec![0u8];
    create.extend_from_slice(&i64::MAX.to_le_bytes());
    let create_ix = Instruction::new_with_bytes(
        core,
        &create,
        vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new_readonly(agent.pubkey(), false),
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    );
    send(&mut svm, &owner, &[create_ix]).unwrap();

    Env {
        svm,
        owner,
        agent,
        mandate,
        policy,
        authority,
        mint,
        source,
        recipient,
        relay,
        token,
    }
}

fn add_permission(e: &mut Env, program: &Pubkey, spend: u64, per_tx: u64, disc: [u8; 8]) {
    let mut d = vec![1u8];
    d.extend_from_slice(program.as_ref());
    d.extend_from_slice(&spend.to_le_bytes());
    d.extend_from_slice(&per_tx.to_le_bytes());
    d.push(1);
    d.extend_from_slice(&disc);
    let ix = Instruction::new_with_bytes(
        pk(CORE_ID),
        &d,
        vec![
            AccountMeta::new_readonly(e.owner.pubkey(), true),
            AccountMeta::new(e.mandate, false),
        ],
    );
    let owner = e.owner.insecure_clone();
    tx!(e, owner, ix).unwrap();
}

fn base_config(e: &Env) -> Vec<u8> {
    let mut c = vec![0u8; CONFIG_LEN];
    let mut w =
        |off: usize, v: &[u8]| c[off - CONFIG_OFF..off - CONFIG_OFF + v.len()].copy_from_slice(v);
    w(OFF_TOKEN_PROGRAM, e.token.as_ref());
    w(OFF_BUDGET_MINT, e.mint.as_ref());
    w(OFF_SOURCE, e.source.as_ref());
    w(OFF_RECIPIENTS_LEN, &[1]);
    w(OFF_RECIPIENTS, e.recipient.as_ref());
    c
}

fn init_policy_ix(e: &Env, flags: u8, config: &[u8]) -> Instruction {
    let mut d = vec![0u8, flags];
    d.extend_from_slice(config);
    Instruction::new_with_bytes(
        e.relay,
        &d,
        vec![
            AccountMeta::new(e.owner.pubkey(), true),
            AccountMeta::new_readonly(e.mandate, false),
            AccountMeta::new(e.policy, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    )
}

fn transfer_ix(e: &Env, dest: &Pubkey, amount: u64) -> Instruction {
    let mut d = vec![3u8];
    d.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        e.relay,
        &d,
        vec![
            AccountMeta::new_readonly(e.agent.pubkey(), true),
            AccountMeta::new(e.mandate, false),
            AccountMeta::new_readonly(e.owner.pubkey(), false),
            AccountMeta::new_readonly(e.policy, false),
            AccountMeta::new_readonly(e.authority, false),
            AccountMeta::new(e.source, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(e.mint, false),
            AccountMeta::new_readonly(e.token, false),
            AccountMeta::new_readonly(pk(CORE_ID), false),
        ],
    )
}

fn amount_of(svm: &LiteSVM, key: &Pubkey) -> u64 {
    u64::from_le_bytes(
        svm.get_account(key).unwrap().data[64..72]
            .try_into()
            .unwrap(),
    )
}

#[test]
fn transfer_happy_path_cu_and_guards_p_token() {
    transfer_happy_path_cu_and_guards(false);
}

#[test]
fn transfer_happy_path_cu_and_guards_classic_token() {
    transfer_happy_path_cu_and_guards(true);
}

fn transfer_happy_path_cu_and_guards(classic: bool) {
    let (Some(core_so), Some(relay_so)) =
        (so_path("AGENT_AUTH_SO"), so_path("AGENT_AUTH_RELAY_SO"))
    else {
        return;
    };
    let mut e = setup(&relay_so, &core_so, classic);
    add_permission(
        &mut e,
        &pk(TOKEN_ID),
        3_000_000,
        1_000_000,
        TRANSFER_CHECKED_DISC,
    );

    // init_policy
    let cfg = base_config(&e);
    let owner = e.owner.insecure_clone();
    let init = tx!(e, owner, init_policy_ix(&e, 0b10, &cfg)).expect("init_policy");
    println!("init_policy CU = {}", init.compute_units_consumed);
    let pol = e.svm.get_account(&e.policy).unwrap();
    assert_eq!(pol.data.len(), 944);
    assert_eq!(pol.owner, e.relay);
    assert_eq!(&pol.data[144..], &cfg[..]);
    // second init is rejected (113) and leaves the policy untouched
    let again = tx!(e, owner, init_policy_ix(&e, 0b10, &cfg));
    assert_eq!(custom(&again), Some(113));

    // happy path
    let agent = e.agent.insecure_clone();
    let ok = tx!(e, agent, transfer_ix(&e, &e.recipient, 500_000)).expect("transfer");
    let gate = if classic { 15_000 } else { 8_000 };
    println!(
        "transfer ({}, 1 permission, STRICT_TOP_LEVEL on) CU = {}",
        if classic {
            "classic spl-token"
        } else {
            "p-token"
        },
        ok.compute_units_consumed
    );
    assert!(
        ok.compute_units_consumed <= gate,
        "spec gate: transfer <= {gate} CU"
    );
    assert_eq!(amount_of(&e.svm, &e.source), 9_500_000);
    assert_eq!(amount_of(&e.svm, &e.recipient), 500_000);
    assert!(
        ok.logs.iter().any(|l| l.starts_with("Program data: ")),
        "TransferExecuted event"
    );

    // not an allowlisted recipient
    let attacker = Pubkey::new_unique();
    put(
        &mut e.svm,
        attacker,
        &pk(TOKEN_ID),
        token_account(&e.mint, &Pubkey::new_unique(), 0, None),
    );
    let bad = tx!(e, agent, transfer_ix(&e, &attacker, 1));
    assert_eq!(custom(&bad), Some(104));

    // per-tx cap is enforced by the core through verify
    let big = tx!(e, agent, transfer_ix(&e, &e.recipient, 1_000_001));
    assert_eq!(custom(&big), Some(8));

    // pause / unpause
    let pause = |paused: u8| {
        Instruction::new_with_bytes(
            e.relay,
            &[1, paused],
            vec![
                AccountMeta::new_readonly(e.owner.pubkey(), true),
                AccountMeta::new(e.policy, false),
            ],
        )
    };
    tx!(e, owner, pause(1)).unwrap();
    assert_eq!(
        custom(&tx!(e, agent, transfer_ix(&e, &e.recipient, 1))),
        Some(116)
    );
    tx!(e, owner, pause(0)).unwrap();
    tx!(e, agent, transfer_ix(&e, &e.recipient, 1)).unwrap();

    // close_policy returns every lamport and the agent is then refused (101)
    let before = e.svm.get_balance(&e.owner.pubkey()).unwrap();
    let rent = e.svm.get_balance(&e.policy).unwrap();
    let close = Instruction::new_with_bytes(
        e.relay,
        &[2],
        vec![
            AccountMeta::new(e.owner.pubkey(), true),
            AccountMeta::new(e.policy, false),
        ],
    );
    tx!(e, owner, close).unwrap();
    assert!(e.svm.get_account(&e.policy).is_none());
    assert_eq!(
        e.svm.get_balance(&e.owner.pubkey()).unwrap(),
        before + rent - 5000
    );
    assert_eq!(
        custom(&tx!(e, agent, transfer_ix(&e, &e.recipient, 1))),
        Some(101)
    );
}

#[test]
fn init_policy_survives_a_prefunded_pda() {
    let (Some(core_so), Some(relay_so)) =
        (so_path("AGENT_AUTH_SO"), so_path("AGENT_AUTH_RELAY_SO"))
    else {
        return;
    };
    let mut e = setup(&relay_so, &core_so, false);
    // A third party sends lamports to the not-yet-created policy PDA: the
    // 0-byte rent-exempt minimum plus a little, which is below the 944-byte rent.
    // (The runtime refuses smaller, rent-paying balances.)
    let prefund = e.svm.minimum_balance_for_rent_exemption(0) + 12_345;
    e.svm.airdrop(&e.policy, prefund).unwrap();
    let cfg = base_config(&e);
    let owner = e.owner.insecure_clone();
    tx!(e, owner, init_policy_ix(&e, 0, &cfg)).expect("init over a pre-funded PDA");
    let acct = e.svm.get_account(&e.policy).unwrap();
    assert_eq!(acct.owner, e.relay);
    assert_eq!(acct.data.len(), 944);
    assert!(acct.lamports >= e.svm.minimum_balance_for_rent_exemption(944));
}

/// Everything a swap test needs: the base env plus a mock-AMM pool.
struct SwapEnv {
    e: Env,
    amm: Pubkey,
    out_account: Pubkey,
    pool_auth: Pubkey,
    pool_state: Pubkey,
    input_vault: Pubkey,
    output_vault: Pubkey,
    amm_config: Pubkey,
    observation: Pubkey,
    out_mint: Pubkey,
}

/// Mock pool `mode` (byte 0 of the pool state), 1:1 reserves of 1e9.
fn swap_env(mode: u8) -> Option<SwapEnv> {
    let (core_so, relay_so, amm_so) = (
        so_path("AGENT_AUTH_SO")?,
        so_path("AGENT_AUTH_RELAY_TESTAMM_SO")?,
        so_path("MOCK_AMM_SO")?,
    );
    let mut e = setup(&relay_so, &core_so, false);
    let amm = pk(MOCK_AMM_ID);
    e.svm.add_program_from_file(amm, &amm_so).unwrap();
    add_permission(&mut e, &amm, 5_000_000, 2_000_000, SWAP_DISC);

    let token = pk(TOKEN_ID);
    let out_mint = Pubkey::new_unique();
    put(&mut e.svm, out_mint, &token, mint_account(6));
    let out_account = Pubkey::new_unique();
    put(
        &mut e.svm,
        out_account,
        &token,
        token_account(&out_mint, &e.owner.pubkey(), 0, None),
    );
    let (pool_auth, _) = Pubkey::find_program_address(&[b"mock_amm_auth"], &amm);
    let (input_vault, output_vault, pool_state) = (
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    put(
        &mut e.svm,
        input_vault,
        &token,
        token_account(&e.mint, &pool_auth, 1_000_000_000, None),
    );
    put(
        &mut e.svm,
        output_vault,
        &token,
        token_account(&out_mint, &pool_auth, 1_000_000_000, None),
    );
    let mut pool = vec![0u8; 104];
    pool[0] = mode;
    pool[8..40].copy_from_slice(input_vault.as_ref());
    pool[40..72].copy_from_slice(output_vault.as_ref());
    put(&mut e.svm, pool_state, &amm, pool);
    let (amm_config, observation) = (Pubkey::new_unique(), Pubkey::new_unique());

    // Swap input is the same account the transfers spend from (in_account == source).
    let mut cfg = base_config(&e);
    {
        let mut w = |off: usize, v: &[u8]| {
            cfg[off - CONFIG_OFF..off - CONFIG_OFF + v.len()].copy_from_slice(v)
        };
        w(OFF_SWAP_ENABLED, &[1]);
        w(OFF_AMM_PROGRAM, amm.as_ref());
        w(OFF_AMM_AUTHORITY, pool_auth.as_ref());
        w(OFF_AMM_CONFIG, amm_config.as_ref());
        w(OFF_POOL_STATE, pool_state.as_ref());
        w(OFF_INPUT_VAULT, input_vault.as_ref());
        w(OFF_OUTPUT_VAULT, output_vault.as_ref());
        w(OFF_OBSERVATION_STATE, observation.as_ref());
        w(OFF_IN_MINT, e.mint.as_ref());
        w(OFF_OUT_MINT, out_mint.as_ref());
        w(OFF_IN_TOKEN_PROGRAM, token.as_ref());
        w(OFF_OUT_TOKEN_PROGRAM, token.as_ref());
        w(OFF_IN_ACCOUNT, e.source.as_ref());
        w(OFF_OUT_ACCOUNT, out_account.as_ref());
        w(OFF_FLOOR_OUT, &95u64.to_le_bytes());
        w(OFF_FLOOR_IN, &100u64.to_le_bytes());
        w(OFF_MAX_DEADLINE_SLOTS, &150u32.to_le_bytes());
    }
    let owner = e.owner.insecure_clone();
    tx!(e, owner, init_policy_ix(&e, 0, &cfg)).expect("init_policy with swap");
    e.svm.warp_to_slot(1_000);
    Some(SwapEnv {
        e,
        amm,
        out_account,
        pool_auth,
        pool_state,
        input_vault,
        output_vault,
        amm_config,
        observation,
        out_mint,
    })
}

fn swap_ix(s: &SwapEnv, amount_in: u64, min_out: u64, deadline: u64) -> Instruction {
    let (e, token) = (&s.e, pk(TOKEN_ID));
    let mut d = vec![4u8];
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    d.extend_from_slice(&deadline.to_le_bytes());
    Instruction::new_with_bytes(
        e.relay,
        &d,
        vec![
            AccountMeta::new_readonly(e.agent.pubkey(), true),
            AccountMeta::new(e.mandate, false),
            AccountMeta::new_readonly(e.owner.pubkey(), false),
            AccountMeta::new_readonly(e.policy, false),
            AccountMeta::new_readonly(e.authority, false),
            AccountMeta::new(e.source, false),
            AccountMeta::new(s.out_account, false),
            AccountMeta::new_readonly(s.amm, false),
            AccountMeta::new_readonly(s.pool_auth, false),
            AccountMeta::new_readonly(s.amm_config, false),
            AccountMeta::new(s.pool_state, false),
            AccountMeta::new(s.input_vault, false),
            AccountMeta::new(s.output_vault, false),
            AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(token, false),
            AccountMeta::new_readonly(e.mint, false),
            AccountMeta::new_readonly(s.out_mint, false),
            AccountMeta::new(s.observation, false),
            AccountMeta::new_readonly(pk(CORE_ID), false),
        ],
    )
}

#[test]
fn swap_against_mock_amm() {
    let Some(mut s) = swap_env(0) else { return };
    let agent = s.e.agent.insecure_clone();
    let ix = swap_ix(&s, 1_000_000, 0, 1_100);
    let ok = send(&mut s.e.svm, &agent, &[ix]).expect("swap");
    println!(
        "swap (mock AMM NORMAL, whole tx incl. AMM) CU = {}",
        ok.compute_units_consumed
    );
    assert_eq!(amount_of(&s.e.svm, &s.e.source), 9_000_000);
    let got = amount_of(&s.e.svm, &s.out_account);
    assert!(got >= 950_000, "floor 95/100 enforced, got {got}");
    assert!(ok.logs.iter().any(|l| l.starts_with("Program data: ")));

    // Deadline window: slot 1000, max 150.
    for deadline in [1_151u64, 999] {
        let ix = swap_ix(&s, 1, 0, deadline);
        let r = send(&mut s.e.svm, &agent, &[ix]);
        assert_eq!(custom(&r), Some(111), "deadline {deadline}");
    }
    // The agent can raise but never lower the floor: min_out above the pool
    // output is refused by the AMM itself (mock Custom(7001)).
    let ix = swap_ix(&s, 1_000_000, 2_000_000, 1_100);
    assert_eq!(custom(&send(&mut s.e.svm, &agent, &[ix])), Some(7001));
}

/// RE-01/07/08: a misbehaving pinned AMM is caught by the relay's own
/// post-conditions (and nothing moves, since the transaction reverts).
#[test]
fn swap_malicious_amm_modes_are_caught() {
    // (mode, expected relay error): 1 PULL_EXTRA, 9 NOOP_OK, 10 UNDERPAY.
    // (Mode 6 REDIRECT_OUTPUT cannot pay a different mint into the input
    // account: the Token program itself rejects it with Custom(3).)
    for (mode, want) in [(1u8, 106u32), (9, 112), (10, 112)] {
        let Some(mut s) = swap_env(mode) else { return };
        let agent = s.e.agent.insecure_clone();
        let (src, out) = (
            amount_of(&s.e.svm, &s.e.source),
            amount_of(&s.e.svm, &s.out_account),
        );
        let ix = swap_ix(&s, 1_000_000, 0, 1_100);
        let r = send(&mut s.e.svm, &agent, &[ix]);
        assert_eq!(custom(&r), Some(want), "mode {mode}: {r:?}");
        assert_eq!(
            amount_of(&s.e.svm, &s.e.source),
            src,
            "mode {mode} reverted"
        );
        assert_eq!(
            amount_of(&s.e.svm, &s.out_account),
            out,
            "mode {mode} reverted"
        );
    }
}

/// RE-02 as actually reachable: the relay passes the mints read-only, so a
/// mock `BURN_IN` (a Token `Burn` needs the mint writable) is stopped by the
/// runtime with `PrivilegeEscalation` before the relay's own checks run.
/// Either way the transaction fails and nothing moves.
#[test]
fn swap_burn_mode_cannot_reach_the_burn() {
    let Some(mut s) = swap_env(2) else { return };
    let agent = s.e.agent.insecure_clone();
    let src = amount_of(&s.e.svm, &s.e.source);
    let ix = swap_ix(&s, 1_000_000, 0, 1_100);
    let r = send(&mut s.e.svm, &agent, &[ix]);
    let err = format!("{:?}", r.as_ref().err().map(|f| &f.err));
    assert!(err.contains("PrivilegeEscalation"), "{err}");
    assert_eq!(amount_of(&s.e.svm, &s.e.source), src);
}

/// CORE-09 / CORE-10 (relay side): a revoked mandate is refused (117) while the
/// policy exists, and a re-created mandate with a different expiry does not
/// re-activate the old policy (118).
#[test]
fn revoked_and_recreated_mandate_is_refused() {
    let (Some(core_so), Some(relay_so)) =
        (so_path("AGENT_AUTH_SO"), so_path("AGENT_AUTH_RELAY_SO"))
    else {
        return;
    };
    let mut e = setup(&relay_so, &core_so, false);
    add_permission(
        &mut e,
        &pk(TOKEN_ID),
        3_000_000,
        1_000_000,
        TRANSFER_CHECKED_DISC,
    );
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    let cfg = base_config(&e);
    tx!(e, owner, init_policy_ix(&e, 0, &cfg)).expect("init_policy");
    tx!(e, agent, transfer_ix(&e, &e.recipient, 1)).expect("transfer before revoke");

    let revoke = Instruction::new_with_bytes(
        pk(CORE_ID),
        &[4u8],
        vec![
            AccountMeta::new(e.owner.pubkey(), true),
            AccountMeta::new(e.mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    );
    send(&mut e.svm, &owner, &[revoke]).expect("revoke_mandate");
    assert_eq!(
        custom(&tx!(e, agent, transfer_ix(&e, &e.recipient, 1))),
        Some(117)
    );

    // Re-create the same (owner, agent) mandate with a different expiry.
    let mut create = vec![0u8];
    create.extend_from_slice(&(i64::MAX - 1).to_le_bytes());
    let create_ix = Instruction::new_with_bytes(
        pk(CORE_ID),
        &create,
        vec![
            AccountMeta::new(e.owner.pubkey(), true),
            AccountMeta::new_readonly(e.agent.pubkey(), false),
            AccountMeta::new(e.mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    );
    send(&mut e.svm, &owner, &[create_ix]).expect("re-create mandate");
    add_permission(
        &mut e,
        &pk(TOKEN_ID),
        3_000_000,
        1_000_000,
        TRANSFER_CHECKED_DISC,
    );
    assert_eq!(
        custom(&tx!(e, agent, transfer_ix(&e, &e.recipient, 1))),
        Some(118)
    );
}

/// TR-34 / TR-35: `STRICT_TOP_LEVEL` refuses a call made through another
/// program (stack height 2); without the flag the same call works. The mock
/// AMM's `proxy` instruction is the caller.
#[test]
fn strict_top_level_flag_blocks_cpi_callers() {
    let (Some(core_so), Some(relay_so), Some(amm_so)) = (
        so_path("AGENT_AUTH_SO"),
        so_path("AGENT_AUTH_RELAY_SO"),
        so_path("MOCK_AMM_SO"),
    ) else {
        return;
    };
    for (flags, want) in [(0b10u8, Some(115u32)), (0b00, None)] {
        let mut e = setup(&relay_so, &core_so, false);
        e.svm
            .add_program_from_file(pk(MOCK_AMM_ID), &amm_so)
            .unwrap();
        add_permission(
            &mut e,
            &pk(TOKEN_ID),
            3_000_000,
            1_000_000,
            TRANSFER_CHECKED_DISC,
        );
        let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
        let cfg = base_config(&e);
        tx!(e, owner, init_policy_ix(&e, flags, &cfg)).expect("init_policy");

        let inner = transfer_ix(&e, &e.recipient, 1);
        let mut data = vec![0xFF, 0x70, 0x72, 0x6F, 0x78, 0x79, 0x00, 0x00];
        data.extend_from_slice(&inner.data);
        let mut metas = vec![AccountMeta::new_readonly(e.relay, false)];
        metas.extend(inner.accounts.iter().cloned());
        let proxied = Instruction::new_with_bytes(pk(MOCK_AMM_ID), &data, metas);
        let r = send(&mut e.svm, &agent, &[proxied]);
        assert_eq!(
            custom(&r),
            want,
            "flags {flags:#04b}: {:?}",
            r.as_ref().err().map(|f| &f.err)
        );
    }
}

/// Wrong AgentAuth program account (103), unknown tag and empty data (100),
/// too many / too few accounts (NotEnoughAccountKeys), unsigned agent (107).
#[test]
fn argument_and_account_shape_guards() {
    let (Some(core_so), Some(relay_so)) =
        (so_path("AGENT_AUTH_SO"), so_path("AGENT_AUTH_RELAY_SO"))
    else {
        return;
    };
    let mut e = setup(&relay_so, &core_so, false);
    add_permission(
        &mut e,
        &pk(TOKEN_ID),
        3_000_000,
        1_000_000,
        TRANSFER_CHECKED_DISC,
    );
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    let cfg = base_config(&e);
    tx!(e, owner, init_policy_ix(&e, 0, &cfg)).expect("init_policy");

    // Fake AgentAuth program in slot 9.
    let mut ix = transfer_ix(&e, &e.recipient, 1);
    ix.accounts[9] = AccountMeta::new_readonly(pk(TOKEN_ID), false);
    assert_eq!(custom(&tx!(e, agent, ix)), Some(103));

    // Unknown tag and empty data.
    for data in [vec![5u8], vec![255u8], vec![]] {
        let ix = Instruction::new_with_bytes(e.relay, &data, vec![]);
        assert_eq!(custom(&tx!(e, agent, ix)), Some(100), "data {data:?}");
    }

    // Account count must be exact.
    let mut ix = transfer_ix(&e, &e.recipient, 1);
    ix.accounts.pop();
    let r = tx!(e, agent, ix);
    assert!(format!("{r:?}").contains("NotEnoughAccountKeys"), "{r:?}");
    let mut ix = transfer_ix(&e, &e.recipient, 1);
    ix.accounts
        .push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
    let r = tx!(e, agent, ix);
    assert!(format!("{r:?}").contains("NotEnoughAccountKeys"), "{r:?}");

    // Zero amount; agent present but not a signer (another fee payer).
    let ix = transfer_ix(&e, &e.recipient, 0);
    assert_eq!(custom(&tx!(e, agent, ix)), Some(100));
    let mut ix = transfer_ix(&e, &e.recipient, 1);
    ix.accounts[0] = AccountMeta::new_readonly(e.agent.pubkey(), false);
    assert_eq!(custom(&tx!(e, owner, ix)), Some(107));

    // init_policy needs the owner's signature (108) and the mandate's owner (109).
    let mut ix = init_policy_ix(&e, 0, &cfg);
    ix.accounts[0] = AccountMeta::new(e.owner.pubkey(), false);
    assert_eq!(custom(&tx!(e, agent, ix)), Some(108));
}

const TOKEN22_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// A Token-2022 account as the Associated Token Account program creates it:
/// 165 base bytes + AccountType (2) + the ImmutableOwner TLV (type 7, len 0).
fn token22_ata_account(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    delegate: Option<(&Pubkey, u64)>,
) -> Vec<u8> {
    let mut d = token_account(mint, owner, amount, delegate);
    d.push(2);
    d.extend_from_slice(&[7, 0, 0, 0]);
    assert_eq!(d.len(), 170);
    d
}

/// T22-01/T22-07 on the real Token-2022 program: an extension-free mint and
/// ATA-shaped 170-byte accounts work; a mint with an extension (longer than 82
/// bytes) is refused with 103.
#[test]
fn transfer_token2022_ata_shaped_accounts() {
    let (Some(core_so), Some(relay_so)) =
        (so_path("AGENT_AUTH_SO"), so_path("AGENT_AUTH_RELAY_SO"))
    else {
        return;
    };
    let mut e = setup(&relay_so, &core_so, false);
    let t22 = pk(TOKEN22_ID);
    e.token = t22;
    let other_owner = Pubkey::new_unique();
    put(&mut e.svm, e.mint, &t22, mint_account(6));
    put(
        &mut e.svm,
        e.source,
        &t22,
        token22_ata_account(
            &e.mint,
            &e.owner.pubkey(),
            10_000_000,
            Some((&e.authority, 4_000_000)),
        ),
    );
    put(
        &mut e.svm,
        e.recipient,
        &t22,
        token22_ata_account(&e.mint, &other_owner, 0, None),
    );
    add_permission(&mut e, &t22, 3_000_000, 1_000_000, TRANSFER_CHECKED_DISC);
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    let cfg = base_config(&e);
    tx!(e, owner, init_policy_ix(&e, 0, &cfg)).expect("init_policy (Token-2022)");
    let ok = tx!(e, agent, transfer_ix(&e, &e.recipient, 700_000)).expect("transfer (Token-2022)");
    println!(
        "transfer (Token-2022 ATA-shaped) CU = {}",
        ok.compute_units_consumed
    );
    assert_eq!(amount_of(&e.svm, &e.source), 9_300_000);
    assert_eq!(amount_of(&e.svm, &e.recipient), 700_000);

    // A mint carrying an extension is longer than 82 bytes: refused up front.
    let mut long_mint = mint_account(6);
    long_mint.resize(100, 0);
    put(&mut e.svm, e.mint, &t22, long_mint);
    assert_eq!(
        custom(&tx!(e, agent, transfer_ix(&e, &e.recipient, 1))),
        Some(103)
    );
}
