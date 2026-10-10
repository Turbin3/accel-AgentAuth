//! Fuzzing the compiled program in LiteSVM: random and mutated instruction
//! data against random account lists, with the real mandate, decoys and
//! signer subsets in the pool.
//!
//! What is asserted for every transaction:
//!
//! 1. The outcome is a clean result: success, one of our codes (0..=22, the
//!    low numbers can also come from the System Program through a CPI), or a
//!    well-known built-in rejection. Never a crash (`ProgramFailedToComplete`,
//!    an out-of-compute abort) and never a runtime invariant violation
//!    (unbalanced lamports, edits to read-only or foreign accounts).
//! 2. A failed transaction changed none of the pool accounts.
//! 3. The real mandate, whenever it exists, still satisfies the structural
//!    invariants (packed slots, zeroed tail, sane lengths, header intact).
//! 4. Authority: without the owner's signature nothing but the two counters of
//!    a slot can change, and without the agent's signature not even those.
//!
//! Seeds are printed in every panic. Scale with `AGENT_AUTH_PROP_CASES`.

mod common;
use common::integration::*;

struct Pool {
    e: Env,
    stranger: Keypair,
    payer: Keypair,
    /// (key, may sign) for every account the fuzzer can reference.
    accounts: Vec<(Pubkey, bool)>,
    targets: Vec<Pubkey>,
}

fn build_pool() -> Option<Pool> {
    let mut e = env()?;
    let stranger = funded(&mut e.svm, 1_000_000_000);
    let payer = funded(&mut e.svm, 100_000_000_000);
    let targets: Vec<Pubkey> = (0..4).map(|_| Pubkey::new_unique()).collect();

    assert_ok(e.create(FUTURE));
    assert_ok(e.add(&targets[0], 1_000, 400, &[DISC]));
    assert_ok(e.add(&targets[1], 0, 0, &[DISC, [7; 8]]));
    assert_ok(e.add(&targets[2], 50, 0, &[DISC]));
    let good = e.data();
    let mandate = e.mandate();

    let mut decoy = |lamports: u64, owner: Pubkey, data: Vec<u8>| {
        let k = Pubkey::new_unique();
        e.svm
            .set_account(
                k,
                Account {
                    lamports,
                    data,
                    owner,
                    ..Default::default()
                },
            )
            .unwrap();
        k
    };
    let fake = decoy(5_000_000, program_id(), good.clone());
    let foreign = decoy(5_000_000, Pubkey::new_unique(), good.clone());
    let short = decoy(5_000_000, program_id(), good[..ACCOUNT_SIZE - 1].to_vec());
    let husk = decoy(5_000_000, program_id(), vec![0; ACCOUNT_SIZE]);
    let sysdata = decoy(5_000_000, solana_sdk_ids::system_program::ID, vec![3; 5]);
    let mut corrupt = good.clone();
    corrupt[OFF_PERM_LEN] = 200;
    let corrupt = decoy(5_000_000, program_id(), corrupt);

    let accounts = vec![
        (mandate, false),
        (e.owner_key(), true),
        (e.agent_key(), true),
        (stranger.pubkey(), true),
        (fake, false),
        (foreign, false),
        (short, false),
        (husk, false),
        (sysdata, false),
        (corrupt, false),
        (solana_sdk_ids::system_program::ID, false),
        (program_id(), false),
        (Pubkey::new_unique(), false),
        (targets[0], false),
    ];
    Some(Pool {
        e,
        stranger,
        payer,
        accounts,
        targets,
    })
}

impl Pool {
    fn key_pool(&self) -> Vec<Pubkey> {
        self.accounts.iter().map(|a| a.0).collect()
    }
    fn can_sign(&self, k: &Pubkey) -> bool {
        self.accounts.iter().any(|(p, s)| p == k && *s)
    }
    fn meta(&self, rng: &mut Rng, key: Pubkey) -> AccountMeta {
        AccountMeta {
            pubkey: key,
            is_signer: self.can_sign(&key) && rng.chance(2),
            is_writable: rng.chance(2),
        }
    }
    fn target(&self, rng: &mut Rng) -> Pubkey {
        if rng.chance(6) {
            Pubkey::new_unique()
        } else {
            *rng.pick(&self.targets)
        }
    }

