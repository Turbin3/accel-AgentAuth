//! End-to-end tests against the program deployed on devnet.
//!
//! These talk to a live cluster, so they're `#[ignore]` by default. Run with a
//! funded payer keypair file (the owner/fee-payer for every tx):
//!
//!   AA_PAYER=/path/to/payer.json \
//!     cargo test --test devnet -- --ignored --nocapture
//!
//! Each run uses a fresh random agent, so the mandate PDA is unique and runs
//! never collide. The lifecycle test cleans up after itself via revoke.

mod common;

use common::integration::{
    add_permission_ix, create_mandate_ix, mandate_pda, remove_permission_ix, revoke_mandate_ix,
    verify_ix, Instruction, Keypair, Message, Pubkey, Signer, Transaction, DISC,
};
// layout constants come through integration's `pub use agent_auth::*`
use common::integration::{
    HEADER_SIZE, MANDATE_DISCRIMINATOR, OFF_ACTIVE, OFF_AGENT, OFF_DISC, OFF_OWNER, OFF_PERM_LEN,
    P_CALL_COUNT, P_PROGRAM_ID, P_SPEND_TOTAL,
};

use solana_commitment_config::CommitmentConfig;
use solana_keypair::read_keypair_file;
use solana_rpc_client::rpc_client::RpcClient;

const DEVNET: &str = "https://api.devnet.solana.com";
// A real devnet program, used as the permission target.
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

fn client() -> RpcClient {
    RpcClient::new_with_commitment(DEVNET.to_string(), CommitmentConfig::confirmed())
}

fn payer() -> Keypair {
    let path = std::env::var("AA_PAYER")
        .expect("set AA_PAYER=/path/to/payer.json to run the devnet tests");
    read_keypair_file(&path).expect("could not read AA_PAYER keypair file")
}

/// Send + confirm. Returns the signature string on success, or a debug string of
/// the error (which carries `custom program error: 0xN`) on failure.
fn send(c: &RpcClient, fee_payer: &Keypair, signers: &[&Keypair], ixs: &[Instruction]) -> Result<String, String> {
    let bh = c.get_latest_blockhash().map_err(|e| e.to_string())?;
    let tx = Transaction::new(signers, Message::new(ixs, Some(&fee_payer.pubkey())), bh);
    c.send_and_confirm_transaction(&tx)
        .map(|s| s.to_string())
        .map_err(|e| format!("{e:?}"))
}

fn account_data(c: &RpcClient, key: &Pubkey) -> Vec<u8> {
    c.get_account_data(key).expect("account should exist")
}

fn perm_len(data: &[u8]) -> u16 {
    u16::from_le_bytes(data[OFF_PERM_LEN..OFF_PERM_LEN + 2].try_into().unwrap())
}

/// Assert a failed tx carried the expected custom error code.
fn assert_custom(result: Result<String, String>, code: u8) {
    match result {
        Ok(sig) => panic!("expected custom error 0x{code:x}, but tx succeeded: {sig}"),
        Err(e) => assert!(
            e.contains(&format!("0x{code:x}")),
            "expected custom error 0x{code:x}, got: {e}"
        ),
    }
}

