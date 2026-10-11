//! Tests that pin behaviour a mutation run (round 1) showed was unguarded:
//! each test here FAILS against the named mutant and PASSES on the real source.
//!
//! * C20: `create_mandate::top_up` must not CPI when the PDA already holds rent.
//! * V10: `revoke_mandate` must map a `create_program_address` failure to
//!   `InvalidAccountType`, not to some other code.
//!
//! (W31, the verify check order, is a row of the matrix in `error_matrix.rs`.)

mod common;

use common::integration::*;

use agent_auth::{MandateError as E, ACCOUNT_SIZE, OFF_BUMP};
use solana_account::Account;
use solana_pubkey::Pubkey;

macro_rules! setup {
    () => {
        match env() {
            Some(e) => e,
            None => return,
        }
    };
}

fn rent(e: &Env) -> u64 {
    e.svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE)
}

/// A program-owned, zeroed, right-sized account holding `lamports`.
fn put_husk(e: &mut Env, lamports: u64) {
    e.put_account(
        e.mandate(),
        Account {
            lamports,
            data: vec![0; ACCOUNT_SIZE],
            owner: program_id(),
            executable: false,
            rent_epoch: 0,
        },
    );
}

fn create_without_system_program(e: &Env) -> solana_instruction::Instruction {
    let mut ix = create_ix(&e.owner_key(), &e.agent_key(), FUTURE);
    assert_eq!(ix.accounts.len(), 4);
    ix.accounts.truncate(3);
    ix
}

// --- C20 ---------------------------------------------------------------------

#[test]
fn funded_husk_create_needs_no_system_program() {
    // Kills: top_up transfers even when nothing is missing (a 0-lamport CPI
    // needs the System Program account and fails without it).
    let mut e = setup!();
    let rent = rent(&e);
    put_husk(&mut e, rent);
    let ix = create_without_system_program(&e);
    assert_ok(e.run(ix));
    let acc = e.account().unwrap();
    assert_eq!(acc.data[0], agent_auth::MANDATE_DISCRIMINATOR);
    assert_eq!(acc.lamports, rent, "no lamports moved");
}

#[test]
fn overfunded_husk_create_needs_no_system_program_and_keeps_its_balance() {
    let mut e = setup!();
    let rent = rent(&e);
    put_husk(&mut e, rent + 12_345);
    let ix = create_without_system_program(&e);
    assert_ok(e.run(ix));
    assert_eq!(e.account().unwrap().lamports, rent + 12_345);
}

#[test]
fn funded_husk_create_with_system_program_moves_no_lamports() {
    let mut e = setup!();
    let rent = rent(&e);
    put_husk(&mut e, rent);
    let before = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_ok(e.create(FUTURE));
    let after = e.svm.get_account(&e.owner_key()).unwrap().lamports;
    assert_eq!(before - after, 5_000, "owner pays only the fee");
    assert_eq!(e.account().unwrap().lamports, rent);
}

#[test]
fn underfunded_husk_create_still_needs_the_system_program() {
    // The other side of the guard: one lamport short must still top up, which
    // needs the System Program account.
    let mut e = setup!();
    let rent = rent(&e);
    put_husk(&mut e, rent - 1);
    let ix = create_without_system_program(&e);
    assert!(
        e.run(ix).is_err(),
        "a real top-up CPI cannot run without System"
    );
    assert_eq!(
        e.account().unwrap().data[0],
        0,
        "failed create changes nothing"
    );
    assert_ok(e.create(FUTURE));
    assert_eq!(e.account().unwrap().lamports, rent);
}

