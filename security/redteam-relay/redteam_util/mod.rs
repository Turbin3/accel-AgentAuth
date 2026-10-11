//! Red-team helpers shared by `redteam_attacks.rs` and `redteam_fuzz.rs`.
//! Not part of the relay's own suite: lives only in the red-team clone.
#![allow(dead_code, unused_imports)]

use std::collections::BTreeMap;

use crate::common::*;
use solana_transaction::{InstructionError, TransactionError};

/// xorshift64* PRNG (no external dependency, reproducible from a seed).
pub struct Rng(pub u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    pub fn byte(&mut self) -> u8 {
        (self.next() >> 24) as u8
    }
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.byte()).collect()
    }
    pub fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }
}

/// `OK`, `Custom(n)` or the Debug name of the non-custom `InstructionError` / transaction error.
pub fn outcome(e: &Exec) -> String {
    match &e.result {
        Ok(_) => "OK".into(),
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => {
                format!("Custom({c})")
            }
            TransactionError::InstructionError(_, other) => format!("{other:?}"),
            other => format!("TX:{other:?}"),
        },
    }
}

/// Outcomes that mean "the runtime or the program aborted abnormally": a panic, an access
/// violation, an exhausted budget, or the runtime rejecting an illegal account change.
pub fn is_abnormal(outcome: &str) -> bool {
    matches!(
        outcome,
        "ProgramFailedToComplete"
            | "ComputationalBudgetExceeded"
            | "ReadonlyDataModified"
            | "ReadonlyLamportChange"
            | "ExecutableDataModified"
            | "ExecutableLamportChange"
            | "ExternalAccountDataModified"
            | "ExternalAccountLamportSpend"
            | "UnbalancedInstruction"
            | "ModifiedProgramId"
            | "AccountDataSizeChanged"
            | "InvalidRealloc"
            | "ProgramFailedToCompile"
            | "Executable"
    ) || outcome.starts_with("Builtin")
}

pub fn amount_of(ctx: &Ctx, k: &Pubkey) -> Option<u64> {
    let a = ctx.svm.get_account(k)?;
    if a.data.len() >= 72 {
        Some(u64::from_le_bytes(a.data[64..72].try_into().unwrap()))
    } else {
        None
    }
}

pub type Ledger = BTreeMap<Pubkey, u64>;

pub fn ledger(ctx: &Ctx, keys: &[Pubkey]) -> Ledger {
    keys.iter()
        .filter_map(|k| amount_of(ctx, k).map(|a| (*k, a)))
        .collect()
}

/// Every token account of the fixture that a transfer could conceivably touch.
pub fn transfer_keys(ctx: &Ctx) -> Vec<Pubkey> {
    let mut v = vec![ctx.source, ctx.attacker_token, ctx.agent_token];
    v.extend(ctx.recipients.iter().copied());
    if let Some(s) = &ctx.swap {
        v.extend([s.in_account, s.out_account, s.input_vault, s.output_vault]);
    }
    v
}

/// Per-account signed delta (after - before) for accounts that changed.
pub fn deltas(before: &Ledger, after: &Ledger) -> BTreeMap<Pubkey, i128> {
    let mut d = BTreeMap::new();
    for (k, b) in before {
        let a = after.get(k).copied().unwrap_or(0);
        if a != *b {
            d.insert(*k, a as i128 - *b as i128);
        }
    }
    d
}

/// The CPIs the relay made into AgentAuth `verify`: (target program, disc8, amount).
pub fn verify_calls(e: &Exec) -> Vec<(Pubkey, [u8; 8], u64)> {
    e.inner_calls()
        .into_iter()
        .filter(|c| c.program == AGENT_AUTH_ID && c.data.len() == 49 && c.data[0] == 3)
        .map(|c| {
            let mut t = [0u8; 32];
            t.copy_from_slice(&c.data[1..33]);
            let mut d = [0u8; 8];
            d.copy_from_slice(&c.data[33..41]);
            let amt = u64::from_le_bytes(c.data[41..49].try_into().unwrap());
            (Pubkey::new_from_array(t), d, amt)
        })
        .collect()
}

/// Print a histogram of outcomes.
pub fn print_hist(title: &str, h: &BTreeMap<String, usize>) {
    println!("---- {title}");
    for (k, v) in h {
        println!("  {k:<40} {v}");
    }
}

pub fn seed_from_env(default: u64) -> u64 {
    std::env::var("RT_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub fn iters_from_env(default: usize) -> usize {
    std::env::var("RT_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// RT_REPLAY_IT=n: replay only iteration n of FZ-01 / FZ-02 (see redteam_fuzz.rs).
pub fn replay_from_env() -> Option<usize> {
    std::env::var("RT_REPLAY_IT").ok().and_then(|s| s.parse().ok())
}

/// RT_REPLAY_FULL=1: while replaying, also send the earlier iterations (default: only draw from the RNG).
pub fn replay_full() -> bool {
    std::env::var("RT_REPLAY_FULL").ok().as_deref() == Some("1")
}

/// RT_FLAVOR=classic|ptoken|token2022 restricts FZ-01 / FZ-02 to one Token flavour (default: all three).
pub fn flavor_selected(f: Flavor) -> bool {
    match std::env::var("RT_FLAVOR").ok().as_deref() {
        None | Some("") => true,
        Some("classic") => f == Flavor::Classic,
        Some("ptoken") => f == Flavor::PToken,
        Some("token2022") => f == Flavor::Token2022,
        Some(other) => panic!("RT_FLAVOR must be classic, ptoken or token2022, got {other}"),
    }
}
