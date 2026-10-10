//! Regression tests for the lifecycle findings of the 2026-10 review: griefing
//! by pre-funding, zombie accounts after revoke, pause/resume, limit updates
//! and creation-time validation. Each test asserts the FIXED behaviour.

mod regression_support;

use regression_support::*;

use agent_auth::*;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;

macro_rules! setup {
    () => {
        match env() {
            Some(e) => e,
            None => return,
        }
    };
}

fn rent() -> u64 {
    // LiteSVM's default rent: same figure the program reads from the sysvar.
    let svm = litesvm::LiteSVM::new();
    svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE)
}

fn system_transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction::new_with_bytes(
        solana_sdk_ids::system_program::ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
    )
}

// --- create_mandate ---------------------------------------------------------

#[test]
fn create_writes_header_version_and_bump() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));

    let acc = e.account().unwrap();
    assert_eq!(acc.owner, program_id());
    assert_eq!(acc.data.len(), ACCOUNT_SIZE);
    assert_eq!(acc.lamports, rent());
    let d = &acc.data;
    assert_eq!(d[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_eq!(&d[OFF_OWNER..OFF_OWNER + 32], e.owner_key().as_ref());
    assert_eq!(&d[OFF_AGENT..OFF_AGENT + 32], e.agent_key().as_ref());
    assert_eq!(
        i64::from_le_bytes(d[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap()),
        FUTURE
    );
    assert_eq!(d[OFF_ACTIVE], 1);
    assert_eq!(perm_len(d), 0);
    assert_eq!(d[OFF_VERSION], CURRENT_VERSION);
    assert_eq!(d[OFF_BUMP], e.bump());
    // reserved bytes stay zero
    assert!(d[74..77].iter().all(|&b| b == 0));
    assert!(d[81..HEADER_SIZE].iter().all(|&b| b == 0));
    assert!(d[HEADER_SIZE..].iter().all(|&b| b == 0));
}

#[test]
fn create_rejects_owner_as_agent() {
    let mut e = setup!();
    let owner = e.owner_key();
    let ix = create_ix(&owner, &owner, FUTURE);
    assert_code(e.run(ix), E::InvalidAgent);
}

#[test]
fn create_rejects_expiry_not_in_the_future() {
    let mut e = setup!();
    for bad in [NOW, NOW - 1, 0, -1, i64::MIN] {
        assert_code(e.create(bad), E::InvalidExpiry);
    }
    assert!(
        e.account().is_none(),
        "a rejected create must leave nothing behind"
    );
    assert_ok(e.create(NOW + 1));
}

#[test]
fn create_requires_exact_data_length() {
    let mut e = setup!();
    let (owner, agent) = (e.owner_key(), e.agent_key());
    for len in [0usize, 7, 9, 16] {
        let mut ix = create_ix(&owner, &agent, FUTURE);
        ix.data.truncate(1);
        ix.data.resize(1 + len, 0);
        assert_code(e.run(ix), E::InvalidInstructionData);
    }
}

#[test]
fn create_requires_owner_signature() {
    let mut e = setup!();
    let (owner, agent) = (e.owner_key(), e.agent_key());
    let mut ix = create_ix(&owner, &agent, FUTURE);
    ix.accounts[0].is_signer = false;
    // someone else pays; the owner never signs
    let payer = solana_keypair::Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    assert_code(e.run_as(&payer, &[ix]), E::InvalidSigner);
}

#[test]
fn create_rejects_wrong_pda_address() {
    let mut e = setup!();
    let (owner, agent) = (e.owner_key(), e.agent_key());
    let mut ix = create_ix(&owner, &agent, FUTURE);
    ix.accounts[2].pubkey = Pubkey::new_unique();
    assert_code(e.run(ix), E::InvalidAccountType);
}

#[test]
fn create_rejects_second_create() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    // different expiry so the failure is not an AlreadyProcessed replay
    assert_code(e.create(FUTURE + 1), E::AlreadyInitialized);
    // and the first mandate is untouched
    let d = e.data();
    assert_eq!(
        i64::from_le_bytes(d[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap()),
        FUTURE
    );
}

#[test]
fn prefunded_pda_does_not_block_create() {
    // LIFE-1 / ACCT-1 / CPI-5 / MEM-1 / SPEC-4 / TESTS-10: anyone can send
    // lamports to the predictable address. create_mandate must still work.
    let mut e = setup!();
    let griefer = solana_keypair::Keypair::new();
    e.svm.airdrop(&griefer.pubkey(), 1_000_000_000).unwrap();
    let mandate = e.mandate();
    // the smallest donation the runtime accepts for a 0-byte account
    let floor = e.svm.minimum_balance_for_rent_exemption(0);
    assert_ok(e.run_as(
        &griefer,
        &[system_transfer(&griefer.pubkey(), &mandate, floor)],
    ));
    assert_eq!(
        e.svm.get_account(&mandate).unwrap().owner,
        solana_sdk_ids::system_program::ID
    );

    assert_ok(e.create(FUTURE));

    let acc = e.account().unwrap();
    assert_eq!(acc.owner, program_id());
    assert_eq!(acc.data.len(), ACCOUNT_SIZE);
    assert_eq!(
        acc.lamports,
        rent(),
        "topped up to exactly the rent-exempt minimum"
    );
    assert_eq!(acc.data[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_eq!(acc.data[OFF_BUMP], e.bump());
    // and the mandate is fully usable
    assert_ok(e.add(&Pubkey::new_unique(), 1, 1, &[DISC]));
}

#[test]
fn overfunded_pda_keeps_the_surplus_and_does_not_charge_the_owner_rent() {
    let mut e = setup!();
    let mandate = e.mandate();
    let donation = rent() * 2;
    e.svm
        .set_account(
            mandate,
            Account {
                lamports: donation,
                ..Default::default()
            },
        )
        .unwrap();
    let before = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_ok(e.create(FUTURE));
    let after = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_eq!(e.account().unwrap().lamports, donation);
    assert_eq!(before - after, 5_000, "owner only pays the transaction fee");
}

#[test]
fn tiny_prefund_is_topped_up() {
    // 1 lamport cannot be sent by a transfer (rent floor) but can exist in
    // genesis-style state; create must still cope.
    let mut e = setup!();
    let mandate = e.mandate();
    e.svm
        .set_account(
            mandate,
            Account {
                lamports: 1,
                ..Default::default()
            },
        )
        .unwrap();
    assert_ok(e.create(FUTURE));
    assert_eq!(e.account().unwrap().lamports, rent());
}

fn husk(e: &mut Env, lamports: u64, data: Vec<u8>) {
    let mandate = e.mandate();
    e.svm
        .set_account(
            mandate,
            Account {
                lamports,
                data,
                owner: program_id(),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn program_owned_zero_husk_is_adopted() {
    // The v0.1 revoke left exactly this behind when refunded in the same tx.
    let mut e = setup!();
    let mut dirty = vec![0u8; ACCOUNT_SIZE];
    dirty[HEADER_SIZE + 5] = 0xAA; // stale bytes in the permission area
    husk(&mut e, 7, dirty);
    assert_ok(e.create(FUTURE));
    let acc = e.account().unwrap();
    assert_eq!(acc.lamports, rent());
    assert_eq!(acc.data[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert!(
        acc.data[HEADER_SIZE..].iter().all(|&b| b == 0),
        "stale bytes are wiped"
    );
}

#[test]
fn husk_with_enough_lamports_costs_the_owner_only_the_fee() {
    let mut e = setup!();
    husk(&mut e, rent() + 1, vec![0u8; ACCOUNT_SIZE]);
    let before = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_ok(e.create(FUTURE));
    let after = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_eq!(before - after, 5_000);
}

#[test]
fn program_owned_accounts_of_the_wrong_shape_are_refused() {
    let mut e = setup!();
    // initialised -> AlreadyInitialized
    let mut live = vec![0u8; ACCOUNT_SIZE];
    live[OFF_DISC] = MANDATE_DISCRIMINATOR;
    husk(&mut e, rent(), live);
    assert_code(e.create(FUTURE), E::AlreadyInitialized);
    // unknown discriminator -> InvalidAccountType
    let mut odd = vec![0u8; ACCOUNT_SIZE];
    odd[OFF_DISC] = 7;
    husk(&mut e, rent(), odd);
    assert_code(e.create(FUTURE), E::InvalidAccountType);
    // wrong size -> InvalidAccountType
    husk(&mut e, rent(), vec![0u8; 100]);
    assert_code(e.create(FUTURE), E::InvalidAccountType);
}

#[test]
fn account_owned_by_a_foreign_program_is_refused() {
    let mut e = setup!();
    let mandate = e.mandate();
    e.svm
        .set_account(
            mandate,
            Account {
                lamports: rent(),
                owner: Pubkey::new_unique(),
                ..Default::default()
            },
        )
        .unwrap();
    assert_code(e.create(FUTURE), E::AccountOwnerMismatch);
}

// --- revoke_mandate ---------------------------------------------------------

#[test]
fn revoke_is_a_real_close() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let before = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_ok(e.revoke());
    let after = e.svm.get_account(&e.owner_key()).unwrap().lamports;

    assert_eq!(
        after - before + 5_000,
        rent(),
        "every lamport goes back to the owner"
    );
    // LiteSVM drops accounts with 0 lamports; if one is kept it must be inert.
    if let Some(acc) = e.account() {
        assert_eq!(acc.lamports, 0);
        assert!(acc.data.is_empty());
        assert_eq!(acc.owner, solana_sdk_ids::system_program::ID);
    }
}

#[test]
fn revoke_then_recreate_in_a_later_transaction() {
    let mut e = setup!();
    let target = Pubkey::new_unique();
    assert_ok(e.create(FUTURE));
    assert_ok(e.add(&target, 100, 0, &[DISC]));
    assert_ok(e.verify(&target, &DISC, 40));
    assert_ok(e.revoke());

    // the mandate is gone for verify...
    assert_code(e.verify(&target, &DISC, 1), E::AccountOwnerMismatch);
    // ...and the owner can create a fresh one at the same address, from zero
    assert_ok(e.create(FUTURE + 10));
    let d = e.data();
    assert_eq!(perm_len(&d), 0);
    assert_ok(e.add(&target, 100, 0, &[DISC]));
    assert_eq!(
        spend_total(&e.data(), 0),
        0,
        "history does not survive re-creation"
    );
}

#[test]
fn revoke_plus_refund_in_one_transaction_does_not_brick_the_pair() {
    // LIFE-2 / ACCT-6 / CPI-6 / MEM-2: v0.1 left a program-owned zero husk.
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (owner_key, mandate) = (e.owner_key(), e.mandate());
    let tx = [
        revoke_ix(&owner_key, &mandate),
        system_transfer(&owner_key, &mandate, rent()),
    ];
    assert_ok(e.run_as(&e.owner.insecure_clone(), &tx));

    // whatever is left at the address is a plain system account...
    let acc = e.account().expect("the refund recreated the account");
    assert_eq!(acc.owner, solana_sdk_ids::system_program::ID);
    assert!(acc.data.is_empty());
    // ...so the pair still works, in a later transaction.
    assert_ok(e.create(FUTURE));
    assert_eq!(e.account().unwrap().data[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_ok(e.revoke());
}

#[test]
fn revoke_then_create_in_one_transaction_resets_the_mandate() {
    // LIFE-3: an owner who revokes and re-creates atomically gets a clean
    // mandate (counters at zero). That is the owner's right; the relay binds
    // to the stored expiry as a generation marker for exactly this reason.
    let mut e = setup!();
    let target = Pubkey::new_unique();
    assert_ok(e.create(FUTURE));
    assert_ok(e.add(&target, 100, 0, &[DISC]));
    assert_ok(e.verify(&target, &DISC, 90));
    let (o, a, m) = (e.owner_key(), e.agent_key(), e.mandate());
    let tx = [revoke_ix(&o, &m), create_ix(&o, &a, FUTURE + 123)];
    assert_ok(e.run_as(&e.owner.insecure_clone(), &tx));
    let d = e.data();
    assert_eq!(perm_len(&d), 0);
    assert_eq!(
        i64::from_le_bytes(d[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap()),
        FUTURE + 123
    );
}

#[test]
fn revoke_authorization_and_shape() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (owner, mandate) = (e.owner_key(), e.mandate());

    // trailing data
    let mut ix = revoke_ix(&owner, &mandate);
    ix.data.push(0);
    assert_code(e.run(ix), E::InvalidInstructionData);
    // missing accounts
    let mut ix = revoke_ix(&owner, &mandate);
    ix.accounts.truncate(1);
    assert_code(e.run(ix), E::InvalidInstructionData);
    // owner did not sign
    let mut ix = revoke_ix(&owner, &mandate);
    ix.accounts[0].is_signer = false;
    let payer = solana_keypair::Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    assert_code(e.run_as(&payer, &[ix]), E::InvalidSigner);
    // a stranger signs for somebody else's mandate
    let attacker = solana_keypair::Keypair::new();
    e.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = revoke_ix(&attacker.pubkey(), &mandate);
    assert_code(e.run_as(&attacker, &[ix]), E::NotOwner);
    // nothing above changed the mandate
    assert_eq!(e.account().unwrap().data[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_ok(e.revoke());
    // a mandate that no longer exists is "not ours"
    assert_code(e.revoke(), E::AccountOwnerMismatch);
}

/// Write a mandate account directly, as the v0.1 binary (or an attacker with a
/// hand-made account) could have produced it.
fn put_mandate(e: &mut Env, address: Pubkey, version: u8, bump: u8, agent: &Pubkey) {
    let mut data = vec![0u8; ACCOUNT_SIZE];
    data[OFF_DISC] = MANDATE_DISCRIMINATOR;
    data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(e.owner_key().as_ref());
    data[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(agent.as_ref());
    data[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&FUTURE.to_le_bytes());
    data[OFF_ACTIVE] = 1;
    data[OFF_VERSION] = version;
    data[OFF_BUMP] = bump;
    e.svm
        .set_account(
            address,
            Account {
                lamports: rent(),
                data,
                owner: program_id(),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn revoke_accepts_legacy_mandates_without_a_stored_bump() {
    // Accounts created by the v0.1 binary have version 0 and bump 0.
    let mut e = setup!();
    let (mandate, agent) = (e.mandate(), e.agent_key());
    put_mandate(&mut e, mandate, 0, 0, &agent);
    assert_ok(e.revoke());
    assert!(e.account().is_none());
}

#[test]
fn revoke_checks_the_address_against_the_stored_bump() {
    let mut e = setup!();
    let (mandate, agent, bump) = (e.mandate(), e.agent_key(), e.bump());
    // right bump: fine
    put_mandate(&mut e, mandate, CURRENT_VERSION, bump, &agent);
    assert_ok(e.revoke());
    // wrong bump: refused, whatever the header says
    put_mandate(
        &mut e,
        mandate,
        CURRENT_VERSION,
        bump.wrapping_sub(1),
        &agent,
    );
    assert_code(e.revoke(), E::InvalidAccountType);
    // a hand-made program-owned account at some other address
    let other = Pubkey::new_unique();
    put_mandate(&mut e, other, CURRENT_VERSION, bump, &agent);
    let ix = revoke_ix(&e.owner_key(), &other);
    assert_code(e.run(ix), E::InvalidAccountType);
    assert!(
        e.svm.get_account(&other).is_some(),
        "refused revoke closes nothing"
    );
}

// --- pause / resume ----------------------------------------------------------

#[test]
fn set_active_pauses_and_resumes_without_losing_state() {
    let Some((mut e, target)) = Env::with_permission(1_000, 0) else {
        return;
    };
    assert_ok(e.verify(&target, &DISC, 100));

    assert_ok(e.set_active(0));
    assert_eq!(e.data()[OFF_ACTIVE], 0);
    assert_code(e.verify(&target, &DISC, 1), E::NotActive);
    // every other mutator is refused while paused
    assert_code(e.add(&Pubkey::new_unique(), 1, 1, &[DISC]), E::NotActive);
    assert_code(e.remove(&target), E::NotActive);
    assert_code(e.update(&target, 5, 5), E::NotActive);
    // pausing twice is fine
    assert_ok(e.set_active(0));

    assert_ok(e.set_active(1));
    assert_eq!(e.data()[OFF_ACTIVE], 1);
    assert_ok(e.verify(&target, &DISC, 100));
    let d = e.data();
    assert_eq!(
        spend_total(&d, 0),
        200,
        "pausing did not reset the counters"
    );
    assert_eq!(call_count(&d, 0), 2);
    assert_eq!(perm_len(&d), 1);
}

#[test]
fn paused_mandate_can_still_be_revoked() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    assert_ok(e.set_active(0));
    assert_ok(e.revoke());
    assert!(e.account().is_none());
}

#[test]
fn set_active_validates_input_and_caller() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (owner, mandate) = (e.owner_key(), e.mandate());

    for bad in [
        vec![5u8],
        vec![5, 2],
        vec![5, 255],
        vec![5, 1, 0],
        vec![5, 0, 0],
    ] {
        assert_code(
            e.run(owner_ix(&owner, &mandate, bad)),
            E::InvalidInstructionData,
        );
    }
    // accounts
    let mut ix = set_active_ix(&owner, &mandate, 0);
    ix.accounts.truncate(1);
    assert_code(e.run(ix), E::InvalidInstructionData);
    // unsigned owner
    let payer = solana_keypair::Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut ix = set_active_ix(&owner, &mandate, 0);
    ix.accounts[0].is_signer = false;
    assert_code(e.run_as(&payer, &[ix]), E::InvalidSigner);
    // somebody else's mandate
    let attacker = solana_keypair::Keypair::new();
    e.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = set_active_ix(&attacker.pubkey(), &mandate, 0);
    assert_code(e.run_as(&attacker, &[ix]), E::NotOwner);
    // not our account
    let ix = set_active_ix(&owner, &Pubkey::new_unique(), 0);
    assert_code(e.run(ix), E::AccountOwnerMismatch);
    // read-only mandate
    let mut ix = set_active_ix(&owner, &mandate, 0);
    ix.accounts[1].is_writable = false;
    assert_builtin(e.run(ix), "InvalidAccountData");
    assert_eq!(e.data()[OFF_ACTIVE], 1, "no failed call changed the flag");
}

// --- update_permission -------------------------------------------------------

#[test]
fn update_permission_keeps_the_spent_budget() {
    // MATH-10 / LIFE-5: remove+add used to hand the agent a fresh budget.
    let Some((mut e, target)) = Env::with_permission(1_000, 500) else {
        return;
    };
    assert_ok(e.verify(&target, &DISC, 400));
    assert_ok(e.verify(&target, &DISC, 400));

    // lower the cap below what is left: 800 spent of 900
    assert_ok(e.update(&target, 900, 300));
    let d = e.data();
    assert_eq!(spend_total(&d, 0), 800);
    assert_eq!(call_count(&d, 0), 2);
    assert_eq!(u64_at(&d, HEADER_SIZE + P_SPEND_LIMIT), 900);
    assert_eq!(u64_at(&d, HEADER_SIZE + P_PER_TX_LIMIT), 300);
    assert_eq!(
        &d[HEADER_SIZE + P_DISCRIMINATORS..HEADER_SIZE + P_DISCRIMINATORS + 8],
        &DISC
    );

    assert_code(e.verify(&target, &DISC, 301), E::PerTxExceeded);
    assert_code(e.verify(&target, &DISC, 200), E::SpendLimitExceeded);
    assert_ok(e.verify(&target, &DISC, 100));
    assert_code(e.verify(&target, &DISC, 1), E::SpendLimitExceeded);

    // raising it re-opens exactly the difference
    assert_ok(e.update(&target, 1_000, 300));
    assert_ok(e.verify(&target, &DISC, 100));
    assert_code(e.verify(&target, &DISC, 1), E::SpendLimitExceeded);
}

#[test]
fn update_permission_errors() {
    let Some((mut e, target)) = Env::with_permission(1_000, 0) else {
        return;
    };
    let (owner, mandate) = (e.owner_key(), e.mandate());

    assert_code(e.update(&Pubkey::new_unique(), 1, 1), E::PermissionNotFound);
    for len in [0usize, 31, 47, 49, 64] {
        let mut data = vec![6u8];
        data.resize(1 + len, 0);
        assert_code(
            e.run(owner_ix(&owner, &mandate, data)),
            E::InvalidInstructionData,
        );
    }
    let attacker = solana_keypair::Keypair::new();
    e.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let ix = update_ix(&attacker.pubkey(), &mandate, &target, 0, 0);
    assert_code(e.run_as(&attacker, &[ix]), E::NotOwner);
    let payer = solana_keypair::Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut ix = update_ix(&owner, &mandate, &target, 0, 0);
    ix.accounts[0].is_signer = false;
    assert_code(e.run_as(&payer, &[ix]), E::InvalidSigner);
    let ix = update_ix(&owner, &Pubkey::new_unique(), &target, 0, 0);
    assert_code(e.run(ix), E::AccountOwnerMismatch);
    // nothing changed
    assert_eq!(u64_at(&e.data(), HEADER_SIZE + P_SPEND_LIMIT), 1_000);
}

// --- add / remove ------------------------------------------------------------

#[test]
fn add_permission_rules() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let t = Pubkey::new_unique();

    assert_code(e.add(&t, 1, 1, &[]), E::EmptyDiscriminators);
    assert_code(e.add(&t, 1, 1, &[DISC; 9]), E::TooManyDiscriminators);
    assert_ok(e.add(&t, 1, 1, &[DISC; 8]));
    assert_code(e.add(&t, 2, 2, &[DISC]), E::DuplicatePermission);
    assert_eq!(perm_len(&e.data()), 1);
}

#[test]
fn add_permission_requires_exact_data_length() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (owner, mandate) = (e.owner_key(), e.mandate());
    let good = add_ix(&owner, &mandate, &Pubkey::new_unique(), 1, 1, &[DISC, DISC]).data;
    assert_eq!(good.len(), 50 + 16);

    for cut in [1usize, 7, 8, 9] {
        let data = good[..good.len() - cut].to_vec();
        assert_code(
            e.run(owner_ix(&owner, &mandate, data)),
            E::InvalidInstructionData,
        );
    }
    for extra in [1usize, 8] {
        let mut data = good.clone();
        data.extend(std::iter::repeat_n(0u8, extra));
        assert_code(
            e.run(owner_ix(&owner, &mandate, data)),
            E::InvalidInstructionData,
        );
    }
    // a disc_len that disagrees with the payload
    let mut data = good.clone();
    data[49] = 1;
    assert_code(
        e.run(owner_ix(&owner, &mandate, data)),
        E::InvalidInstructionData,
    );
    // (49 bytes would be a well-formed request with zero discriminators -> 22)
    for len in [0usize, 1, 32, 48] {
        let mut data = vec![1u8];
        data.resize(len + 1, 0);
        assert_code(
            e.run(owner_ix(&owner, &mandate, data)),
            E::InvalidInstructionData,
        );
    }
    assert_eq!(perm_len(&e.data()), 0);
    assert_ok(e.run(owner_ix(&owner, &mandate, good)));
}

#[test]
fn all_sixteen_permissions_with_eight_discriminators_each() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let discs: Vec<[u8; 8]> = (0..8u8).map(|i| [i, 1, 2, 3, 4, 5, 6, 7]).collect();
    let targets: Vec<Pubkey> = (0..MAX_PERMISSIONS).map(|_| Pubkey::new_unique()).collect();
    for t in &targets {
        assert_ok(e.add(t, 0, 0, &discs));
    }
    assert_code(
        e.add(&Pubkey::new_unique(), 0, 0, &[DISC]),
        E::PermissionsFull,
    );
    // the last slot's last discriminator is reachable
    assert_ok(e.verify(&targets[15], &discs[7], 1));
    assert_eq!(call_count(&e.data(), 15), 1);
    assert_eq!(call_count(&e.data(), 0), 0);
}

#[test]
fn remove_permission_swaps_and_keeps_other_counters() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let ts: Vec<Pubkey> = (0..3).map(|_| Pubkey::new_unique()).collect();
    for t in &ts {
        assert_ok(e.add(t, 0, 0, &[DISC]));
    }
    assert_ok(e.verify(&ts[2], &DISC, 7));
    assert_ok(e.remove(&ts[0]));

    let d = e.data();
    assert_eq!(perm_len(&d), 2);
    // ts[2] moved into slot 0 with its counters; the tail slot is zeroed
    assert_eq!(&d[HEADER_SIZE..HEADER_SIZE + 32], ts[2].as_ref());
    assert_eq!(spend_total(&d, 0), 7);
    assert!(d[HEADER_SIZE + 2 * PERMISSION_SIZE..]
        .iter()
        .all(|&b| b == 0));

    assert_code(e.remove(&ts[0]), E::PermissionNotFound);
    assert_code(e.verify(&ts[0], &DISC, 1), E::ProgramNotAllowed);
    assert_ok(e.verify(&ts[1], &DISC, 1));
}

#[test]
fn remove_permission_requires_exact_data_length() {
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (owner, mandate) = (e.owner_key(), e.mandate());
    for len in [0usize, 31, 33, 40] {
        let mut data = vec![2u8];
        data.resize(1 + len, 0);
        assert_code(
            e.run(owner_ix(&owner, &mandate, data)),
            E::InvalidInstructionData,
        );
    }
}

#[test]
fn owner_instructions_share_one_error_contract() {
    // LIFE-9 / SPEC-9 / ACCT-2 / ACCT-3 / MEM-4 / TESTS-5: the same condition
    // maps to the same code in every instruction.
    let Some((mut e, target)) = Env::with_permission(100, 0) else {
        return;
    };
    let (owner, mandate) = (e.owner_key(), e.mandate());
    let stranger = solana_keypair::Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let payer = solana_keypair::Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let make = |who: &Pubkey, m: &Pubkey| -> Vec<Instruction> {
        vec![
            add_ix(who, m, &Pubkey::new_unique(), 1, 1, &[DISC]),
            remove_ix(who, m, &target),
            update_ix(who, m, &target, 1, 1),
            set_active_ix(who, m, 1),
            revoke_ix(who, m),
        ]
    };

    // no owner signature -> InvalidSigner
    for mut ix in make(&owner, &mandate) {
        ix.accounts[0].is_signer = false;
        assert_code(e.run_as(&payer, &[ix]), E::InvalidSigner);
    }
    // wrong signer -> NotOwner
    for ix in make(&stranger.pubkey(), &mandate) {
        assert_code(e.run_as(&stranger, &[ix]), E::NotOwner);
    }
    // mandate not owned by the program -> AccountOwnerMismatch
    for ix in make(&owner, &payer.pubkey()) {
        assert_code(e.run(ix), E::AccountOwnerMismatch);
    }
    // read-only mandate -> InvalidAccountData
    for mut ix in make(&owner, &mandate) {
        ix.accounts[1].is_writable = false;
        assert_builtin(e.run(ix), "InvalidAccountData");
    }
    // missing mandate account -> InvalidInstructionData
    for mut ix in make(&owner, &mandate) {
        ix.accounts.truncate(1);
        assert_code(e.run(ix), E::InvalidInstructionData);
    }
    // unknown tags
    for tag in [7u8, 8, 100, 255] {
        let ix = owner_ix(&owner, &mandate, vec![tag]);
        assert_code(e.run(ix), E::InvalidDiscriminator);
    }
    assert_code(
        e.run(owner_ix(&owner, &mandate, vec![])),
        E::InvalidInstructionData,
    );
    // none of it touched the mandate
    assert_eq!(perm_len(&e.data()), 1);
}