#[test]
#[ignore = "hits live devnet; needs AA_PAYER"]
fn devnet_full_lifecycle() {
    let c = client();
    let owner = payer();
    let agent = Keypair::new(); // signs verify; never funded (not the fee-payer)
    let token: Pubkey = TOKEN_PROGRAM.parse().unwrap();
    let (mandate, _bump) = mandate_pda(&owner.pubkey(), &agent.pubkey());

    let far_future = 4_000_000_000i64;
    let spend_limit = 1_000_000u64;
    let per_tx = 100_000u64;

    // create the mandate
    send(&c, &owner, &[&owner], &[create_mandate_ix(&owner.pubkey(), &agent.pubkey(), far_future)])
        .expect("create_mandate failed");
    let d = account_data(&c, &mandate);
    assert_eq!(d[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_eq!(&d[OFF_OWNER..OFF_OWNER + 32], owner.pubkey().as_ref());
    assert_eq!(&d[OFF_AGENT..OFF_AGENT + 32], agent.pubkey().as_ref());
    assert_eq!(d[OFF_ACTIVE], 1);
    assert_eq!(perm_len(&d), 0);

    // add a permission for the token program
    send(&c, &owner, &[&owner],
        &[add_permission_ix(&owner.pubkey(), &agent.pubkey(), &token, spend_limit, per_tx, &[DISC])])
        .expect("add_permission failed");
    let d = account_data(&c, &mandate);
    assert_eq!(perm_len(&d), 1);
    let p0 = HEADER_SIZE;
    assert_eq!(&d[p0 + P_PROGRAM_ID..p0 + P_PROGRAM_ID + 32], token.as_ref());

    // happy verify (agent signs)
    send(&c, &owner, &[&owner, &agent],
        &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &token, &DISC, 50_000)])
        .expect("verify happy path failed");
    let d = account_data(&c, &mandate);
    let spend = u64::from_le_bytes(d[p0 + P_SPEND_TOTAL..p0 + P_SPEND_TOTAL + 8].try_into().unwrap());
    let calls = u32::from_le_bytes(d[p0 + P_CALL_COUNT..p0 + P_CALL_COUNT + 4].try_into().unwrap());
    assert_eq!(spend, 50_000);
    assert_eq!(calls, 1);

    // rejections
    // per-tx limit exceeded (8)
    assert_custom(
        send(&c, &owner, &[&owner, &agent],
            &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &token, &DISC, 200_000)]),
        8,
    );
    // program not in the allow-list (6)
    let stranger = Pubkey::new_unique();
    assert_custom(
        send(&c, &owner, &[&owner, &agent],
            &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &stranger, &DISC, 1)]),
        6,
    );
    // discriminator not allowed (7)
    assert_custom(
        send(&c, &owner, &[&owner, &agent],
            &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &token, &[9; 8], 1)]),
        7,
    );

    // second verify, writeback should accumulate
    send(&c, &owner, &[&owner, &agent],
        &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &token, &DISC, 50_000)])
        .expect("second verify failed");
    let d = account_data(&c, &mandate);
    let spend = u64::from_le_bytes(d[p0 + P_SPEND_TOTAL..p0 + P_SPEND_TOTAL + 8].try_into().unwrap());
    let calls = u32::from_le_bytes(d[p0 + P_CALL_COUNT..p0 + P_CALL_COUNT + 4].try_into().unwrap());
    assert_eq!(spend, 100_000);
    assert_eq!(calls, 2);

    // remove the permission
    send(&c, &owner, &[&owner],
        &[remove_permission_ix(&owner.pubkey(), &agent.pubkey(), &token)])
        .expect("remove_permission failed");
    assert_eq!(perm_len(&account_data(&c, &mandate)), 0);
    // verify now fails: program no longer allowed (6)
    assert_custom(
        send(&c, &owner, &[&owner, &agent],
            &[verify_ix(&mandate, &owner.pubkey(), &agent.pubkey(), &token, &DISC, 1)]),
        6,
    );

    // revoke, account should be closed
    send(&c, &owner, &[&owner], &[revoke_mandate_ix(&owner.pubkey(), &agent.pubkey())])
        .expect("revoke_mandate failed");
    match c.get_account(&mandate) {
        Err(_) => {} // purged
        Ok(acc) => assert_eq!(acc.lamports, 0, "mandate should be closed after revoke"),
    }
}

#[test]
#[ignore = "hits live devnet; needs AA_PAYER"]
fn devnet_dispatch_rejects_unknown_tag() {
    let c = client();
    let owner = payer();
    // tag 9 is not a real instruction -> InvalidDiscriminator (1)
    let ix = Instruction::new_with_bytes(common::integration::program_id(), &[9u8], vec![]);
    assert_custom(send(&c, &owner, &[&owner], &[ix]), 1);
}
