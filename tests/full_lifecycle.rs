//! End-to-end lifecycle through the real program, with every step created by the
//! program itself (nothing is seeded with `set_account`): create, add, verify,
//! reject, update, pause, resume, remove, expire, revoke, recreate. Each
//! assertion reads the raw account bytes, not just the transaction result.

mod common;
use common::integration::*;

#[test]
fn a_mandate_lives_through_every_instruction() {
    let Some(mut e) = env() else { return };
    let target = Pubkey::new_unique();
    let lifetime = 1_000;

    // 1. create
    assert_ok(e.create(NOW + lifetime));
    let d = e.data();
    assert_eq!(d.len(), ACCOUNT_SIZE);
    assert_eq!(expiry_of(&d), NOW + lifetime);
    assert_eq!(perm_len(&d), 0);

    // 2. add: spend 500 lifetime, 300 per call
    assert_ok(e.add(&target, 500, 300, &[DISC]));
    assert_eq!(perm_len(&e.data()), 1);

    // 3. verify within limits, twice
    assert_ok(e.verify(&target, &DISC, 200));
    assert_ok(e.verify(&target, &DISC, 250));
    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (450, 2));

    // 4. rejects leave the counters alone
    assert_code(e.verify(&target, &DISC, 51), E::SpendLimitExceeded);
    assert_code(e.verify(&target, &DISC, 301), E::PerTxExceeded);
    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (450, 2));

    // 5. raising the limit keeps the history and opens room
    assert_ok(e.update(&target, 1_000, 300));
    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (450, 2));
    assert_ok(e.verify(&target, &DISC, 300));
    assert_eq!(spend_total(&e.data(), 0), 750);

    // 6. pause: verify and mutators are refused, state is untouched
    assert_ok(e.set_active(0));
    assert_code(e.verify(&target, &DISC, 1), E::NotActive);
    assert_code(e.update(&target, 1, 1), E::NotActive);
    assert_ok(e.set_active(1));
    assert_ok(e.verify(&target, &DISC, 1));
    assert_eq!(spend_total(&e.data(), 0), 751);

    // 7. remove: the program is gone and so is its history
    assert_ok(e.remove(&target));
    assert_code(e.verify(&target, &DISC, 1), E::ProgramNotAllowed);
    assert_eq!(perm_len(&e.data()), 0);
    assert_ok(e.add(&target, 500, 300, &[DISC]));
    let d = e.data();
    assert_eq!(
        (spend_total(&d, 0), call_count(&d, 0)),
        (0, 0),
        "re-adding starts from zero"
    );

    // 8. expiry
    set_time(&mut e.svm, NOW + lifetime - 1);
    assert_ok(e.verify(&target, &DISC, 1));
    set_time(&mut e.svm, NOW + lifetime);
    assert_code(e.verify(&target, &DISC, 1), E::Expired);

    // 9. revoke closes the account and returns every lamport
    let rent = e.svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE);
    let owner_before = e.svm.get_balance(&e.owner_key()).unwrap();
    assert_ok(e.revoke());
    assert!(e.account().is_none(), "the account is gone after revoke");
    let owner_after = e.svm.get_balance(&e.owner_key()).unwrap();
    let fee = 5_000; // one signature
    assert_eq!(
        owner_after,
        owner_before + rent - fee,
        "owner is refunded the full rent"
    );
    assert_code(e.verify(&target, &DISC, 1), E::AccountOwnerMismatch);

    // 10. the same pair can be created again, clean
    set_time(&mut e.svm, NOW);
    assert_ok(e.create(FUTURE));
    let d = e.data();
    assert_eq!(perm_len(&d), 0);
    assert_eq!(expiry_of(&d), FUTURE);
}

#[test]
fn two_mandates_for_one_owner_are_independent() {
    let Some(mut e) = env() else { return };
    let target = Pubkey::new_unique();
    let first_agent = e.agent.insecure_clone();
    assert_ok(e.create(FUTURE));
    assert_ok(e.add(&target, 100, 0, &[DISC]));
    assert_ok(e.verify(&target, &DISC, 60));
    let first_mandate = e.mandate();

    e.agent = Keypair::new();
    e.svm.airdrop(&e.agent_key(), 1_000_000_000).unwrap();
    assert_ok(e.create(FUTURE));
    assert_ne!(e.mandate(), first_mandate);
    assert_code(e.verify(&target, &DISC, 1), E::ProgramNotAllowed);
    assert_ok(e.add(&target, 100, 0, &[DISC]));
    assert_ok(e.verify(&target, &DISC, 100));

    // the first mandate still has its own counters
    let d = e.svm.get_account(&first_mandate).unwrap().data;
    assert_eq!(spend_total(&d, 0), 60);
    // and the first agent cannot use the second mandate
    let ix = verify_ix(
        &e.mandate(),
        &e.owner_key(),
        &first_agent.pubkey(),
        &target,
        &DISC,
        1,
    );
    let owner = e.owner.insecure_clone();
    assert_code(
        send(&mut e.svm, &[&owner, &first_agent], &[ix]),
        E::UnknownAgent,
    );
}

#[test]
fn two_owners_with_one_agent_are_independent() {
    let Some(mut e) = env() else { return };
    let target = Pubkey::new_unique();
    assert_ok(e.create(FUTURE));
    assert_ok(e.add(&target, 10, 0, &[DISC]));

    let other_owner = funded(&mut e.svm, 10_000_000_000);
    let (m2, _) = pda(&other_owner.pubkey(), &e.agent_key());
    assert_ne!(m2, e.mandate());
    let agent_key = e.agent_key();
    assert_ok(send(
        &mut e.svm,
        &[&other_owner],
        &[create_ix(&other_owner.pubkey(), &agent_key, FUTURE)],
    ));
    // the other owner's mandate cannot be edited by the first owner
    let ix = add_ix(&e.owner_key(), &m2, &target, 1, 1, &[DISC]);
    assert_code(e.run(ix), E::NotOwner);
    let ix = revoke_ix(&e.owner_key(), &m2);
    assert_code(e.run(ix), E::NotOwner);
    assert!(e.svm.get_account(&m2).is_some());
}