#[test]
fn funded_husk_create_skips_the_transfer_cpi_in_compute_units() {
    // CU pin: the no-op top-up path must cost a System Transfer CPI (>= 1,000
    // CU of invoke overhead alone) less than a one-lamport top-up.
    // Same owner, agent and PDA for both runs: create's cost depends on the
    // key through the bump search, so two random envs would not be comparable.
    let mut e = setup!();
    let rent = rent(&e);
    put_husk(&mut e, rent);
    let funded = assert_ok(e.create(FUTURE));
    put_husk(&mut e, rent - 1);
    e.svm.expire_blockhash();
    let short = assert_ok(e.create(FUTURE));
    println!("create on a husk: funded {funded} CU, one lamport short {short} CU");
    assert!(
        funded + 1_000 <= short,
        "funded husk {funded} CU must be at least 1,000 CU cheaper than a top-up {short} CU"
    );
}

// --- V10 ---------------------------------------------------------------------

/// A bump byte for which `["mandate", owner, agent, bump]` is on the curve
/// (create_program_address fails), other than the real one.
fn on_curve_bump(e: &Env) -> u8 {
    let (o, a) = (e.owner_key(), e.agent_key());
    (0..=255u8)
        .filter(|b| *b != e.bump())
        .find(|b| {
            Pubkey::create_program_address(
                &[b"mandate", o.as_ref(), a.as_ref(), &[*b]],
                &program_id(),
            )
            .is_err()
        })
        .expect("some bump byte lands on the curve")
}

#[test]
fn revoke_with_an_on_curve_stored_bump_is_invalid_account_type() {
    // Kills: the map_err arm after create_program_address returning another code.
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let bad = on_curve_bump(&e);
    e.patch(OFF_BUMP, &[bad]);
    let before = e.account().unwrap();
    assert_code(e.revoke(), E::InvalidAccountType);
    let after = e.account().unwrap();
    assert_eq!(before.data, after.data, "failed revoke changes nothing");
    assert_eq!(before.lamports, after.lamports);
    assert_eq!(after.owner, program_id());
}

#[test]
fn revoke_with_a_wrong_but_valid_stored_bump_is_invalid_account_type() {
    // A bump that derives a different, off-curve address: the address check arm.
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let (o, a) = (e.owner_key(), e.agent_key());
    let other = (0..=255u8).filter(|b| *b != e.bump()).find(|b| {
        Pubkey::create_program_address(&[b"mandate", o.as_ref(), a.as_ref(), &[*b]], &program_id())
            .is_ok()
    });
    let Some(other) = other else { return };
    e.patch(OFF_BUMP, &[other]);
    assert_code(e.revoke(), E::InvalidAccountType);
}

// --- round 2: N-S31 ----------------------------------------------------------------

#[test]
fn remove_permission_wipes_all_128_bytes_of_the_vacated_slot() {
    // Kills: swap_remove zeroing the tail slot one byte short, which leaves the
    // last byte of the 8th discriminator (stale allow-list data) in the account.
    use agent_auth::{HEADER_SIZE, PERMISSION_SIZE};
    let mut e = setup!();
    assert_ok(e.create(FUTURE));
    let ts: Vec<Pubkey> = (0..3).map(|_| Pubkey::new_unique()).collect();
    let full: [[u8; 8]; 8] = [[0xFF; 8]; 8];
    for t in &ts {
        assert_ok(e.add(t, u64::MAX, u64::MAX, &full));
    }
    assert_ok(e.verify(&ts[2], &[0xFF; 8], 5));
    assert_ok(e.remove(&ts[0]));
    let d = e.data();
    let tail = HEADER_SIZE + 2 * PERMISSION_SIZE;
    assert!(
        d[tail..tail + PERMISSION_SIZE].iter().all(|&b| b == 0),
        "vacated slot must be all zero"
    );
    // removing the LAST slot (idx == last) must wipe it too
    assert_ok(e.remove(&ts[1]));
    let d = e.data();
    let tail = HEADER_SIZE + PERMISSION_SIZE;
    assert!(d[tail..tail + PERMISSION_SIZE].iter().all(|&b| b == 0));
    assert_eq!(&d[HEADER_SIZE..HEADER_SIZE + 32], ts[2].as_ref());
}
