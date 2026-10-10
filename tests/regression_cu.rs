//! Compute-unit measurements (LiteSVM `compute_units_consumed`) and generous
//! ceilings so a regression in the hot path shows up in CI.
//! Run `cargo test --test regression_cu -- --nocapture` to print the table.

mod regression_support;

use regression_support::*;

use agent_auth::*;
use solana_pubkey::Pubkey;

#[test]
fn compute_units_per_instruction() {
    let Some(mut e) = env() else { return };
    let target = Pubkey::new_unique();
    let discs: Vec<[u8; 8]> = (0..8u8).map(|i| [i, 0, 0, 0, 0, 0, 0, 0]).collect();

    let create = assert_ok(e.create(FUTURE));
    let add = assert_ok(e.add(&target, 1_000_000, 1_000, &[DISC]));
    let verify_light = assert_ok(e.verify(&target, &DISC, 1));
    let update = assert_ok(e.update(&target, 2_000_000, 2_000));
    let pause = assert_ok(e.set_active(0));
    let resume = assert_ok(e.set_active(1));
    let remove = assert_ok(e.remove(&target));

    // heaviest verify: 16th slot, 8th discriminator
    let mut targets = Vec::new();
    for _ in 0..MAX_PERMISSIONS {
        let t = Pubkey::new_unique();
        assert_ok(e.add(&t, 0, 0, &discs));
        targets.push(t);
    }
    let verify_heavy = assert_ok(e.verify(&targets[15], &discs[7], 1));
    let revoke = assert_ok(e.revoke());

    println!("create_mandate     {create:>6} CU");
    println!("add_permission     {add:>6} CU");
    println!("remove_permission  {remove:>6} CU");
    println!("update_permission  {update:>6} CU");
    println!("set_active (pause) {pause:>6} CU");
    println!("set_active (resume){resume:>6} CU");
    println!("verify (slot 1)    {verify_light:>6} CU");
    println!("verify (slot 16)   {verify_heavy:>6} CU");
    println!("revoke_mandate     {revoke:>6} CU");

    assert!(
        verify_light < 1_000,
        "verify hot path regressed: {verify_light}"
    );
    assert!(
        verify_heavy < 1_200,
        "verify worst case regressed: {verify_heavy}"
    );
    assert!(create < 20_000);
    assert!(revoke < 5_000);
    assert!(add < 1_000 && remove < 1_000 && update < 1_000 && pause < 1_000);
}

#[test]
fn revoke_cost_does_not_depend_on_the_key() {
    // SPEC-17 / CPI-9: the stored bump removes the on-chain bump search.
    let Some(mut e) = env() else { return };
    let mut costs = Vec::new();
    for _ in 0..12 {
        e.agent = solana_keypair::Keypair::new();
        assert_ok(e.create(FUTURE));
        costs.push(assert_ok(e.revoke()));
    }
    println!("revoke CU over 12 random agents: {costs:?}");
    let (min, max) = (costs.iter().min().unwrap(), costs.iter().max().unwrap());
    assert_eq!(min, max, "revoke CU varies with the key: {costs:?}");
}
