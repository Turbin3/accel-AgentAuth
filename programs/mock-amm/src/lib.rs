//! # mock-amm: TEST / DEMO infrastructure only
//!
//! **DO NOT DEPLOY TO MAINNET.** This program is a toy. It exists so that AgentAuth's tests and
//! demos have a pool that speaks the Raydium CP-Swap `swap_base_input` ABI and can be told to
//! misbehave in 13 documented ways. It has no fees, no LP accounting, no oracle, no admin and
//! no audit. The relay only allowlists it behind the `test-amm` cargo feature.
//!
//! ## Instructions (8-byte discriminator first)
//!
//! | Discriminator | Name | Data after the discriminator | Accounts |
//! |---|---|---|---|
//! | `8fbe5adac41e33de` ([`SWAP_DISC`]) | `swap_base_input` | `amount_in u64`, `minimum_amount_out u64` (24 bytes total) | the 13 Raydium accounts, in order (see `src/swap.rs`); extra trailing accounts are allowed |
//! | `FF 70 72 6F 78 79 00 00` ([`PROXY_DISC`]) | `proxy` | inner instruction data | `[program, ...rest]`, forwarded with their signer/writable flags |
//! | `FF 69 6E 69 74 00 00 00` ([`INIT_POOL_DISC`]) | `init_pool` | `mode u8`, `aux_key [u8;32]` | `[pool_state W, vault_0, vault_1]` |
//!
//! ## Pools
//!
//! `pool_state` is 104 bytes owned by this program (layout in [`pool`]). A LiteSVM test creates
//! one with `set_account(pool, Account { owner: MOCK_AMM_ID, data: PoolState{..}.encode(), .. })`
//! and funds two token accounts owned by the pool authority PDA
//! (`["mock_amm_auth"]`, [`POOL_AUTHORITY_SEED`]). On a cluster, create the account with System
//! `CreateAccount { owner: MOCK_AMM_ID, space: 104 }` and call `init_pool` in the same
//! transaction. Reserves are the live vault balances.
//!
//! ## Errors
//!
//! 7001 ExceededSlippage, 7002 InvalidPool, 7003 InvalidVault, 7004 ZeroAmount,
//! 7005 InvalidInstruction ([`MockAmmError`]). Token-program errors surface as the Token
//! program's own `Custom(n)`; read the failing program id in the logs.
//!
//! ## Modes
//!
//! See [`Mode`] for the 13 behaviours. The LiteSVM tests in `tests/modes.rs` are the
//! executable specification of each one against the real Token, p-token and Token-2022 binaries.
#![cfg_attr(target_os = "solana", no_std)]

mod cpi;
mod error;
mod init;
mod math;
mod mode;
pub mod pool;
mod proxy;
mod swap;

pub use error::MockAmmError;
pub use math::amount_out;
pub use mode::{Mode, MODE_COUNT};
pub use pool::{PoolState, POOL_AUTHORITY_BUMP, POOL_AUTHORITY_SEED, POOL_STATE_LEN};

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};
use pinocchio_pubkey::pubkey;

#[cfg(target_os = "solana")]
mod entry {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// Program id of the mock AMM (throwaway key, test/demo only).
pub const MOCK_AMM_ID: Pubkey = pubkey!("6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw");
/// AgentAuth core program id (used by mode `CpiVerify`).
pub const AGENT_AUTH_ID: Pubkey = pubkey!("AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if");
/// AgentAuth Relay program id (used by mode `ReenterRelay`).
pub const RELAY_ID: Pubkey = pubkey!("33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6");
/// SPL Token program id (classic and p-token).
pub const TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// SPL Token-2022 program id.
pub const TOKEN22_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Raydium CP-Swap `swap_base_input` discriminator: first 8 bytes of
/// `sha256("global:swap_base_input")`.
pub const SWAP_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];
/// `proxy` discriminator.
pub const PROXY_DISC: [u8; 8] = [0xFF, 0x70, 0x72, 0x6F, 0x78, 0x79, 0x00, 0x00];
/// `init_pool` discriminator.
pub const INIT_POOL_DISC: [u8; 8] = [0xFF, 0x69, 0x6E, 0x69, 0x74, 0x00, 0x00, 0x00];

/// Program entrypoint logic.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (disc, rest) = data
        .split_first_chunk::<8>()
        .ok_or(ProgramError::from(MockAmmError::InvalidInstruction))?;
    match *disc {
        SWAP_DISC => swap::swap(program_id, accounts, rest),
        PROXY_DISC => proxy::proxy(accounts, rest),
        INIT_POOL_DISC => init::init_pool(program_id, accounts, rest),
        _ => Err(MockAmmError::InvalidInstruction.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use solana_pubkey::Pubkey as HostPubkey;

    #[test]
    fn swap_disc_is_the_anchor_discriminator_of_swap_base_input() {
        let h = Sha256::digest(b"global:swap_base_input");
        assert_eq!(&h[..8], &SWAP_DISC);
    }

    #[test]
    fn discriminators_are_distinct() {
        assert_ne!(SWAP_DISC, PROXY_DISC);
        assert_ne!(SWAP_DISC, INIT_POOL_DISC);
        assert_ne!(PROXY_DISC, INIT_POOL_DISC);
        assert_eq!(&PROXY_DISC[1..6], b"proxy");
        assert_eq!(&INIT_POOL_DISC[1..5], b"init");
    }

    #[test]
    fn pool_authority_bump_is_canonical() {
        let id = HostPubkey::from(MOCK_AMM_ID);
        let (_, bump) = HostPubkey::find_program_address(&[POOL_AUTHORITY_SEED], &id);
        assert_eq!(bump, POOL_AUTHORITY_BUMP);
    }

    #[test]
    fn program_ids_decode_to_the_documented_keys() {
        assert_eq!(
            HostPubkey::from(MOCK_AMM_ID).to_string(),
            "6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw"
        );
        assert_eq!(
            HostPubkey::from(RELAY_ID).to_string(),
            "33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6"
        );
        assert_eq!(
            HostPubkey::from(AGENT_AUTH_ID).to_string(),
            "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
        );
        assert_eq!(
            HostPubkey::from(TOKEN_ID).to_string(),
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        );
        assert_eq!(
            HostPubkey::from(TOKEN22_ID).to_string(),
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        );
    }
}
