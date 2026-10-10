//! Regression tests for `verify`: expiry boundary, limit arithmetic, counter
//! saturation, strict input validation and robustness against corrupt state.
//! Each test asserts the FIXED behaviour.

mod regression_support;

use regression_support::*;

use agent_auth::*;
use solana_account::Account;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

macro_rules! with_permission {
    ($spend:expr, $per_tx:expr) => {
        match Env::with_permission($spend, $per_tx) {
            Some(x) => x,
            None => return,
        }
    };
}

/// Overwrite bytes of the mandate account in place.
fn patch(e: &mut Env, at: usize, bytes: &[u8]) {
    let mandate = e.mandate();
    let mut acc = e.svm.get_account(&mandate).unwrap();
    acc.data[at..at + bytes.len()].copy_from_slice(bytes);
    e.svm.set_account(mandate, acc).unwrap();
}

// --- expiry --------------------------------------------------------------------

#[test]
fn expiry_is_the_first_invalid_second() {
    // MATH-4: expired iff now >= expiry.
    let Some(mut e) = env() else { return };
    let target = Pubkey::new_unique();
    assert_ok(e.create(NOW + 100));
    assert_ok(e.add(&target, 0, 0, &[DISC]));

    set_time(&mut e.svm, NOW + 99);
    assert_ok(e.verify(&target, &DISC, 1));
    set_time(&mut e.svm, NOW + 100);
    assert_code(e.verify(&target, &DISC, 1), E::Expired);
    set_time(&mut e.svm, NOW + 101);
    assert_code(e.verify(&target, &DISC, 1), E::Expired);
    // an expired mandate records nothing
    assert_eq!(call_count(&e.data(), 0), 1);
}

#[test]
fn expired_mandate_can_still_be_managed_and_revoked() {
    let Some(mut e) = env() else { return };
    assert_ok(e.create(NOW + 10));
    set_time(&mut e.svm, NOW + 20);
    assert_ok(e.set_active(0));
    assert_ok(e.set_active(1));
    assert_ok(e.revoke());
}

// --- limits ----------------------------------------------------------------------

#[test]
fn per_tx_and_lifetime_limits_hold_exactly_at_the_boundary() {
    let (mut e, t) = with_permission!(1_000, 400);
    assert_code(e.verify(&t, &DISC, 401), E::PerTxExceeded);
    assert_ok(e.verify(&t, &DISC, 400));
    assert_ok(e.verify(&t, &DISC, 400));
    assert_code(e.verify(&t, &DISC, 201), E::SpendLimitExceeded);
    assert_ok(e.verify(&t, &DISC, 200));
    assert_eq!(spend_total(&e.data(), 0), 1_000);
    assert_code(e.verify(&t, &DISC, 1), E::SpendLimitExceeded);
    // a zero amount is a call that spends nothing
    assert_ok(e.verify(&t, &DISC, 0));
    let d = e.data();
    assert_eq!(spend_total(&d, 0), 1_000);
    assert_eq!(call_count(&d, 0), 4);
}

#[test]
fn overflowing_request_on_a_limited_permission_is_over_the_limit_not_an_overflow() {
    // MATH-2: used to surface as ArithmeticOverflow (13).
    let (mut e, t) = with_permission!(100, 0);
    assert_ok(e.verify(&t, &DISC, 60));
    assert_code(e.verify(&t, &DISC, u64::MAX), E::SpendLimitExceeded);
    assert_code(e.verify(&t, &DISC, u64::MAX - 59), E::SpendLimitExceeded);
    assert_code(e.verify(&t, &DISC, 41), E::SpendLimitExceeded);
    assert_ok(e.verify(&t, &DISC, 40));
}

#[test]
fn per_tx_check_wins_over_lifetime_check() {
    let (mut e, t) = with_permission!(100, 10);
    assert_code(e.verify(&t, &DISC, u64::MAX), E::PerTxExceeded);
}

