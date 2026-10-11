//! RED TEAM fuzzers for the relay (LiteSVM, real .so). Deterministic: seed via RT_SEED, effort
//! via RT_ITERS. A failing assertion or any "abnormal" outcome (panic, access violation, CU
//! exhaustion, runtime account-rule violation) is a finding.
//!
//!   RT_ITERS=2000 cargo test -p agent-auth-relay --test redteam_fuzz -- --nocapture
//!
//! Replay of one iteration (FZ-01 and FZ-02): RT_SEED=<run seed> RT_REPLAY_IT=<n>. The earlier
//! iterations still draw from the generator (so the stream is identical) but send nothing; iteration
//! n is executed, its outcome, compute units and logs are printed, and the loop stops. The per-flavour
//! seed in a failure message is `RT_SEED ^ (flavour + 1)`; run with the RT_SEED of the whole run.
//! RT_REPLAY_FULL=1 sends every earlier iteration too (slow, the check that the fast-forward is faithful);
//! RT_FLAVOR=classic|ptoken|token2022 restricts FZ-01 / FZ-02 to one Token flavour.

#![allow(clippy::result_large_err, dead_code, unused_imports)]

#[macro_use]
mod common;
mod redteam_util;

use std::collections::BTreeMap;

use common::*;
use redteam_util::*;
use solana_account::Account;

// -------------------------------------------------------------------------------------
// state save / restore so one fixture serves thousands of iterations
// -------------------------------------------------------------------------------------

fn all_keys(ctx: &Ctx) -> Vec<Pubkey> {
    let mut v = transfer_keys(ctx);
    v.extend([ctx.mandate, ctx.policy, ctx.mint, ctx.owner.pubkey(), ctx.agent.pubkey()]);
    if let Some(s) = &ctx.swap {
        v.extend([s.pool_state, s.amm_config, s.observation_state, s.out_mint]);
    }
    v.sort();
    v.dedup();
    v
}

type Saved = Vec<(Pubkey, Option<Account>)>;

fn save(ctx: &Ctx, keys: &[Pubkey]) -> Saved {
    keys.iter().map(|k| (*k, ctx.svm.get_account(k))).collect()
}

fn restore(ctx: &mut Ctx, saved: &Saved) {
    for (k, a) in saved {
        match a {
            Some(a) => ctx.svm.set_account(*k, a.clone()).expect("restore"),
            None => {
                let _ = ctx.svm.set_account(*k, Account::default());
            }
        }
    }
}

fn pool_pick(rng: &mut Rng, ctx: &Ctx, extra: &[Pubkey]) -> Pubkey {
    let mut pool = all_keys(ctx);
    pool.extend_from_slice(extra);
    pool.extend([
        ctx.authority, TOKEN_ID, TOKEN22_ID, SYSTEM_ID, AGENT_AUTH_ID, RELAY_ID, MOCK_AMM_ID,
        ctx.attacker.pubkey(), Pubkey::default(),
    ]);
    if rng.chance(1, 8) {
        return unique();
    }
    pool[rng.below(pool.len())]
}

