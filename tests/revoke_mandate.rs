mod common;
use common::integration::*;

/// Test that revoking a mandate returns the rent to the owner.
#[test]
fn revoke_returns_rent() {
    let Some((mut svm, owner)) = setup() else {
        return;
    };
    let agent = Keypair::new();
    let mandate = seed_mandate(&mut svm, &owner.pubkey(), &agent.pubkey(), true);

    let rent = svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE);
    let owner_before = svm
        .get_account(&owner.pubkey())
        .map(|a| a.lamports)
        .unwrap_or(0);

    send(
        &mut svm,
        &[&owner],
        &[revoke_mandate_ix(&owner.pubkey(), &agent.pubkey())],
    )
    .unwrap();

    // Mandate must be fully closed
    match svm.get_account(&mandate) {
        None => { /* deleted — correct */ }
        Some(acc) => {
            assert_eq!(acc.lamports, 0, "mandate lamports must be 0 after revoke");
            assert!(
                acc.data.iter().all(|&b| b == 0),
                "mandate data must be all zeros after revoke"
            );
        }
    }

    // Owner must have received the rent back (allow a small tx fee margin)
    let owner_after = svm
        .get_account(&owner.pubkey())
        .map(|a| a.lamports)
        .unwrap_or(0);
    assert!(
        owner_after >= owner_before + rent - 10_000,
        "owner balance should rise by ~rent; \
         before={owner_before}, after={owner_after}, rent={rent}"
    );
}

// Test that revoking a mandate then calling verify, fails
#[test]
fn revoke_then_verify_fails() {
    let Some((mut svm, owner)) = setup() else {
        return;
    };
    let agent = Keypair::new();
    svm.airdrop(&agent.pubkey(), 1_000_000).unwrap();
    let target = Pubkey::new_unique();

    // Seed + add one permission so verify would succeed pre-revoke
    let mandate = seed_mandate(&mut svm, &owner.pubkey(), &agent.pubkey(), true);
    send(
        &mut svm,
        &[&owner],
        &[add_permission_ix(
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            0, // unlimited
            0,
            &[DISC],
        )],
    )
    .unwrap();

    // Revoke
    send(
        &mut svm,
        &[&owner],
        &[revoke_mandate_ix(&owner.pubkey(), &agent.pubkey())],
    )
    .unwrap();

    // verify must now fail — account data is zeroed (discriminator = 0 ≠ 1)
    let ix = verify_ix(
        &mandate,
        &owner.pubkey(),
        &agent.pubkey(),
        &target,
        &DISC,
        0,
    );
    let err = send(&mut svm, &[&owner, &agent], &[ix]).unwrap_err();
    let err_text = format!("{:?}", err.err);

    assert!(
        err_text.contains("Custom(16)")      // InvalidAccountType  — discriminator = 0
            || err_text.contains("Custom(14)") // AccountOwnerMismatch — account deleted
            || err_text.contains("InvalidAccountData"),
        "verify must fail after revoke; got: {err_text}"
    );
}