#[test]
fn unlimited_permission_cannot_be_wedged_by_a_huge_amount() {
    // MATH-2 / LIFE-6 / TESTS-11: one verify(u64::MAX) used to brick a (0,0)
    // permission with ArithmeticOverflow until the owner removed and re-added it.
    let (mut e, t) = with_permission!(0, 0);
    assert_ok(e.verify(&t, &DISC, 5));
    assert_ok(e.verify(&t, &DISC, u64::MAX));
    assert_eq!(spend_total(&e.data(), 0), u64::MAX, "saturates");
    assert_ok(e.verify(&t, &DISC, u64::MAX));
    assert_ok(e.verify(&t, &DISC, 1));
    assert_ok(e.verify(&t, &DISC, 0));
    let d = e.data();
    assert_eq!(spend_total(&d, 0), u64::MAX);
    assert_eq!(call_count(&d, 0), 5);
}

#[test]
fn call_count_saturates_instead_of_reverting() {
    // MATH-3
    for (spend, per_tx) in [(0u64, 0u64), (1_000, 0)] {
        let (mut e, t) = with_permission!(spend, per_tx);
        patch(
            &mut e,
            HEADER_SIZE + P_CALL_COUNT,
            &(u32::MAX - 1).to_le_bytes(),
        );
        assert_ok(e.verify(&t, &DISC, 1));
        assert_eq!(call_count(&e.data(), 0), u32::MAX);
        assert_ok(e.verify(&t, &DISC, 1));
        assert_eq!(call_count(&e.data(), 0), u32::MAX);
        assert_eq!(spend_total(&e.data(), 0), 2);
    }
}

#[test]
fn only_the_matched_slot_is_charged() {
    // TESTS-8: verify with more than one permission
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE));
    let (a, b, c) = (
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    let other = [9, 9, 9, 9, 9, 9, 9, 9];
    assert_ok(e.add(&a, 100, 0, &[DISC]));
    assert_ok(e.add(&b, 0, 50, &[other, DISC]));
    assert_ok(e.add(&c, 10, 10, &[other]));

    assert_ok(e.verify(&b, &other, 30));
    assert_ok(e.verify(&c, &other, 10));
    assert_code(e.verify(&c, &other, 1), E::SpendLimitExceeded);
    assert_code(e.verify(&a, &other, 1), E::DiscriminatorNotAllowed);
    assert_code(
        e.verify(&Pubkey::new_unique(), &DISC, 1),
        E::ProgramNotAllowed,
    );
    assert_code(e.verify(&b, &[0; 8], 1), E::DiscriminatorNotAllowed);

    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (0, 0));
    assert_eq!((spend_total(&d, 1), call_count(&d, 1)), (30, 1));
    assert_eq!((spend_total(&d, 2), call_count(&d, 2)), (10, 1));
}

// --- validation and error contract ---------------------------------------------

#[test]
fn verify_requires_exact_data_length() {
    // MEM-6
    let (mut e, t) = with_permission!(0, 0);
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let good = verify_ix(&m, &o, &a, &t, &DISC, 1);
    assert_eq!(good.data.len(), 49);
    for len in [0usize, 1, 40, 47, 48, 50, 56] {
        let mut ix = good.clone();
        ix.data.resize(len, 0);
        if len > 0 {
            ix.data[0] = 3;
        }
        let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
        let result = send(&mut e.svm, &[&owner, &agent], &[ix]);
        assert_code(result, E::InvalidInstructionData);
    }
    assert_eq!(call_count(&e.data(), 0), 0);
    assert_ok(e.verify(&t, &DISC, 1));
}

