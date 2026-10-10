//! Differential property test of the zero-copy state layer against a plain
//! `Vec` model: random append / swap-remove / counter updates, with the raw
//! account bytes checked after every step.
//!
//! Invariants checked on the bytes (independently of the `Mandate` accessors):
//! the array is packed, the tail past `permissions_len` is all zero, the length
//! field matches the model, the header outside the length field never moves, and
//! failed operations leave the buffer byte-identical.
//!
//! Reproduce a failure with the seed printed in the panic message. Scale the run
//! with `AGENT_AUTH_PROP_CASES`.

mod common;
use common::integration::{prop_cases, Rng};

use agent_auth::state::Mandate;
use agent_auth::*;

#[derive(Clone, Debug, PartialEq)]
struct ModelPerm {
    program: [u8; 32],
    spend_limit: u64,
    per_tx: u64,
    spend_total: u64,
    calls: u32,
    discs: Vec<[u8; 8]>,
}

fn assert_bytes_match_model(buf: &[u8; ACCOUNT_SIZE], model: &[ModelPerm], seed: u64, step: usize) {
    let ctx = format!("seed {seed} step {step}");
    let len = u16::from_le_bytes([buf[OFF_PERM_LEN], buf[OFF_PERM_LEN + 1]]) as usize;
    assert_eq!(len, model.len(), "{ctx}: length");
    assert!(len <= MAX_PERMISSIONS, "{ctx}");
    for (i, want) in model.iter().enumerate() {
        let base = HEADER_SIZE + i * PERMISSION_SIZE;
        let s = &buf[base..base + PERMISSION_SIZE];
        assert_eq!(
            &s[P_PROGRAM_ID..P_PROGRAM_ID + 32],
            &want.program,
            "{ctx}: slot {i} key"
        );
        assert_ne!(want.program, [0; 32], "model never uses the zero key");
        let u64_at = |o: usize| u64::from_le_bytes(s[o..o + 8].try_into().unwrap());
        assert_eq!(
            u64_at(P_SPEND_LIMIT),
            want.spend_limit,
            "{ctx}: slot {i} spend_limit"
        );
        assert_eq!(
            u64_at(P_PER_TX_LIMIT),
            want.per_tx,
            "{ctx}: slot {i} per_tx"
        );
        assert_eq!(
            u64_at(P_SPEND_TOTAL),
            want.spend_total,
            "{ctx}: slot {i} spend_total"
        );
        assert_eq!(
            u32::from_le_bytes(s[P_CALL_COUNT..P_CALL_COUNT + 4].try_into().unwrap()),
            want.calls,
            "{ctx}: slot {i} calls"
        );
        assert_eq!(
            s[P_DISC_LEN] as usize,
            want.discs.len(),
            "{ctx}: slot {i} disc_len"
        );
        for (j, d) in want.discs.iter().enumerate() {
            let o = P_DISCRIMINATORS + j * 8;
            assert_eq!(&s[o..o + 8], d, "{ctx}: slot {i} disc {j}");
        }
        // unused discriminator bytes and the bytes between fields stay zero
        assert!(
            s[P_DISCRIMINATORS + want.discs.len() * 8..]
                .iter()
                .all(|&b| b == 0),
            "{ctx}: slot {i} unused discriminator bytes"
        );
        assert!(
            s[P_CALL_COUNT + 4..P_DISC_LEN].iter().all(|&b| b == 0),
            "{ctx}: slot {i} pad"
        );
        assert!(
            s[P_DISC_LEN + 1..P_DISCRIMINATORS].iter().all(|&b| b == 0),
            "{ctx}: slot {i} pad"
        );
    }
    assert!(
        buf[HEADER_SIZE + len * PERMISSION_SIZE..]
            .iter()
            .all(|&b| b == 0),
        "{ctx}: tail past permissions_len must be zero"
    );
}

fn random_discs(rng: &mut Rng, n: usize) -> Vec<[u8; 8]> {
    (0..n)
        .map(|_| [rng.below(6) as u8 + 1, 0, 0, 0, 0, 0, 0, 0])
        .collect()
}

