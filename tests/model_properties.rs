//! Stateful differential test: random valid-shape sequences of every
//! instruction run on the real program in LiteSVM and, in lockstep, on a plain
//! Rust model of the documented contract. After every step:
//!
//! * the transaction outcome (Ok or the exact error code) equals the model's,
//! * the full account bytes equal the model's rendering (header, every slot, zeroed tail),
//! * a failed instruction left the account byte-identical,
//! * counters never decrease except when a slot is removed, the mandate is
//!   revoked or re-created, and a successful `verify` never takes
//!   `spend_total` past a non-zero `spend_limit` or accepts an amount above a
//!   non-zero `per_tx_limit`.
//!
//! The model is written from the error table in `src/error.rs`, not from the
//! program source. Reproduce a failure with the printed seed; scale the run with
//! `AGENT_AUTH_PROP_CASES`.

mod common;
use common::integration::*;

#[derive(Clone, Debug)]
struct MPerm {
    program: Pubkey,
    spend_limit: u64,
    per_tx: u64,
    total: u64,
    calls: u32,
    discs: Vec<[u8; 8]>,
}

#[derive(Clone, Debug, Default)]
struct Model {
    exists: bool,
    active: bool,
    expiry: i64,
    perms: Vec<MPerm>,
}

type Outcome = Result<(), E>;

#[derive(Clone, Debug)]
enum Op {
    Create(i64),
    Add(Pubkey, u64, u64, Vec<[u8; 8]>),
    Remove(Pubkey),
    Update(Pubkey, u64, u64),
    SetActive(bool),
    Verify(Pubkey, [u8; 8], u64),
    Revoke,
    Warp(i64),
}

impl Model {
    fn slot(&self, p: &Pubkey) -> Option<usize> {
        self.perms.iter().position(|x| &x.program == p)
    }

    /// Apply `op` at time `now`; returns what the contract says should happen.
    fn apply(&mut self, op: &Op, now: i64) -> Outcome {
        match op {
            Op::Warp(_) => Ok(()),
            Op::Create(expiry) => {
                // error.rs order: the expiry is checked before the account is looked at
                if *expiry <= now {
                    return Err(E::InvalidExpiry);
                }
                if self.exists {
                    return Err(E::AlreadyInitialized);
                }
                *self = Model {
                    exists: true,
                    active: true,
                    expiry: *expiry,
                    perms: vec![],
                };
                Ok(())
            }
            _ if !self.exists => Err(E::AccountOwnerMismatch),
            Op::Revoke => {
                *self = Model::default();
                Ok(())
            }
            Op::SetActive(a) => {
                self.active = *a;
                Ok(())
            }
            _ if !self.active => Err(E::NotActive),
            Op::Add(p, sl, pt, discs) => {
                if discs.is_empty() {
                    return Err(E::EmptyDiscriminators);
                }
                if discs.len() > 8 {
                    return Err(E::TooManyDiscriminators);
                }
                if self.slot(p).is_some() {
                    return Err(E::DuplicatePermission);
                }
                if self.perms.len() == 16 {
                    return Err(E::PermissionsFull);
                }
                self.perms.push(MPerm {
                    program: *p,
                    spend_limit: *sl,
                    per_tx: *pt,
                    total: 0,
                    calls: 0,
                    discs: discs.clone(),
                });
                Ok(())
            }
            Op::Remove(p) => {
                let i = self.slot(p).ok_or(E::PermissionNotFound)?;
                self.perms.swap_remove(i);
                Ok(())
            }
            Op::Update(p, sl, pt) => {
                let i = self.slot(p).ok_or(E::PermissionNotFound)?;
                self.perms[i].spend_limit = *sl;
                self.perms[i].per_tx = *pt;
                Ok(())
            }
            Op::Verify(p, d, amount) => {
                if now >= self.expiry {
                    return Err(E::Expired);
                }
                let i = self.slot(p).ok_or(E::ProgramNotAllowed)?;
                let perm = &mut self.perms[i];
                if !perm.discs.contains(d) {
                    return Err(E::DiscriminatorNotAllowed);
                }
                if perm.per_tx != 0 && *amount > perm.per_tx {
                    return Err(E::PerTxExceeded);
                }
                let total = if perm.spend_limit == 0 {
                    perm.total.saturating_add(*amount)
                } else {
                    match perm.total.checked_add(*amount) {
                        Some(t) if t <= perm.spend_limit => t,
                        _ => return Err(E::SpendLimitExceeded),
                    }
                };
                perm.total = total;
                perm.calls = perm.calls.saturating_add(1);
                Ok(())
            }
        }
    }
}

/// Send `op` to the real program.
fn execute(e: &mut Env, op: &Op) -> Sent {
    match op {
        Op::Create(x) => e.create(*x),
        Op::Add(p, sl, pt, d) => e.add(p, *sl, *pt, d),
        Op::Remove(p) => e.remove(p),
        Op::Update(p, sl, pt) => e.update(p, *sl, *pt),
        Op::SetActive(a) => e.set_active(*a as u8),
        Op::Verify(p, d, a) => e.verify(p, d, *a),
        Op::Revoke => e.revoke(),
        Op::Warp(_) => unreachable!("clock moves are applied by the caller"),
    }
}