fn mutate_account(rng: &mut Rng, ctx: &mut Ctx, key: Pubkey, others: &[Pubkey]) {
    let Some(mut a) = ctx.svm.get_account(&key) else { return };
    match rng.below(7) {
        0 | 1 => {
            // flip some bytes at random offsets
            for _ in 0..1 + rng.below(4) {
                if a.data.is_empty() { break; }
                let i = rng.below(a.data.len());
                a.data[i] = rng.byte();
            }
        }
        2 => {
            // overwrite a 32-byte field with a known key
            if a.data.len() >= 32 {
                let off = [0usize, 32, 76, 133][rng.below(4)];
                if off + 32 <= a.data.len() {
                    let k = if others.is_empty() { unique() } else { others[rng.below(others.len())] };
                    a.data[off..off + 32].copy_from_slice(k.as_ref());
                }
            }
        }
        3 => {
            // truncate / extend
            if rng.chance(1, 2) {
                let n = rng.below(a.data.len().max(1));
                a.data.truncate(n);
            } else {
                let n = 1 + rng.below(200);
                a.data.extend(std::iter::repeat(rng.byte()).take(n));
            }
        }
        4 => {
            a.owner = [TOKEN_ID, TOKEN22_ID, SYSTEM_ID, RELAY_ID, AGENT_AUTH_ID, unique()][rng.below(6)];
        }
        5 => {
            // special small values in the numeric fields of a token account
            if a.data.len() >= 129 {
                let v = [0u64, 1, u64::MAX, u64::MAX - 1, 1_000, 999][rng.below(6)];
                let off = [64usize, 121][rng.below(2)];
                a.data[off..off + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
        _ => {
            a.executable = !a.executable;
        }
    }
    let _ = ctx.svm.set_account(key, a);
}

// -------------------------------------------------------------------------------------
// FZ-01: random mutation of fixture accounts, then canonical transfer
// -------------------------------------------------------------------------------------

fn run_transfer_state_fuzz(flavor: Flavor, iters: usize, seed: u64) {
    let mut ctx = Ctx::builder(flavor).build();
    ctx.audit = true;
    let keys = all_keys(&ctx);
    let saved = save(&ctx, &keys);
    let lkeys = transfer_keys(&ctx);
    let mut rng = Rng::new(seed);
    let mut hist: BTreeMap<String, usize> = BTreeMap::new();
    let mut ok_mutations = 0usize;
    // The targets are everything an attacker or a third party could possibly shape plus the
    // owner's own accounts (a corrupted-state robustness check).
    let targets = [
        ctx.source, ctx.recipients[0], ctx.mint, ctx.policy, ctx.mandate, ctx.recipients[1],
        ctx.attacker_token,
    ];
    let replay = replay_from_env();
    for it in 0..replay.map_or(iters, |n| n + 1) {
        restore(&mut ctx, &saved);
        let n_mut = 1 + rng.below(3);
        let mut touched = vec![];
        for _ in 0..n_mut {
            let k = targets[rng.below(targets.len())];
            mutate_account(&mut rng, &mut ctx, k, &keys);
            touched.push(k);
        }
        let before = ledger(&ctx, &lkeys);
        let amount = [1u64, 7, 999, 1_000, 5_000, 10_000_000, u64::MAX][rng.below(7)];
        if replay.is_some_and(|n| it < n) && !replay_full() {
            continue;
        }
        let ix = ctx.transfer_ix(amount);
        let e = ctx.send_agent(&[ix]);
        let after = ledger(&ctx, &lkeys);
        let o = outcome(&e);
        *hist.entry(o.clone()).or_default() += 1;
        if replay == Some(it) {
            println!("REPLAY fz01 flavor {flavor:?} seed {seed} it {it} amount {amount} touched {touched:?} outcome {o} cu {}", e.cu());
            println!("{}", e.pretty_logs());
        }
        if std::env::var("RT_DEBUG").ok().as_deref() == Some(o.as_str()) {
            println!("DEBUG outcome {o} flavor {flavor:?} it {it} amount {amount} touched {touched:?}");
            for (k, orig) in &saved {
                let now = ctx.svm.get_account(k);
                if now != *orig {
                    let (a, b) = (orig.as_ref(), now.as_ref());
                    if let (Some(a), Some(b)) = (a, b) {
                        let diffs: Vec<(usize, u8, u8)> = (0..a.data.len().max(b.data.len())).filter_map(|i| {
                            let x = a.data.get(i).copied(); let y = b.data.get(i).copied();
                            if x != y { Some((i, x.unwrap_or(0), y.unwrap_or(0))) } else { None }
                        }).take(8).collect();
                        println!("   {k}: len {}->{} owner {}->{} exec {}->{} diffs {:?}", a.data.len(), b.data.len(), a.owner, b.owner, a.executable, b.executable, diffs);
                    }
                }
            }
            println!("{}", e.pretty_logs());
        }
        if is_abnormal(&o) {
            // Policy / mandate bytes are only writable by the relay / core themselves, so an
            // abnormal exit caused by corrupting them (e.g. a garbage stored bump) is not
            // reachable by an attacker: record it, do not fail.
            let corrupted_internal = touched.contains(&ctx.policy) || touched.contains(&ctx.mandate);
            assert!(
                corrupted_internal,
                "[{flavor:?} seed {seed} it {it}] ABNORMAL {o} after mutating {touched:?}\n{}",
                e.pretty_logs()
            );
            *hist.entry("(internal-corruption-abnormal)".into()).or_default() += 1;
        }
        if e.is_ok() {
            ok_mutations += 1;
            let d = deltas(&before, &after);
            let mut want = BTreeMap::new();
            want.insert(ctx.source, -(amount as i128));
            want.insert(ctx.recipients[0], amount as i128);
            assert_eq!(
                d, want,
                "[{flavor:?} seed {seed} it {it}] OK but wrong ledger after mutating {touched:?}\n{}",
                e.pretty_logs()
            );
            let v = verify_calls(&e);
            assert_eq!(v.len(), 1, "exactly one verify per transfer");
            assert_eq!(v[0].1, TRANSFER_CHECKED_DISC);
            assert_eq!(v[0].2, amount, "verify amount != moved amount");
        } else {
            assert_eq!(before, after, "[{flavor:?} seed {seed} it {it}] failed tx moved tokens");
        }
    }
    print_hist(&format!("FZ-01 transfer state fuzz {flavor:?} (OK-with-mutation = {ok_mutations})"), &hist);
}

#[test]
fn fz01_transfer_state_fuzz() {
    let iters = iters_from_env(1500);
    let seed = seed_from_env(0xA11CE);
    for f in Flavor::ALL.into_iter().filter(|f| flavor_selected(*f)) {
        run_transfer_state_fuzz(f, iters, seed ^ (f as u64 + 1));
    }
}

// -------------------------------------------------------------------------------------
// FZ-02: same for swap, any hostile mode mixed in
// -------------------------------------------------------------------------------------

fn run_swap_state_fuzz(flavor: Flavor, iters: usize, seed: u64) {
    let mut ctx = Ctx::builder(flavor).with_swap().build();
    let s = ctx.swap_fixture().clone();
    let keys = all_keys(&ctx);
    let saved = save(&ctx, &keys);
    let lkeys = transfer_keys(&ctx);
    let mut rng = Rng::new(seed);
    let mut hist: BTreeMap<String, usize> = BTreeMap::new();
    let targets = [
        s.in_account, s.out_account, s.pool_state, s.input_vault, s.output_vault, s.in_mint,
        s.out_mint, ctx.policy, ctx.mandate, s.amm_config, s.observation_state, ctx.source,
    ];
    let replay = replay_from_env();
    for it in 0..replay.map_or(iters, |n| n + 1) {
        restore(&mut ctx, &saved);
        if rng.chance(1, 2) {
            ctx.set_pool_mode(rng.below(amm_mode::COUNT as usize) as u8);
        }
        let mut touched = vec![];
        for _ in 0..rng.below(3) {
            let k = targets[rng.below(targets.len())];
            mutate_account(&mut rng, &mut ctx, k, &keys);
            touched.push(k);
        }
        let before = ledger(&ctx, &lkeys);
        let amount = [1u64, 100, 10_000, 1_000_000, u64::MAX][rng.below(5)];
        let min_out = [0u64, 1, u64::MAX, 5_000][rng.below(4)];
        let slot = ctx.slot();
        let dl = [slot, slot + 1, slot + 150, slot + 151, u64::MAX][rng.below(5)];
        if replay.is_some_and(|n| it < n) && !replay_full() {
            continue;
        }
        let e = ctx.send_agent(&[ctx.swap_ix(amount, min_out, dl)]);
        let after = ledger(&ctx, &lkeys);
        let o = outcome(&e);
        *hist.entry(o.clone()).or_default() += 1;
        if replay == Some(it) {
            // byte 3 of the policy is the stored authority_bump (see docs/SECURITY.md RT-F7)
            let bump_of = |a: Option<&Account>| a.and_then(|a| a.data.get(3).copied());
            let bump_orig = saved.iter().find(|(k, _)| *k == ctx.policy).and_then(|(_, a)| bump_of(a.as_ref()));
            let bump_now = ctx.svm.get_account(&ctx.policy);
            let policy_touched = touched.contains(&ctx.policy);
            println!("REPLAY fz02 flavor {flavor:?} seed {seed} it {it} amount {amount} min_out {min_out} deadline {dl} policy_touched {policy_touched} authority_bump_original {bump_orig:?} authority_bump_now {:?} outcome {o} cu {}", bump_of(bump_now.as_ref()), e.cu());
            println!("{}", e.pretty_logs());
        }
        let burn = o == "ProgramFailedToComplete" || o == "ComputationalBudgetExceeded";
        if is_abnormal(&o) {
            // BURN_CPU mode legitimately exhausts the budget; anything else is a finding.
            let mode = ctx.svm.get_account(&s.pool_state).map(|a| a.data.first().copied().unwrap_or(0));
            // Policy / mandate bytes are writable only by the relay / core themselves (garbage
            // stored bump => signer-seed derivation failure): not attacker reachable.
            let corrupted_internal = touched.contains(&ctx.policy) || touched.contains(&ctx.mandate);
            assert!(
                corrupted_internal || (burn && mode == Some(amm_mode::BURN_CPU)),
                "[{flavor:?} seed {seed} it {it}] ABNORMAL {o} (pool mode {mode:?}) after mutating {touched:?}\n{}",
                e.pretty_logs()
            );
        }
        if e.is_ok() {
            let d = deltas(&before, &after);
            let in_loss = -d.get(&s.in_account).copied().unwrap_or(0);
            let out_gain = d.get(&s.out_account).copied().unwrap_or(0);
            assert!(in_loss >= 0 && in_loss <= amount as i128, "[{flavor:?} seed {seed} it {it}] in_loss {in_loss} > amount {amount}\n{d:?}");
            let need = required_min_out(amount, 95, 100).unwrap_or(u64::MAX).max(min_out);
            assert!(out_gain >= need as i128, "[{flavor:?} seed {seed} it {it}] out_gain {out_gain} < {need}");
            for (k, v) in &d {
                if *k != s.in_account && *k != s.out_account && *k != s.input_vault && *k != s.output_vault {
                    panic!("[{flavor:?} seed {seed} it {it}] unexpected movement {k} {v}\n{d:?}");
                }
            }
            let vc = verify_calls(&e);
            assert_eq!(vc.len(), 1);
            assert_eq!(vc[0].0, MOCK_AMM_ID);
            assert_eq!(vc[0].1, SWAP_DISC);
            assert_eq!(vc[0].2, amount);
            // under-count check: verify booked >= tokens pulled
            assert!(in_loss <= vc[0].2 as i128);
        } else {
            assert_eq!(before, after, "[{flavor:?} seed {seed} it {it}] failed swap moved tokens");
        }
        assert_eq!(ctx.balance(&ctx.attacker_token), 0, "attacker gained tokens");
    }
    print_hist(&format!("FZ-02 swap state fuzz {flavor:?}"), &hist);
}

#[test]
fn fz02_swap_state_fuzz() {
    let iters = iters_from_env(1500);
    let seed = seed_from_env(0xB0B);
    for f in Flavor::ALL.into_iter().filter(|f| flavor_selected(*f)) {
        run_swap_state_fuzz(f, iters, seed ^ (f as u64 + 1));
    }
}

// -------------------------------------------------------------------------------------
// FZ-03: random instruction data (all tags, all lengths) with the correct account lists
// -------------------------------------------------------------------------------------

#[test]
fn fz03_random_instruction_data() {
    let iters = iters_from_env(3000);
    let mut rng = Rng::new(seed_from_env(0xDA7A));
    for flavor in Flavor::ALL {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let keys = all_keys(&ctx);
        let saved = save(&ctx, &keys);
        let lkeys = transfer_keys(&ctx);
        let mut hist: BTreeMap<String, usize> = BTreeMap::new();
        for it in 0..iters {
            restore(&mut ctx, &saved);
            let which = rng.below(6);
            let len_choices = [0usize, 1, 2, 8, 9, 10, 24, 25, 26, 801, 802, 803, 1024];
            let n_data = len_choices[rng.below(len_choices.len())];
            let mut data = rng.bytes(n_data);
            if !data.is_empty() && rng.chance(3, 4) {
                data[0] = which as u8; // aim at a real tag most of the time
            }
            // amounts small so things can succeed
            if data.len() == 9 || data.len() == 25 {
                for b in data.iter_mut().skip(1).take(7) {
                    *b = 0;
                }
                if rng.chance(1, 2) { data[1] = 1 + (rng.byte() % 100); }
            }
            let (payer, ix) = match which {
                0 => (Who::Owner, ctx.init_policy_accounts().ix(&data)),
                1 => (Who::Owner, ctx.set_paused_ix(0).with_data(&data)),
                2 => (Who::Owner, ctx.close_policy_ix().with_data(&data)),
                3 => (Who::Agent, ctx.transfer_accounts().ix_with_data(&data)),
                4 => (Who::Agent, ctx.swap_accounts().ix_with_data(&data)),
                _ => (Who::Attacker, ctx.transfer_accounts().ix_with_data(&data).with_program(RELAY_ID)),
            };
            if which == 5 {
                // attacker signs as fee payer only; agent signer flag stays set -> sign with agent too
            }
            let signers = if which == 5 { vec![Who::Attacker, Who::Agent] } else { vec![payer] };
            let before = ledger(&ctx, &lkeys);
            let e = ctx.send_as(&signers, &[ix]);
            let after = ledger(&ctx, &lkeys);
            let o = outcome(&e);
            *hist.entry(o.clone()).or_default() += 1;
            assert!(!is_abnormal(&o), "[{flavor:?} it {it}] ABNORMAL {o} tag {which} data {:02x?}\n{}", &data[..data.len().min(40)], e.pretty_logs());
            if !e.is_ok() {
                assert_eq!(before, after);
            }
            assert_eq!(ctx.balance(&ctx.attacker_token), 0);
            assert_eq!(ctx.balance(&ctx.agent_token), 0);
        }
        print_hist(&format!("FZ-03 random data {flavor:?}"), &hist);
    }
}

// -------------------------------------------------------------------------------------
// FZ-04: random account lists / flags for every instruction
// -------------------------------------------------------------------------------------

#[test]
fn fz04_random_account_lists() {
    let iters = iters_from_env(3000);
    let mut rng = Rng::new(seed_from_env(0xACC7));
    for flavor in Flavor::ALL {
        let mut ctx = Ctx::builder(flavor).with_swap().build();
        let keys = all_keys(&ctx);
        let saved = save(&ctx, &keys);
        let lkeys = transfer_keys(&ctx);
        let kp_owner = ctx.owner.insecure_clone();
        let kp_agent = ctx.agent.insecure_clone();
        let kp_att = ctx.attacker.insecure_clone();
        let mut hist: BTreeMap<String, usize> = BTreeMap::new();
        for it in 0..iters {
            restore(&mut ctx, &saved);
            let which = rng.below(5);
            let mut base = match which {
                0 => ctx.init_policy_accounts().ix(&ctx.cfg.init_data(0)),
                1 => ctx.set_paused_ix(rng.below(2) as u8),
                2 => ctx.close_policy_ix(),
                3 => ctx.transfer_ix(1 + rng.below(1000) as u64),
                _ => ctx.swap_ix(1_000 + rng.below(1000) as u64, 0, ctx.deadline(50)),
            };
            // corrupt the account list
            let n_corrupt = rng.below(4);
            for _ in 0..n_corrupt {
                match rng.below(6) {
                    0 if !base.accounts.is_empty() => {
                        let i = rng.below(base.accounts.len());
                        base.accounts[i].pubkey = pool_pick(&mut rng, &ctx, &[]);
                        if base.accounts[i].is_signer {
                            // only keys we hold may stay signers
                            let k = base.accounts[i].pubkey;
                            if k != kp_owner.pubkey() && k != kp_agent.pubkey() && k != kp_att.pubkey() {
                                base.accounts[i].is_signer = false;
                            }
                        }
                    }
                    1 if !base.accounts.is_empty() => {
                        let i = rng.below(base.accounts.len());
                        base.accounts[i].is_writable = !base.accounts[i].is_writable;
                    }
                    2 if !base.accounts.is_empty() => {
                        let i = rng.below(base.accounts.len());
                        let k = base.accounts[i].pubkey;
                        if k == kp_owner.pubkey() || k == kp_agent.pubkey() || k == kp_att.pubkey() {
                            base.accounts[i].is_signer = !base.accounts[i].is_signer;
                        }
                    }
                    3 if !base.accounts.is_empty() => {
                        let i = rng.below(base.accounts.len());
                        base.accounts.remove(i);
                    }
                    4 => {
                        let k = pool_pick(&mut rng, &ctx, &[]);
                        base.accounts.push(AccountMeta::new_readonly(k, false));
                    }
                    _ if base.accounts.len() > 1 => {
                        let i = rng.below(base.accounts.len());
                        let j = rng.below(base.accounts.len());
                        base.accounts.swap(i, j);
                    }
                    _ => {}
                }
            }
            // an optional pile of extra accounts (>20) to stress the entrypoint's skip logic
            if rng.chance(1, 10) {
                for _ in 0..rng.below(40) {
                    let k = pool_pick(&mut rng, &ctx, &[]);
                    base.accounts.push(AccountMeta::new_readonly(k, false));
                }
            }
            let payer = [Who::Owner, Who::Agent, Who::Attacker][rng.below(3)];
            let mut signers = vec![payer];
            // every signer flag on a key we hold needs its signature
            for m in &base.accounts {
                if m.is_signer {
                    let w = if m.pubkey == kp_owner.pubkey() { Who::Owner }
                        else if m.pubkey == kp_agent.pubkey() { Who::Agent }
                        else { Who::Attacker };
                    if !signers.contains(&w) { signers.push(w); }
                }
            }
            let before = ledger(&ctx, &lkeys);
            let policy_before = ctx.svm.get_account(&ctx.policy);
            let e = ctx.send_as(&signers, &[base]);
            let after = ledger(&ctx, &lkeys);
            let o = outcome(&e);
            *hist.entry(o.clone()).or_default() += 1;
            // Runtime account-rule violations when OWNER-signed ix are given read-only accounts
            // (close_policy/set_paused with a read-only policy) are self-inflicted: tolerated,
            // but still printed. Agent-facing ix must never produce them.
            let agent_facing = which >= 3;
            if is_abnormal(&o) {
                let burn = o == "ProgramFailedToComplete"
                    && ctx.svm.get_account(&ctx.swap_fixture().pool_state)
                        .map(|a| a.data[0] == amm_mode::BURN_CPU).unwrap_or(false);
                assert!(!agent_facing || burn, "[{flavor:?} it {it}] agent-facing ABNORMAL {o}\n{}", e.pretty_logs());
                if !agent_facing {
                    println!("NOTE owner-facing abnormal (tag {which}): {o}");
                }
            }
            // The agent must never gain tokens; for failures nothing moves
            assert_eq!(ctx.balance(&ctx.attacker_token), 0);
            assert_eq!(ctx.balance(&ctx.agent_token), 0);
            if !e.is_ok() {
                assert_eq!(before, after, "[{flavor:?} it {it}] failed tx moved tokens");
                assert_eq!(policy_before, ctx.svm.get_account(&ctx.policy), "failed tx changed the policy");
            } else if agent_facing {
                let d = deltas(&before, &after);
                let lost: i128 = [Some(ctx.source), ctx.swap.as_ref().map(|s| s.in_account)]
                    .iter().flatten().filter_map(|k| d.get(k)).filter(|v| **v < 0).sum();
                assert!(lost >= -2_000 && lost <= 0, "owner lost {lost}");
                // all gains only at recipients / out_account / vaults
                for (k, v) in &d {
                    if *v > 0 {
                        let ok = ctx.recipients.contains(k)
                            || ctx.swap.as_ref().map(|s| *k == s.out_account || *k == s.input_vault).unwrap_or(false);
                        assert!(ok, "unexpected gainer {k} {v}");
                    }
                }
            }
        }
        print_hist(&format!("FZ-04 random account lists {flavor:?}"), &hist);
    }
}

// -------------------------------------------------------------------------------------
// FZ-05: init_policy config mutation against an independent oracle of RELAY-SPEC 5.2
// -------------------------------------------------------------------------------------

const NATIVE: Pubkey = NATIVE_MINT;

fn key_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

/// Independent spec oracle. `data` = full init_policy instruction data (802 bytes).
/// Offsets are RELAY-SPEC 5.2 policy offsets minus 144, plus 2 for the tag and flags bytes.
fn oracle_accepts(data: &[u8], mandate: &Pubkey, policy: &Pubkey, authority: &Pubkey, owner: &Pubkey, agent: &Pubkey, amm_ok: &dyn Fn(&Pubkey) -> bool) -> bool {
    if data.len() != 802 || data[0] != 0 {
        return false;
    }
    let flags = data[1];
    if flags & 0xFC != 0 {
        return false;
    }
    let c = &data[2..];
    let zero = Pubkey::default();
    let at = |abs: usize| key_at(c, abs - 144);
    let tp = at(144);
    let bm = at(176);
    let src = at(208);
    if tp != TOKEN_ID && tp != TOKEN22_ID { return false; }
    if bm == zero || bm == NATIVE || src == zero { return false; }
    let n = c[240 - 144] as usize;
    let sw = c[241 - 144];
    if n > 8 || sw > 1 { return false; }
    if c[242 - 144..248 - 144].iter().any(|b| *b != 0) { return false; }
    let mut set: Vec<Pubkey> = vec![*mandate, *policy, *authority, *owner, *agent, src];
    for i in 0..8 {
        let r = at(248 + 32 * i);
        if (i < n) == (r == zero) { return false; }
        if i < n { set.push(r); }
    }
    if sw == 0 {
        if c[504 - 144..].iter().any(|b| *b != 0) { return false; }
    } else {
        let amm = at(504);
        if !amm_ok(&amm) { return false; }
        let ks: Vec<Pubkey> = (0..10).map(|i| at([536, 568, 600, 632, 664, 696, 728, 760, 856, 888][i])).collect();
        if ks.iter().any(|k| *k == zero) { return false; }
        let (in_mint, out_mint) = (at(728), at(760));
        if in_mint == NATIVE || in_mint == out_mint { return false; }
        let (itp, otp) = (at(792), at(824));
        if (itp != TOKEN_ID && itp != TOKEN22_ID) || (otp != TOKEN_ID && otp != TOKEN22_ID) { return false; }
        let (ina, outa) = (at(856), at(888));
        if ina == outa || outa == src { return false; }
        if ina == src && (in_mint != bm || itp != tp) { return false; }
        let fo = u64::from_le_bytes(c[920 - 144..928 - 144].try_into().unwrap());
        let fi = u64::from_le_bytes(c[928 - 144..936 - 144].try_into().unwrap());
        if fo == 0 || fi == 0 { return false; }
        let dl = u32::from_le_bytes(c[936 - 144..940 - 144].try_into().unwrap());
        if dl == 0 || dl > 9000 { return false; }
        if c[940 - 144..944 - 144].iter().any(|b| *b != 0) { return false; }
        set.push(amm);
        for k in [536usize, 568, 600, 632, 664, 696, 888] { set.push(at(k)); }
        if ina != src { set.push(ina); }
    }
    for i in 0..set.len() {
        for j in i + 1..set.len() {
            if set[i] == set[j] { return false; }
        }
    }
    true
}

#[test]
fn fz05_init_policy_config_oracle() {
    let iters = iters_from_env(4000);
    let mut rng = Rng::new(seed_from_env(0xC0FF));
    // TestAmm build: AMM allowlist = {CPMM devnet, mock}
    let amm_ok = |k: &Pubkey| *k == CPMM_DEVNET || *k == MOCK_AMM_ID;
    for flavor in [Flavor::Classic, Flavor::Token2022] {
        let mut ctx = Ctx::builder(flavor).with_swap().no_policy().build();
        let base = ctx.cfg.init_data(0);
        let owner = ctx.owner.pubkey();
        let agent = ctx.agent.pubkey();
        let mut accepted = 0usize;
        let mut rejected_by_relay_but_oracle_ok = 0usize;
        let mut hist: BTreeMap<String, usize> = BTreeMap::new();
        // keys to splice into mutated fields
        let splice: Vec<Pubkey> = {
            let mut v = vec![ctx.mandate, ctx.policy, ctx.authority, owner, agent, ctx.source,
                NATIVE, TOKEN_ID, TOKEN22_ID, Pubkey::default(), MOCK_AMM_ID, CPMM_DEVNET, CPMM_MAINNET,
                ctx.attacker_token, ctx.agent_token];
            v.extend(ctx.recipients.iter().copied());
            if let Some(s) = &ctx.swap { v.extend([s.in_account, s.out_account, s.amm_authority, s.pool_state, s.input_vault, s.output_vault, s.in_mint, s.out_mint]); }
            v
        };
        for it in 0..iters {
            let mut d = base.clone();
            for _ in 0..1 + rng.below(4) {
                match rng.below(5) {
                    0 => { let i = rng.below(d.len()); d[i] = rng.byte(); }
                    1 | 2 => {
                        // splice a known key at a key-aligned field offset
                        let fields = [144usize,176,208,248,280,312,504,536,568,600,632,664,696,728,760,792,824,856,888];
                        let off = fields[rng.below(fields.len())] - 144 + 2;
                        let k = splice[rng.below(splice.len())];
                        d[off..off + 32].copy_from_slice(k.as_ref());
                    }
                    3 => {
                        // numeric specials
                        let (off, len) = [(240 - 144 + 2, 1), (241 - 144 + 2, 1), (920 - 144 + 2, 8), (928 - 144 + 2, 8), (936 - 144 + 2, 4), (1, 1)][rng.below(6)];
                        let v = [0u64, 1, 8, 9, 255, 9000, 9001, u64::MAX][rng.below(8)];
                        d[off..off + len].copy_from_slice(&v.to_le_bytes()[..len]);
                    }
                    _ => { let i = 1 + rng.below(d.len() - 1); d[i] ^= 1 << rng.below(8); }
                }
            }
            let want = oracle_accepts(&d, &ctx.mandate, &ctx.policy, &ctx.authority, &owner, &agent, &amm_ok);
            let ix = ctx.init_policy_accounts().ix(&d);
            let e = ctx.send_owner(&[ix]);
            let o = outcome(&e);
            *hist.entry(o.clone()).or_default() += 1;
            assert!(!is_abnormal(&o), "[{flavor:?} it {it}] ABNORMAL {o}\n{}", e.pretty_logs());
            match (e.is_ok(), want) {
                (true, false) => panic!("[{flavor:?} it {it}] RELAY ACCEPTED a config the spec oracle rejects: {:02x?}", &d[..]),
                (false, true) => {
                    rejected_by_relay_but_oracle_ok += 1;
                    println!("NOTE relay rejected a config the oracle accepts ({o}) it {it}");
                }
                _ => {}
            }
            if e.is_ok() {
                accepted += 1;
                // stored config byte-equals the instruction data
                let p = ctx.svm.data(&ctx.policy);
                assert_eq!(&p[144..], &d[2..], "stored config differs from instruction data");
                assert_eq!(p[4], d[1]);
                ctx.send_owner(&[ctx.close_policy_ix()]).assert_ok();
            }
        }
        print_hist(&format!("FZ-05 init config oracle {flavor:?}: accepted {accepted}, oracle-ok-but-rejected {rejected_by_relay_but_oracle_ok}"), &hist);
    }
}