    /// A valid instruction of a random kind, to be mutated.
    fn valid_ix(&self, rng: &mut Rng) -> Instruction {
        let (o, a, m) = (self.e.owner_key(), self.e.agent_key(), self.e.mandate());
        let t = self.target(rng);
        match rng.below(7) {
            0 => create_ix(&o, &a, NOW + 1 + rng.below(1_000) as i64),
            1 => {
                let n = rng.below(10) as usize;
                let discs: Vec<[u8; 8]> = (0..n)
                    .map(|_| [rng.below(4) as u8, 0, 0, 0, 0, 0, 0, 0])
                    .collect();
                add_ix(&o, &m, &t, rng.amount(), rng.amount(), &discs)
            }
            2 => remove_ix(&o, &m, &t),
            3 => verify_ix(
                &m,
                &o,
                &a,
                &t,
                &if rng.chance(2) { DISC } else { [7; 8] },
                rng.amount(),
            ),
            4 => revoke_ix(&o, &m),
            5 => set_active_ix(&o, &m, rng.below(3) as u8),
            _ => update_ix(&o, &m, &t, rng.amount(), rng.amount()),
        }
    }

    fn mutate(&self, rng: &mut Rng, ix: &mut Instruction) {
        for _ in 0..1 + rng.below(3) {
            match rng.below(10) {
                0 if !ix.accounts.is_empty() => {
                    let i = rng.below(ix.accounts.len() as u64) as usize;
                    ix.accounts.remove(i);
                }
                1 if !ix.accounts.is_empty() => {
                    let i = rng.below(ix.accounts.len() as u64) as usize;
                    let c = ix.accounts[i].clone();
                    let at = rng.below(ix.accounts.len() as u64 + 1) as usize;
                    ix.accounts.insert(at, c);
                }
                2 if ix.accounts.len() > 1 => {
                    let (i, j) = (
                        rng.below(ix.accounts.len() as u64) as usize,
                        rng.below(ix.accounts.len() as u64) as usize,
                    );
                    ix.accounts.swap(i, j);
                }
                3 if !ix.accounts.is_empty() => {
                    let i = rng.below(ix.accounts.len() as u64) as usize;
                    let k = *rng.pick(&self.key_pool());
                    ix.accounts[i] = self.meta(rng, k);
                }
                4 if !ix.accounts.is_empty() => {
                    let i = rng.below(ix.accounts.len() as u64) as usize;
                    if rng.chance(2) {
                        ix.accounts[i].is_writable = !ix.accounts[i].is_writable;
                    } else if self.can_sign(&ix.accounts[i].pubkey) {
                        ix.accounts[i].is_signer = !ix.accounts[i].is_signer;
                    }
                }
                5 if !ix.data.is_empty() => {
                    let i = rng.below(ix.data.len() as u64) as usize;
                    ix.data[i] ^= 1 << rng.below(8);
                }
                6 => {
                    let n = rng.below(ix.data.len() as u64 + 1) as usize;
                    ix.data.truncate(n);
                }
                7 => {
                    let n = 1 + rng.below(8) as usize;
                    let extra = rng.bytes(n);
                    ix.data.extend(extra);
                }
                8 if !ix.data.is_empty() => ix.data[0] = rng.below(12) as u8,
                9 => {
                    let n = rng.below(130) as usize;
                    ix.data = rng.bytes(n);
                }
                _ => {}
            }
        }
        // a signer flag without a keypair would make the harness panic, not the program
        for m in &mut ix.accounts {
            if m.is_signer && !self.can_sign(&m.pubkey) {
                m.is_signer = false;
            }
        }
    }

    fn random_ix(&self, rng: &mut Rng) -> Instruction {
        if rng.chance(4) {
            // pure noise: random tag, random payload, random accounts
            let n = rng.below(130) as usize;
            let mut data = rng.bytes(n);
            if let Some(tag) = data.first_mut() {
                if rng.chance(2) {
                    *tag = rng.below(8) as u8;
                }
            }
            let k = rng.below(6) as usize;
            let accounts = (0..k)
                .map(|_| {
                    let key = *rng.pick(&self.key_pool());
                    self.meta(rng, key)
                })
                .collect();
            Instruction::new_with_bytes(program_id(), &data, accounts)
        } else {
            let mut ix = self.valid_ix(rng);
            if !rng.chance(5) {
                self.mutate(rng, &mut ix);
            }
            ix
        }
    }
}

// --- checks ------------------------------------------------------------------------

/// Failures that mean a crash or a runtime invariant violation. A read-only
/// owner on `revoke` (`ReadonlyLamportChange`) is a clean, atomic rejection and
/// is pinned in `error_matrix.rs`, so it is not listed.
const CRASHES: [&str; 7] = [
    "ProgramFailedToComplete",
    "ComputationalBudgetExceeded",
    "UnbalancedInstruction",
    "ExternalAccountLamportSpend",
    "ExternalAccountDataModified",
    "ReadonlyDataModified",
    "ProgramFailedToCompile",
];