#[test]
fn verify_error_contract() {
    let (mut e, t) = with_permission!(0, 0);
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    let stranger = solana_keypair::Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    // too few accounts
    let mut ix = verify_ix(&m, &o, &a, &t, &DISC, 1);
    ix.accounts.truncate(2);
    assert_builtin(send(&mut e.svm, &[&owner], &[ix]), "NotEnoughAccountKeys");
    // not our account
    let ix = verify_ix(&stranger.pubkey(), &o, &a, &t, &DISC, 1);
    assert_code(
        send(&mut e.svm, &[&owner, &agent], &[ix]),
        E::AccountOwnerMismatch,
    );
    // read-only mandate
    let mut ix = verify_ix(&m, &o, &a, &t, &DISC, 1);
    ix.accounts[0].is_writable = false;
    assert_builtin(
        send(&mut e.svm, &[&owner, &agent], &[ix]),
        "InvalidAccountData",
    );
    // wrong owner account
    let ix = verify_ix(&m, &stranger.pubkey(), &a, &t, &DISC, 1);
    assert_code(send(&mut e.svm, &[&owner, &agent], &[ix]), E::NotOwner);
    // wrong agent account (signing, but not the mandate's agent)
    let ix = verify_ix(&m, &o, &stranger.pubkey(), &t, &DISC, 1);
    assert_code(
        send(&mut e.svm, &[&owner, &stranger], &[ix]),
        E::UnknownAgent,
    );
    // the right agent key, but it did not sign
    let mut ix = verify_ix(&m, &o, &a, &t, &DISC, 1);
    ix.accounts[2].is_signer = false;
    assert_code(send(&mut e.svm, &[&owner], &[ix]), E::InvalidSigner);
    // nothing above was recorded
    assert_eq!(call_count(&e.data(), 0), 0);
}

#[test]
fn verify_rejects_accounts_that_are_not_initialised_mandates() {
    let (mut e, t) = with_permission!(0, 0);
    // wrong discriminator byte
    patch(&mut e, OFF_DISC, &[0]);
    assert_code(e.verify(&t, &DISC, 1), E::InvalidAccountType);
    patch(&mut e, OFF_DISC, &[2]);
    assert_code(e.verify(&t, &DISC, 1), E::InvalidAccountType);
    // wrong size
    let mandate = e.mandate();
    e.svm
        .set_account(
            mandate,
            Account {
                lamports: 1_000_000_000,
                data: vec![1u8; ACCOUNT_SIZE - 1],
                owner: program_id(),
                ..Default::default()
            },
        )
        .unwrap();
    assert_code(e.verify(&t, &DISC, 1), E::InvalidAccountType);
}

#[test]
fn corrupt_headers_are_errors_not_panics() {
    // MEM-5: unreachable through the instruction set, but the state layer must
    // not index out of bounds if it ever happens.
    let (mut e, t) = with_permission!(0, 0);
    patch(&mut e, OFF_PERM_LEN, &17u16.to_le_bytes());
    assert_code(e.verify(&t, &DISC, 1), E::InvalidAccountType);
    patch(&mut e, OFF_PERM_LEN, &u16::MAX.to_le_bytes());
    assert_code(e.verify(&t, &DISC, 1), E::InvalidAccountType);
    assert_code(
        e.add(&Pubkey::new_unique(), 0, 0, &[DISC]),
        E::InvalidAccountType,
    );

    // a slot whose discriminator count byte is garbage is clamped to 8
    patch(&mut e, OFF_PERM_LEN, &1u16.to_le_bytes());
    patch(&mut e, HEADER_SIZE + P_DISC_LEN, &[255]);
    assert_ok(e.verify(&t, &DISC, 1));
    assert_code(e.verify(&t, &[1; 8], 1), E::DiscriminatorNotAllowed);
}

#[test]
fn a_paused_mandate_reports_not_active_before_anything_else() {
    let (mut e, t) = with_permission!(0, 0);
    assert_ok(e.set_active(0));
    assert_code(
        e.verify(&Pubkey::new_unique(), &[0; 8], u64::MAX),
        E::NotActive,
    );
    // the stored flag is exactly 0/1 and anything else counts as paused
    patch(&mut e, OFF_ACTIVE, &[2]);
    assert_code(e.verify(&t, &DISC, 1), E::NotActive);
}