#[test]
fn append_remove_and_counters_match_a_vec_model() {
    let cases = prop_cases(300);
    for seed in 1..=cases {
        let mut rng = Rng::new(seed);
        let mut buf = [0u8; ACCOUNT_SIZE];
        Mandate::initialize(&mut buf, &[1; 32], &[2; 32], 1_000, 255).unwrap();
        let header_before: Vec<u8> = {
            let mut h = buf[..HEADER_SIZE].to_vec();
            h[OFF_PERM_LEN] = 0;
            h[OFF_PERM_LEN + 1] = 0;
            h
        };
        let mut model: Vec<ModelPerm> = Vec::new();

        for step in 0..120 {
            let before = buf;
            match rng.below(5) {
                // append: random key from a small pool (so duplicates and misses both occur)
                0 | 1 => {
                    let key = [rng.below(20) as u8 + 1; 32];
                    let n = rng.below(11) as usize; // 0..=10, 9 and 10 are too many
                    let discs = random_discs(&mut rng, n);
                    let (sl, pt) = (rng.amount(), rng.amount());
                    let mut m = Mandate::from_bytes(&mut buf).unwrap();
                    let got = m.append_permission(&key, sl, pt, &discs);
                    if n > MAX_DISCRIMINATORS {
                        assert_eq!(
                            got,
                            Err(MandateError::TooManyDiscriminators),
                            "seed {seed} step {step}"
                        );
                        assert_eq!(
                            buf, before,
                            "seed {seed} step {step}: failed append changed bytes"
                        );
                    } else if model.len() == MAX_PERMISSIONS {
                        assert_eq!(
                            got,
                            Err(MandateError::PermissionsFull),
                            "seed {seed} step {step}"
                        );
                        assert_eq!(
                            buf, before,
                            "seed {seed} step {step}: failed append changed bytes"
                        );
                    } else {
                        assert_eq!(got, Ok(model.len()), "seed {seed} step {step}");
                        model.push(ModelPerm {
                            program: key,
                            spend_limit: sl,
                            per_tx: pt,
                            spend_total: 0,
                            calls: 0,
                            discs,
                        });
                    }
                }
                // swap-remove by key, or by a bad index
                2 => {
                    let mut m = Mandate::from_bytes(&mut buf).unwrap();
                    if rng.chance(5) {
                        let idx = model.len() + rng.below(3) as usize;
                        assert_eq!(
                            m.swap_remove_permission(idx),
                            Err(MandateError::PermissionNotFound),
                            "seed {seed} step {step}"
                        );
                        assert_eq!(
                            buf, before,
                            "seed {seed} step {step}: failed remove changed bytes"
                        );
                    } else {
                        let key = [rng.below(20) as u8 + 1; 32];
                        let found = m.find_permission(&key);
                        let want = model.iter().position(|p| p.program == key);
                        assert_eq!(found, want, "seed {seed} step {step}: find");
                        if let Some(i) = found {
                            m.swap_remove_permission(i).unwrap();
                            model.swap_remove(i);
                        }
                    }
                }
                // verify-style counter update on a random slot
                3 => {
                    if !model.is_empty() {
                        let i = rng.below(model.len() as u64) as usize;
                        let amount = rng.amount();
                        let mut m = Mandate::from_bytes(&mut buf).unwrap();
                        let (total, calls) = {
                            let p = m.permission(i);
                            (
                                p.spend_total().saturating_add(amount),
                                p.call_count().saturating_add(1),
                            )
                        };
                        let mut pm = m.permission_mut(i);
                        pm.set_spend_total(total);
                        pm.set_call_count(calls);
                        // counters are monotone
                        assert!(total >= model[i].spend_total && calls >= model[i].calls);
                        model[i].spend_total = total;
                        model[i].calls = calls;
                    }
                }
                // update_permission-style limit change keeps the counters
                _ => {
                    if !model.is_empty() {
                        let i = rng.below(model.len() as u64) as usize;
                        let (sl, pt) = (rng.amount(), rng.amount());
                        let mut m = Mandate::from_bytes(&mut buf).unwrap();
                        let mut pm = m.permission_mut(i);
                        pm.set_spend_limit(sl);
                        pm.set_per_tx_limit(pt);
                        model[i].spend_limit = sl;
                        model[i].per_tx = pt;
                    }
                }
            }
            assert_bytes_match_model(&buf, &model, seed, step);
            let mut header_now = buf[..HEADER_SIZE].to_vec();
            header_now[OFF_PERM_LEN] = 0;
            header_now[OFF_PERM_LEN + 1] = 0;
            assert_eq!(
                header_now, header_before,
                "seed {seed} step {step}: header drifted"
            );
        }
    }
}

#[test]
fn find_and_allows_agree_with_the_model_on_random_probes() {
    for seed in 1..=prop_cases(200) {
        let mut rng = Rng::new(seed ^ 0xABCD);
        let mut buf = [0u8; ACCOUNT_SIZE];
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        let mut model: Vec<([u8; 32], Vec<[u8; 8]>)> = Vec::new();
        for _ in 0..rng.below(17) {
            let key = [rng.below(30) as u8 + 1; 32];
            if model.iter().any(|(k, _)| *k == key) {
                continue;
            }
            let n = rng.below(9) as usize;
            let discs = random_discs(&mut rng, n);
            m.append_permission(&key, 0, 0, &discs).unwrap();
            model.push((key, discs));
        }
        for _ in 0..200 {
            let key = [rng.below(32) as u8; 32]; // includes the zero key
            let d = [rng.below(8) as u8, 0, 0, 0, 0, 0, 0, 0]; // includes the zero discriminator
            let want_slot = model.iter().position(|(k, _)| *k == key);
            let got_slot = m.find_permission(&key);
            assert_eq!(got_slot, want_slot, "seed {seed}");
            if let (Some(i), Some((_, discs))) = (got_slot, want_slot.map(|i| &model[i])) {
                assert_eq!(
                    m.permission(i).allows(&d),
                    discs.contains(&d),
                    "seed {seed}"
                );
            }
        }
    }
}
