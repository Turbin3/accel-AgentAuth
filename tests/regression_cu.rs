//! Compute-unit gates. Every number is LiteSVM's `compute_units_consumed` for a
//! one-instruction transaction, so it includes the program's own work and any
//! System Program CPI, and nothing else. The ceilings are generous on purpose
//! (a regression in the hot path should trip them, normal churn should not);
//! the table of measured values is printed with
//!
//!   cargo test --test regression_cu -- --nocapture
//!
//! Quote that output, not the ceilings, when stating numbers elsewhere.

mod common;
use common::integration::*;

use agent_auth::state::Mandate;

fn disc(i: u8) -> [u8; 8] {
    [i, 0, 0, 0, 0, 0, 0, 0]
}

fn eight() -> Vec<[u8; 8]> {
    (0..8).map(disc).collect()
}

struct Row {
    name: &'static str,
    best: u64,
    worst: u64,
    ceiling: u64,
}

/// A mandate with `n` permissions (all unlimited, 8 discriminators each).
fn loaded(n: usize) -> (Env, Vec<Pubkey>) {
    let mut e = env().expect("program binary");
    assert_ok(e.create(FUTURE));
    let targets: Vec<Pubkey> = (0..n).map(|_| Pubkey::new_unique()).collect();
    for t in &targets {
        assert_ok(e.add(t, 0, 0, &eight()));
    }
    (e, targets)
}

#[test]
fn compute_units_per_instruction() {
    if env().is_none() {
        return;
    }
    let mut rows: Vec<Row> = Vec::new();

    // --- create: the bump search makes it key dependent; measure many keys
    let mut creates = Vec::new();
    for _ in 0..60 {
        let mut e = env().unwrap();
        creates.push(assert_ok(e.create(FUTURE)));
    }
    // pre-funded path (Transfer + Assign CPIs) and the husk path
    let prefunded = {
        let mut e = env().unwrap();
        let (o, m) = (e.owner_key(), e.mandate());
        assert_ok(e.run(system_transfer(&o, &m, 1_000_000)));
        assert_ok(e.create(FUTURE))
    };
    rows.push(Row {
        name: "create_mandate (fresh; 60 random agents)",
        best: *creates.iter().min().unwrap(),
        worst: *creates.iter().max().unwrap(),
        ceiling: 25_000,
    });
    rows.push(Row {
        name: "create_mandate (pre-funded PDA)",
        best: prefunded,
        worst: prefunded,
        ceiling: 25_000,
    });

    // --- add_permission: empty -> 1 disc; 16th slot with 8 discriminators
    let (add_best, add_worst) = {
        let mut e = env().unwrap();
        assert_ok(e.create(FUTURE));
        let best = assert_ok(e.add(&Pubkey::new_unique(), 1, 1, &[DISC]));
        for _ in 0..14 {
            assert_ok(e.add(&Pubkey::new_unique(), 0, 0, &eight()));
        }
        let worst = assert_ok(e.add(&Pubkey::new_unique(), 1, 1, &eight()));
        (best, worst)
    };
    rows.push(Row {
        name: "add_permission (1st slot / 16th slot, 8 discs)",
        best: add_best,
        worst: add_worst,
        ceiling: 1_200,
    });

    // --- verify: slot 1 / 1 disc / unlimited, vs slot 16 / 8th disc / both limits
    let (verify_best, verify_worst, verify_miss) = {
        let (mut e, t) = loaded(15);
        let best = assert_ok(e.verify(&t[0], &disc(0), 1));
        let limited = Pubkey::new_unique();
        assert_ok(e.add(&limited, 1_000_000, 1_000_000, &eight()));
        let worst = assert_ok(e.verify(&limited, &disc(7), 1));
        // failure path that scans every slot: unknown program
        let miss = match e.verify(&Pubkey::new_unique(), &disc(0), 1) {
            Err(f) => f.meta.compute_units_consumed,
            Ok(_) => panic!("unknown program must fail"),
        };
        (best, worst, miss)
    };
    rows.push(Row {
        name: "verify (slot 1 / slot 16, 8th disc, limits)",
        best: verify_best,
        worst: verify_worst,
        ceiling: 1_200,
    });
    rows.push(Row {
        name: "verify failing: unknown program (scans 16)",
        best: verify_miss,
        worst: verify_miss,
        ceiling: 1_200,
    });

    // --- update / remove / set_active at both ends of the array
    let (upd_best, upd_worst, rm_best, rm_worst, pause, resume) = {
        let (mut e, t) = loaded(16);
        let upd_best = assert_ok(e.update(&t[0], 5, 5));
        let upd_worst = assert_ok(e.update(&t[15], 5, 5));
        let pause = assert_ok(e.set_active(0));
        let resume = assert_ok(e.set_active(1));
        let rm_best = assert_ok(e.remove(&t[15])); // last: no copy
        let rm_worst = assert_ok(e.remove(&t[0])); // first: copy 128 bytes
        (upd_best, upd_worst, rm_best, rm_worst, pause, resume)
    };
    rows.push(Row {
        name: "update_permission (slot 1 / slot 16)",
        best: upd_best.min(upd_worst),
        worst: upd_best.max(upd_worst),
        ceiling: 1_000,
    });
    rows.push(Row {
        name: "remove_permission (16 slots: last / 15 slots: first)",
        best: rm_best.min(rm_worst),
        worst: rm_best.max(rm_worst),
        ceiling: 1_000,
    });
    rows.push(Row {
        name: "set_active (pause / resume)",
        best: pause.min(resume),
        worst: pause.max(resume),
        ceiling: 600,
    });

    // --- revoke: stored bump, constant; legacy (version 0) mandates search the bump
    let revokes: Vec<u64> = (0..12)
        .map(|_| {
            let mut e = env().unwrap();
            assert_ok(e.create(FUTURE));
            assert_ok(e.revoke())
        })
        .collect();
    let legacy_revoke = {
        let mut e = env().unwrap();
        let mut data = vec![0u8; ACCOUNT_SIZE];
        {
            let mut m = Mandate::initialize(
                &mut data,
                &e.owner_key().to_bytes(),
                &e.agent_key().to_bytes(),
                FUTURE,
                0,
            )
            .unwrap();
            m.set_version(0);
        }
        let rent = e.svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE);
        let address = e.mandate();
        e.put_account(
            address,
            Account {
                lamports: rent,
                data,
                owner: program_id(),
                ..Default::default()
            },
        );
        assert_ok(e.revoke())
    };
    rows.push(Row {
        name: "revoke_mandate (12 random agents)",
        best: *revokes.iter().min().unwrap(),
        worst: *revokes.iter().max().unwrap(),
        ceiling: 3_000,
    });
    rows.push(Row {
        name: "revoke_mandate (legacy v0 mandate, bump search)",
        best: legacy_revoke,
        worst: legacy_revoke,
        ceiling: 20_000,
    });

    println!(
        "\n{:<52} {:>8} {:>8} {:>9}",
        "instruction (LiteSVM compute units)", "best", "worst", "ceiling"
    );
    for r in &rows {
        println!(
            "{:<52} {:>8} {:>8} {:>9}",
            r.name, r.best, r.worst, r.ceiling
        );
    }
    for r in &rows {
        assert!(
            r.worst < r.ceiling,
            "{}: {} CU is over the {} ceiling",
            r.name,
            r.worst,
            r.ceiling
        );
        assert!(
            r.best > 0 && r.best <= r.worst,
            "{}: best {} worst {}",
            r.name,
            r.best,
            r.worst
        );
    }
}