fn assert_clean(result: &Sent, ctx: &str) {
    if let Err(e) = result {
        let text = format!("{:?}", e.err);
        for bad in CRASHES {
            assert!(
                !text.contains(bad),
                "{ctx}: {text}\nlogs: {:#?}",
                e.meta.logs
            );
        }
        if let Some(c) = custom_code(&text) {
            assert!(c <= 22, "{ctx}: unexpected custom code {c} in {text}");
        }
    }
}

fn assert_structure(e: &Env, ctx: &str) {
    let Some(acc) = e.account() else { return };
    assert_eq!(acc.owner, program_id(), "{ctx}: mandate owner changed");
    let d = &acc.data;
    assert_eq!(d.len(), ACCOUNT_SIZE, "{ctx}: mandate size changed");
    assert_eq!(d[OFF_DISC], MANDATE_DISCRIMINATOR, "{ctx}");
    assert_eq!(
        &d[OFF_OWNER..OFF_OWNER + 32],
        e.owner_key().as_ref(),
        "{ctx}: owner field"
    );
    assert_eq!(
        &d[OFF_AGENT..OFF_AGENT + 32],
        e.agent_key().as_ref(),
        "{ctx}: agent field"
    );
    assert!(d[OFF_ACTIVE] <= 1, "{ctx}: active byte {}", d[OFF_ACTIVE]);
    assert_eq!(d[OFF_VERSION], CURRENT_VERSION, "{ctx}");
    assert_eq!(d[OFF_BUMP], e.bump(), "{ctx}");
    assert!(
        d[74..77].iter().all(|&b| b == 0) && d[81..HEADER_SIZE].iter().all(|&b| b == 0),
        "{ctx}: padding"
    );
    let len = perm_len(d) as usize;
    assert!(len <= MAX_PERMISSIONS, "{ctx}: permissions_len {len}");
    let mut seen = std::collections::HashSet::new();
    for i in 0..len {
        let key = slot_program(d, i).to_vec();
        assert!(
            key.iter().any(|&b| b != 0),
            "{ctx}: slot {i} has the zero key"
        );
        assert!(seen.insert(key), "{ctx}: duplicate program in slot {i}");
        let n = d[slot_base(i) + P_DISC_LEN] as usize;
        assert!(
            (1..=MAX_DISCRIMINATORS).contains(&n),
            "{ctx}: slot {i} disc_len {n}"
        );
        assert!(
            d[slot_base(i) + P_DISCRIMINATORS + n * 8..slot_base(i + 1)]
                .iter()
                .all(|&b| b == 0),
            "{ctx}: slot {i} stale discriminator bytes"
        );
    }
    assert!(
        d[slot_base(len)..].iter().all(|&b| b == 0),
        "{ctx}: tail not zero"
    );
}

/// Everything except the two counter fields of each slot.
fn without_counters(data: &[u8]) -> Vec<u8> {
    let mut d = data.to_vec();
    for i in 0..MAX_PERMISSIONS {
        let b = slot_base(i);
        d[b + P_SPEND_TOTAL..b + P_SPEND_TOTAL + 8].fill(0);
        d[b + P_CALL_COUNT..b + P_CALL_COUNT + 4].fill(0);
    }
    d
}

fn signed(ixs: &[Instruction], key: &Pubkey) -> bool {
    ixs.iter()
        .any(|ix| ix.accounts.iter().any(|m| m.is_signer && &m.pubkey == key))
}