fn check_bytes(e: &Env, model: &Model, ctx: &str) {
    let Some(acc) = e.account() else {
        assert!(
            !model.exists,
            "{ctx}: model says the mandate exists, chain has none"
        );
        return;
    };
    assert!(model.exists, "{ctx}: chain has a mandate the model closed");
    let d = &acc.data;
    assert_eq!(acc.owner, program_id(), "{ctx}");
    assert_eq!(d.len(), ACCOUNT_SIZE, "{ctx}");
    assert_eq!(d[OFF_DISC], MANDATE_DISCRIMINATOR, "{ctx}");
    assert_eq!(
        &d[OFF_OWNER..OFF_OWNER + 32],
        e.owner_key().as_ref(),
        "{ctx}"
    );
    assert_eq!(
        &d[OFF_AGENT..OFF_AGENT + 32],
        e.agent_key().as_ref(),
        "{ctx}"
    );
    assert_eq!(expiry_of(d), model.expiry, "{ctx}: expiry");
    assert_eq!(d[OFF_ACTIVE], model.active as u8, "{ctx}: active");
    assert_eq!(d[OFF_VERSION], CURRENT_VERSION, "{ctx}");
    assert_eq!(d[OFF_BUMP], e.bump(), "{ctx}: bump");
    assert!(
        d[74..77].iter().all(|&b| b == 0) && d[81..HEADER_SIZE].iter().all(|&b| b == 0),
        "{ctx}: header padding"
    );
    assert_eq!(
        perm_len(d) as usize,
        model.perms.len(),
        "{ctx}: permissions_len"
    );
    for (i, want) in model.perms.iter().enumerate() {
        assert_eq!(
            slot_program(d, i),
            want.program.as_ref(),
            "{ctx}: slot {i} key"
        );
        assert_eq!(
            spend_limit(d, i),
            want.spend_limit,
            "{ctx}: slot {i} spend_limit"
        );
        assert_eq!(per_tx_limit(d, i), want.per_tx, "{ctx}: slot {i} per_tx");
        assert_eq!(spend_total(d, i), want.total, "{ctx}: slot {i} spend_total");
        assert_eq!(call_count(d, i), want.calls, "{ctx}: slot {i} call_count");
        assert_eq!(
            slot_discs(d, i),
            want.discs,
            "{ctx}: slot {i} discriminators"
        );
        let used = slot_base(i) + P_DISCRIMINATORS + want.discs.len() * 8;
        assert!(
            d[used..slot_base(i + 1)].iter().all(|&b| b == 0),
            "{ctx}: slot {i} unused discriminator bytes"
        );
    }
    assert!(
        d[slot_base(model.perms.len())..].iter().all(|&b| b == 0),
        "{ctx}: bytes past the last permission are not zero"
    );
}

fn random_op(rng: &mut Rng, model: &Model, now: i64, programs: &[Pubkey], discs: &[[u8; 8]]) -> Op {
    let pick_program = |rng: &mut Rng| -> Pubkey {
        if !model.perms.is_empty() && !rng.chance(5) {
            model.perms[rng.below(model.perms.len() as u64) as usize].program
        } else {
            *rng.pick(programs)
        }
    };
    match rng.below(100) {
        0..=22 => {
            let n = match rng.below(10) {
                0 => 0,
                1 => 9,
                _ => 1 + rng.below(8) as usize,
            };
            let ds = (0..n).map(|_| *rng.pick(discs)).collect();
            Op::Add(*rng.pick(programs), rng.amount(), rng.amount(), ds)
        }
        23..=62 => {
            let p = pick_program(rng);
            let d = match model.slot(&p) {
                Some(i) if !rng.chance(4) && !model.perms[i].discs.is_empty() => {
                    model.perms[i].discs[rng.below(model.perms[i].discs.len() as u64) as usize]
                }
                _ => *rng.pick(discs),
            };
            Op::Verify(p, d, rng.amount())
        }
        63..=70 => Op::Remove(pick_program(rng)),
        71..=79 => Op::Update(pick_program(rng), rng.amount(), rng.amount()),
        80..=85 => Op::SetActive(!rng.chance(3)),
        86..=88 => Op::Revoke,
        89..=92 => Op::Create(match rng.below(5) {
            0 => now,
            1 => now - 1,
            2 => now + 1,
            _ => now + 50 + rng.below(400) as i64,
        }),
        _ => Op::Warp(rng.below(120) as i64),
    }
}

