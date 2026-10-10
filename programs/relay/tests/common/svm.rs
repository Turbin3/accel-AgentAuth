//! LiteSVM construction: `.so` loaders (hard failure when missing), the token-program
//! flavour switch, and small `LiteSVM` extension helpers.
//!
//! LiteSVM 0.12 has NO cargo feature called `replace_spl_token_with_p_token`. The switch is a
//! runtime feature-set gate: `litesvm::programs::load_default_programs` loads the p-token ELF at
//! the Token program id when the gate `ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP` is active in
//! the `FeatureSet`, and the classic `spl_token-3.5.0.so` otherwise. `new_svm` flips that gate on a
//! mainnet feature set before the default programs are installed.

use std::path::PathBuf;

use litesvm::LiteSVM;
use solana_account::Account;
use solana_pubkey::Pubkey;

use super::ids::{P_TOKEN_FEATURE, TOKEN22_ID, TOKEN_ID};

/// Which token binary a test runs against.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Flavor {
    /// Classic `spl_token-3.5.0.so` at the Token program id (p-token gate OFF).
    Classic,
    /// p-token (`pinocchio_token_program.so`) at the Token program id (p-token gate ON, as on
    /// mainnet-beta and devnet since 2026-10-10, RELAY-SPEC section 11).
    PToken,
    /// Token-2022 for the policy's token program, with the p-token gate ON for the rest.
    Token2022,
}

impl Flavor {
    /// The two flavours every Token-touching P0 test must run on.
    pub const DUAL: [Flavor; 2] = [Flavor::Classic, Flavor::PToken];
    /// All three flavours.
    pub const ALL: [Flavor; 3] = [Flavor::Classic, Flavor::PToken, Flavor::Token2022];

    /// The program id the policy pins as `token_program` for this flavour.
    pub fn token_program(self) -> Pubkey {
        match self {
            Flavor::Classic | Flavor::PToken => TOKEN_ID,
            Flavor::Token2022 => TOKEN22_ID,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Flavor::Classic => "classic",
            Flavor::PToken => "ptoken",
            Flavor::Token2022 => "token2022",
        }
    }

    /// True when the p-token gate is OFF.
    pub fn classic_binary(self) -> bool {
        self == Flavor::Classic
    }
}

// ------------------------------------------------------------------ loaders

pub const ENV_AGENT_AUTH_SO: &str = "AGENT_AUTH_SO";
/// Relay built with default features (production allowlist: only the Raydium CPMM ids).
pub const ENV_RELAY_SO: &str = "AGENT_AUTH_RELAY_SO";
/// Relay built with `--features test-amm` (additionally allowlists the mock AMM). Optional:
/// when unset, swap fixtures fall back to `AGENT_AUTH_RELAY_SO`, which must then itself be a
/// `test-amm` build.
pub const ENV_RELAY_TESTAMM_SO: &str = "AGENT_AUTH_RELAY_TESTAMM_SO";
pub const ENV_MOCK_AMM_SO: &str = "MOCK_AMM_SO";
pub const ENV_GATED_SO: &str = "GATED_EXAMPLE_SO";
pub const ENV_EVIL_TOKEN_SO: &str = "EVIL_TOKEN_SO";
pub const ENV_ALLOW_SKIP: &str = "AGENT_AUTH_ALLOW_SKIP";

/// True when the environment explicitly opts out of the hard-failure rule.
pub fn skip_allowed() -> bool {
    std::env::var(ENV_ALLOW_SKIP)
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// A required `.so` that is not available.
#[derive(Debug)]
pub struct MissingSo {
    pub env: &'static str,
    pub detail: String,
}

impl std::fmt::Display for MissingSo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "required program binary missing: ${} {} \
             (build it with `cargo build-sbf --manifest-path <crate>/Cargo.toml` and export the \
             path, see programs/relay/tests/common/README.md; set {}=1 to skip instead)",
            self.env, self.detail, ENV_ALLOW_SKIP
        )
    }
}

/// Resolve a `.so` path from an environment variable. `Err` when the variable is unset or the
/// file does not exist.
pub fn so_path(env: &'static str) -> Result<PathBuf, MissingSo> {
    match std::env::var(env) {
        Err(_) => Err(MissingSo {
            env,
            detail: "is not set".into(),
        }),
        Ok(p) => {
            let path = PathBuf::from(&p);
            if path.is_file() {
                Ok(path)
            } else {
                Err(MissingSo {
                    env,
                    detail: format!("points to a file that does not exist: {p}"),
                })
            }
        }
    }
}

/// Like [`so_path`] but implements the policy: a missing binary is a HARD failure (panic)
/// unless `AGENT_AUTH_ALLOW_SKIP=1`, in which case `None` is returned and the caller skips.
pub fn require_so(env: &'static str) -> Option<PathBuf> {
    match so_path(env) {
        Ok(p) => Some(p),
        Err(e) => {
            if skip_allowed() {
                eprintln!("SKIP ({ENV_ALLOW_SKIP}=1): {e}");
                None
            } else {
                panic!("{e}");
            }
        }
    }
}

/// Create an empty LiteSVM with the requested token binary installed at the Token program id.
///
/// Mirrors `LiteSVM::new()` (mainnet feature set, builtins, sysvars, feature accounts, default
/// programs, sigverify and blockhash check on) with the p-token gate set explicitly.
pub fn new_svm(flavor: Flavor) -> LiteSVM {
    let mut features = LiteSVM::mainnet_feature_set();
    if flavor.classic_binary() {
        features.deactivate(&P_TOKEN_FEATURE);
    } else {
        features.activate(&P_TOKEN_FEATURE, 0);
    }
    LiteSVM::default()
        .with_feature_set(features)
        .with_builtins()
        .with_lamports(1_000_000u64.wrapping_mul(1_000_000_000))
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
}