fn run_fuzz(seed: u64, txs: usize) {
    let Some(mut pool) = build_pool() else { return };
    let mut rng = Rng::new(seed);
    let keys = pool.key_pool();
    let (owner, agent, stranger, payer) = (
        pool.e.owner.insecure_clone(),
        pool.e.agent.insecure_clone(),
        pool.stranger.insecure_clone(),
        pool.payer.insecure_clone(),
    );
    let mut now = NOW;

    for n in 0..txs {
        // keep the interesting account alive
        if pool.e.account().is_none() && rng.chance(2) {
            assert_ok(pool.e.create(now + 1_000_000));
        }
        if rng.chance(25) {
            now += rng.below(2_000_000) as i64;
            set_time(&mut pool.e.svm, now);
        }

        let count = if rng.chance(4) { 2 } else { 1 };
        let ixs: Vec<Instruction> = (0..count).map(|_| pool.random_ix(&mut rng)).collect();
        let ctx = format!("seed {seed} tx {n}");

        let before = Snapshot::take(&pool.e.svm, &keys);
        let result =
            send_signed_as_marked(&mut pool.e.svm, &payer, &[&owner, &agent, &stranger], &ixs);
        let after = Snapshot::take(&pool.e.svm, &keys);

        assert_clean(&result, &ctx);
        if result.is_err() {
            before.assert_same(&after, &ctx);
        }
        assert_structure(&pool.e, &ctx);

        // authority: who signed decides what may have changed on the real mandate
        let (owner_signed, agent_signed) =
            (signed(&ixs, &owner.pubkey()), signed(&ixs, &agent.pubkey()));
        if result.is_ok() && !owner_signed {
            let (b, a) = (
                &before.entry(&pool.e.mandate()),
                &after.entry(&pool.e.mandate()),
            );
            match (b, a) {
                (Some(b), Some(a)) => {
                    assert_eq!(
                        b.0, a.0,
                        "{ctx}: mandate lamports changed without the owner"
                    );
                    assert_eq!(b.1, a.1, "{ctx}: mandate owner changed without the owner");
                    assert_eq!(
                        without_counters(&b.2),
                        without_counters(&a.2),
                        "{ctx}: mandate edited without the owner"
                    );
                    if !agent_signed {
                        assert_eq!(b.2, a.2, "{ctx}: counters moved without the agent");
                    }
                }
                (None, None) => {}
                _ => panic!("{ctx}: the mandate was created or closed without the owner"),
            }
        }
    }
}

#[test]
fn random_and_mutated_instructions_never_crash_the_program() {
    for seed in 1..=prop_cases(6) {
        run_fuzz(seed, 400);
    }
}

#[test]
fn every_tag_survives_every_payload_length() {
    // deterministic sweep: tag 0..=8, payload length 0..=140, random bytes, correct accounts
    let Some(mut pool) = build_pool() else { return };
    let mut rng = Rng::new(99);
    let (o, a, m) = (pool.e.owner_key(), pool.e.agent_key(), pool.e.mandate());
    let (owner, agent) = (pool.e.owner.insecure_clone(), pool.e.agent.insecure_clone());
    for tag in 0u8..=8 {
        for len in 0..=140usize {
            let mut data = vec![tag];
            data.extend(rng.bytes(len));
            // valid account lists of every shape the instructions use
            for accounts in [
                vec![AccountMeta::new(o, true), AccountMeta::new(m, false)],
                vec![
                    AccountMeta::new(m, false),
                    AccountMeta::new_readonly(o, false),
                    AccountMeta::new_readonly(a, true),
                ],
                create_ix(&o, &a, FUTURE).accounts,
            ] {
                let ix = Instruction::new_with_bytes(program_id(), &data, accounts);
                let ctx = format!("tag {tag} len {len}");
                let result = send_signed_as_marked(
                    &mut pool.e.svm,
                    &pool.payer.insecure_clone(),
                    &[&owner, &agent],
                    &[ix],
                );
                assert_clean(&result, &ctx);
                assert_structure(&pool.e, &ctx);
            }
        }
    }
}

#[test]
fn a_stranger_with_every_account_cannot_change_anything() {
    // The strongest negative: a stranger signs, the real owner/agent/mandate are
    // all present (unsigned) in random order, with every tag and random payloads.
    let Some(mut pool) = build_pool() else { return };
    let mut rng = Rng::new(7);
    let keys = pool.key_pool();
    let stranger = pool.stranger.insecure_clone();
    let payer = pool.payer.insecure_clone();
    let (o, a, m) = (pool.e.owner_key(), pool.e.agent_key(), pool.e.mandate());
    let before = Snapshot::take(&pool.e.svm, &keys);
    for _ in 0..prop_cases(800) {
        let mut accounts = vec![
            AccountMeta::new(o, false),
            AccountMeta::new(a, false),
            AccountMeta::new(m, false),
            AccountMeta::new(stranger.pubkey(), rng.chance(2)),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ];
        for i in (1..accounts.len()).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            accounts.swap(i, j);
        }
        let n = rng.below(60) as usize;
        let mut data = vec![rng.below(7) as u8];
        data.extend(rng.bytes(n));
        let ix = Instruction::new_with_bytes(program_id(), &data, accounts);
        let result = send_signed_as_marked(&mut pool.e.svm, &payer, &[&stranger], &[ix]);
        if let Err(e) = &result {
            let text = format!("{:?}", e.err);
            for bad in CRASHES {
                assert!(!text.contains(bad), "{text}");
            }
        }
        // a stranger-signed transaction may not succeed in changing the pool
        if result.is_ok() {
            before.assert_same(
                &Snapshot::take(&pool.e.svm, &keys),
                "a stranger-only transaction succeeded and changed state",
            );
        }
    }
    before.assert_same(&Snapshot::take(&pool.e.svm, &keys), "final");
}
