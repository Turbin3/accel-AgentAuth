//! Full lifecycle integration test: seed → add → verify (ok) → verify (reject) → remove → revoke → verify (fail)
mod common;
use common::integration::*;

#[test]
fn full_lifecycle() {
    let Some((mut svm, owner)) = setup() else {
        return;
    };
    let agent = Keypair::new();
    svm.airdrop(&agent.pubkey(), 1_000_000).unwrap();
    let target = Pubkey::new_unique();

    // ── 1. SEED: create active mandate with no permissions ─────────────────
    let mandate = seed_mandate(&mut svm, &owner.pubkey(), &agent.pubkey(), true);

    // ── 2. ADD: one permission — spend_limit=500, per_tx=0 (unlimited) ─────
    send(
        &mut svm,
        &[&owner],
        &[add_permission_ix(
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            500, // spend_limit
            0,   // per_tx = unlimited
            &[DISC],
        )],
    )
    .expect("step 2 (add_permission) must succeed");

    // ── 3. VERIFY (ok): amount=200, cumulative=200 < 500 ──────────────────
    send(
        &mut svm,
        &[&owner, &agent],
        &[verify_ix(
            &mandate,
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            &DISC,
            200,
        )],
    )
    .expect("step 3 (verify ok) must succeed; spend_total becomes 200");

    // ── 4. VERIFY (reject): amount=400; 200+400=600 > 500 ─────────────────
    let err = send(
        &mut svm,
        &[&owner, &agent],
        &[verify_ix(
            &mandate,
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            &DISC,
            400,
        )],
    )
    .expect_err("step 4 (verify over-limit) must fail");
    assert!(
        format!("{:?}", err.err).contains("Custom(9)"),
        "step 4: expected SpendLimitExceeded (Custom(9)); got {:?}",
        err.err
    );

    // ── 5. REMOVE: strip the permission ────────────────────────────────────
    send(
        &mut svm,
        &[&owner],
        &[remove_permission_ix(
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
        )],
    )
    .expect("step 5 (remove_permission) must succeed");

    // Confirm removal — verify now returns ProgramNotAllowed = Custom(6)
    let err2 = send(
        &mut svm,
        &[&owner, &agent],
        &[verify_ix(
            &mandate,
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            &DISC,
            0,
        )],
    )
    .expect_err("step 5b (verify after remove) must fail");
    assert!(
        format!("{:?}", err2.err).contains("Custom(6)"),
        "step 5b: expected ProgramNotAllowed (Custom(6)); got {:?}",
        err2.err
    );

    // ── 6. REVOKE: close the mandate ──────────────────────────────────────
    send(
        &mut svm,
        &[&owner],
        &[revoke_mandate_ix(&owner.pubkey(), &agent.pubkey())],
    )
    .expect("step 6 (revoke_mandate) must succeed");

    // Mandate account must be zeroed / gone
    if let Some(acc) = svm.get_account(&mandate) {
        assert_eq!(
            acc.lamports, 0,
            "step 6: revoked mandate must have 0 lamports"
        );
        assert!(
            acc.data.iter().all(|&b| b == 0),
            "step 6: revoked mandate data must be all zeros"
        );
    }

    // ── 7. VERIFY (fail): closed account rejected ─────────────────────────
    //
    // The account is zeroed — discriminator = 0 ≠ MANDATE_DISCRIMINATOR.
    // Any non-empty error proves the agent is locked out.
    let err3 = send(
        &mut svm,
        &[&owner, &agent],
        &[verify_ix(
            &mandate,
            &owner.pubkey(),
            &agent.pubkey(),
            &target,
            &DISC,
            0,
        )],
    )
    .expect_err("step 7 (verify on closed mandate) must fail");
    assert!(
        !format!("{:?}", err3.err).is_empty(),
        "step 7: verify must fail on a closed mandate"
    );

    println!("full lifecycle: all 7 steps passed ✓");
}