fn run_sequence(seed: u64, steps: usize) {
    let Some(mut e) = env() else { return };
    let mut rng = Rng::new(seed);
    let programs: Vec<Pubkey> = (0..20).map(|_| Pubkey::new_unique()).collect();
    let discs: Vec<[u8; 8]> = (1..=6u8).map(|i| [i, 0, 0, 0, 0, 0, 0, 0]).collect();
    let mut model = Model::default();
    let mut now = NOW;

    // every sequence starts from a live mandate so most steps are meaningful
    let first = Op::Create(NOW + 300);
    assert_ok(execute(&mut e, &first));
    model.apply(&first, now).unwrap();

    for step in 0..steps {
        let op = random_op(&mut rng, &model, now, &programs, &discs);
        let ctx = format!("seed {seed} step {step} op {op:?} now {now}");
        let before_data = e.account().map(|a| (a.lamports, a.data));
        let before_model = model.clone();

        let expected = model.apply(&op, now);
        if let Op::Warp(s) = op {
            now += s;
            set_time(&mut e.svm, now);
            check_bytes(&e, &model, &ctx);
            continue;
        }
        let sent = execute(&mut e, &op);
        match (&expected, &sent) {
            (Ok(()), Ok(_)) => {}
            (Ok(()), Err(err)) => panic!("{ctx}: model says Ok, chain failed with {:?}", err.err),
            (Err(want), Ok(_)) => panic!("{ctx}: model says {want:?}, chain succeeded"),
            (Err(want), Err(_)) => {
                assert_eq!(
                    code(&sent),
                    Some(*want as u32),
                    "{ctx}: wrong error code ({:?})",
                    sent.as_ref().err().map(|x| &x.err)
                );
                let after = e.account().map(|a| (a.lamports, a.data));
                assert_eq!(
                    after, before_data,
                    "{ctx}: a failed instruction changed the account"
                );
                model = before_model.clone();
            }
        }
        check_bytes(&e, &model, &ctx);

        // monotone counters and limit invariants, read from the chain
        if let (Ok(()), Some(after)) = (&expected, e.account()) {
            if let Op::Verify(p, _, amount) = &op {
                let d = &after.data;
                let i = (0..perm_len(d) as usize)
                    .find(|&i| slot_program(d, i) == p.as_ref())
                    .expect("slot");
                let (limit, per_tx) = (spend_limit(d, i), per_tx_limit(d, i));
                assert!(
                    limit == 0 || spend_total(d, i) <= limit,
                    "{ctx}: total past the limit"
                );
                assert!(
                    per_tx == 0 || *amount <= per_tx,
                    "{ctx}: amount past per_tx"
                );
                let prev = before_model
                    .perms
                    .iter()
                    .find(|x| &x.program == p)
                    .expect("prev slot");
                assert!(
                    spend_total(d, i) >= prev.total && call_count(d, i) >= prev.calls,
                    "{ctx}: counters went down"
                );
            }
            if matches!(op, Op::Update(..) | Op::SetActive(_) | Op::Add(..)) {
                for old in &before_model.perms {
                    if let Some(i) = model.slot(&old.program) {
                        assert_eq!(
                            model.perms[i].total, old.total,
                            "{ctx}: counters must survive"
                        );
                        assert_eq!(
                            model.perms[i].calls, old.calls,
                            "{ctx}: counters must survive"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn random_sequences_match_the_model_byte_for_byte() {
    for seed in 1..=prop_cases(40) {
        run_sequence(seed, 80);
    }
}

#[test]
fn long_sequences_hold_the_invariants() {
    // fewer, longer runs: counters reach saturation, slots churn through 16 entries
    for seed in 1000..1000 + prop_cases(4) {
        run_sequence(seed, 400);
    }
}

/// The model itself is checked against hand-computed cases so a wrong model
/// cannot silently agree with a wrong program.
#[test]
fn the_model_encodes_the_documented_contract() {
    let p = Pubkey::new_unique();
    let d = [1, 0, 0, 0, 0, 0, 0, 0];
    let mut m = Model::default();
    assert_eq!(
        m.apply(&Op::Add(p, 0, 0, vec![d]), 0),
        Err(E::AccountOwnerMismatch)
    );
    assert_eq!(m.apply(&Op::Create(10), 10), Err(E::InvalidExpiry));
    assert_eq!(m.apply(&Op::Create(11), 10), Ok(()));
    assert_eq!(m.apply(&Op::Create(99), 10), Err(E::AlreadyInitialized));
    assert_eq!(
        m.apply(&Op::Create(10), 10),
        Err(E::InvalidExpiry),
        "expiry is checked first"
    );
    assert_eq!(
        m.apply(&Op::Add(p, 10, 0, vec![]), 10),
        Err(E::EmptyDiscriminators)
    );
    assert_eq!(m.apply(&Op::Add(p, 10, 0, vec![d]), 10), Ok(()));
    assert_eq!(
        m.apply(&Op::Add(p, 10, 0, vec![d]), 10),
        Err(E::DuplicatePermission)
    );
    assert_eq!(m.apply(&Op::Verify(p, d, 10), 10), Ok(()));
    assert_eq!(
        m.apply(&Op::Verify(p, d, 1), 10),
        Err(E::SpendLimitExceeded)
    );
    assert_eq!(m.apply(&Op::Verify(p, d, 0), 11), Err(E::Expired));
    assert_eq!(m.apply(&Op::SetActive(false), 10), Ok(()));
    assert_eq!(m.apply(&Op::Verify(p, d, 0), 10), Err(E::NotActive));
    assert_eq!(m.apply(&Op::Revoke, 10), Ok(()));
    assert_eq!(m.apply(&Op::Revoke, 10), Err(E::AccountOwnerMismatch));
}