/// Which relay binary a fixture loads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayBuild {
    /// Default cargo features: the AMM allowlist holds only the real Raydium CPMM id. This is
    /// the binary that ships; use it for everything that does not need the mock AMM, and for
    /// PL-04 / SW-04 (the mock AMM must be REJECTED by it).
    Default,
    /// `--features test-amm`: the mock AMM is allowlisted (required by every swap test).
    TestAmm,
}

fn relay_path(build: RelayBuild) -> Option<PathBuf> {
    if build == RelayBuild::TestAmm {
        if let Ok(p) = so_path(ENV_RELAY_TESTAMM_SO) {
            return Some(p);
        }
    }
    require_so(ENV_RELAY_SO)
}

/// Load `agent_auth.so` and the requested relay build into `svm` at their fixed ids. Returns
/// `false` (after a message) only when a binary is missing and skipping is allowed.
pub fn load_core_and_relay(svm: &mut LiteSVM, build: RelayBuild) -> bool {
    let Some(core) = require_so(ENV_AGENT_AUTH_SO) else {
        return false;
    };
    let Some(relay) = relay_path(build) else {
        return false;
    };
    svm.add_program_from_file(super::ids::AGENT_AUTH_ID, core)
        .expect("load agent_auth.so");
    svm.add_program_from_file(super::ids::RELAY_ID, relay)
        .expect("load relay .so");
    true
}

/// Load `mock_amm.so` at `MOCK_AMM_ID`. `false` only when missing and skipping is allowed.
pub fn load_mock_amm(svm: &mut LiteSVM) -> bool {
    let Some(p) = require_so(ENV_MOCK_AMM_SO) else {
        return false;
    };
    svm.add_program_from_file(super::ids::MOCK_AMM_ID, p)
        .expect("load mock_amm.so");
    true
}

/// Load `gated_example.so` at `GATED_EXAMPLE_ID`.
pub fn load_gated_example(svm: &mut LiteSVM) -> bool {
    let Some(p) = require_so(ENV_GATED_SO) else {
        return false;
    };
    svm.add_program_from_file(super::ids::GATED_EXAMPLE_ID, p)
        .expect("load gated_example.so");
    true
}

/// Replace the Token program id with the test-only `evil-token` stub (RELAY-SPEC 14.1b).
/// After this call the classic/p-token binary is gone for the lifetime of `svm`.
pub fn install_evil_token(svm: &mut LiteSVM) -> bool {
    let Some(p) = require_so(ENV_EVIL_TOKEN_SO) else {
        return false;
    };
    svm.add_program_from_file(TOKEN_ID, p)
        .expect("load evil_token.so");
    true
}

/// ELF of the `stubs/always_ok` program (returns success for every instruction).
const ALWAYS_OK_SO: &[u8] = include_bytes!("stubs/always_ok/always_ok.so");

/// Install the "always returns Ok" stub at `id`. Used for TR-13 (fake AgentAuth program) and
/// TR-14 (fake Token program): pass `id` in the corresponding instruction account.
pub fn install_always_ok(svm: &mut LiteSVM, id: Pubkey) {
    svm.add_program(id, ALWAYS_OK_SO)
        .expect("load always_ok stub");
}

// ------------------------------------------------------------------ helpers

/// Convenience methods on `LiteSVM` used throughout the harness.
pub trait SvmExt {
    /// Rent-exempt minimum for `len` data bytes (never hard-coded, RELAY-SPEC 5.2).
    fn rent(&self, len: usize) -> u64;
    /// Store an arbitrary account; panics on error.
    fn put(&mut self, key: Pubkey, account: Account);
    /// Raw account data or panic.
    fn data(&self, key: &Pubkey) -> Vec<u8>;
    /// Set the clock (slot and unix timestamp).
    fn set_clock(&mut self, slot: u64, unix_timestamp: i64);
    /// Current slot.
    fn slot(&self) -> u64;
}

impl SvmExt for LiteSVM {
    fn rent(&self, len: usize) -> u64 {
        self.minimum_balance_for_rent_exemption(len)
    }

    fn put(&mut self, key: Pubkey, account: Account) {
        self.set_account(key, account).expect("set_account");
    }

    fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.get_account(key)
            .unwrap_or_else(|| panic!("account {key} does not exist"))
            .data
    }

    fn set_clock(&mut self, slot: u64, unix_timestamp: i64) {
        // Clock sysvar, bincode layout: slot u64 | epoch_start_timestamp i64 | epoch u64 |
        // leader_schedule_epoch u64 | unix_timestamp i64 (40 bytes). Written as a raw account so
        // the harness needs no `solana-clock` dependency; LiteSVM refreshes its sysvar cache.
        let mut account = self
            .get_account(&solana_sdk_ids::sysvar::clock::ID)
            .expect("clock sysvar exists");
        account.data[0..8].copy_from_slice(&slot.to_le_bytes());
        account.data[32..40].copy_from_slice(&unix_timestamp.to_le_bytes());
        self.put(solana_sdk_ids::sysvar::clock::ID, account);
    }

    fn slot(&self) -> u64 {
        let account = self
            .get_account(&solana_sdk_ids::sysvar::clock::ID)
            .expect("clock sysvar exists");
        u64::from_le_bytes(account.data[0..8].try_into().expect("8 bytes"))
    }
}