#[test]
fn verify_cost_grows_with_the_slot_position_not_with_the_amount() {
    // The scan is linear in the slot index; the amount does not change the work.
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE));
    let targets: Vec<Pubkey> = (0..16).map(|_| Pubkey::new_unique()).collect();
    for t in &targets {
        assert_ok(e.add(t, 0, 0, &[DISC]));
    }
    let first = assert_ok(e.verify(&targets[0], &DISC, 1));
    let last = assert_ok(e.verify(&targets[15], &DISC, 1));
    assert!(
        last > first,
        "slot 16 ({last}) must cost more than slot 1 ({first})"
    );
    assert!(
        last - first < 500,
        "15 extra slots should cost well under 500 CU, cost {}",
        last - first
    );
    let big = assert_ok(e.verify(&targets[15], &DISC, u64::MAX));
    assert!(
        big.abs_diff(last) <= 10,
        "the amount must not change the work: {big} vs {last}"
    );
}

#[test]
fn revoke_cost_does_not_depend_on_the_key() {
    // SPEC-17 / CPI-9: the stored bump removes the on-chain bump search.
    let Some(mut e) = env() else { return };
    let mut costs = Vec::new();
    for _ in 0..12 {
        e.agent = Keypair::new();
        assert_ok(e.create(FUTURE));
        costs.push(assert_ok(e.revoke()));
    }
    let (min, max) = (costs.iter().min().unwrap(), costs.iter().max().unwrap());
    assert_eq!(min, max, "revoke CU varies with the key: {costs:?}");
}

#[test]
fn the_hot_path_does_not_search_for_a_bump() {
    // verify must not pay for find_program_address: its cost is the same for
    // every key. A single search is >1,500 CU, so any agent whose bump is not
    // 255 would show it.
    let mut costs = Vec::new();
    for _ in 0..16 {
        let Some(mut e) = env() else { return };
        assert_ok(e.create(FUTURE));
        let t = Pubkey::new_unique();
        assert_ok(e.add(&t, 0, 0, &[DISC]));
        costs.push(assert_ok(e.verify(&t, &DISC, 1)));
    }
    assert!(
        costs.iter().all(|c| c == &costs[0]),
        "verify cost varies with the key: {costs:?}"
    );
}
