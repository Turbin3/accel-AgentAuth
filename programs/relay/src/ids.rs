//! Compiled-in program ids, discriminators, seeds and the AMM allowlist
//! (RELAY-SPEC section 4).
//!
//! The relay does not compile its own program id in: it uses the
//! `program_id` argument of the entrypoint.

use pinocchio::pubkey::Pubkey;
use pinocchio_pubkey::pubkey;

/// AgentAuth core program (`declare_id!` in the core crate).
pub const AGENT_AUTH_ID: Pubkey = pubkey!("AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if");
/// SPL Token (classic and p-token share this id).
pub const TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// SPL Token-2022.
pub const TOKEN22_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// System program.
pub const SYSTEM_ID: Pubkey = pubkey!("11111111111111111111111111111111");
/// Wrapped SOL mint. Rejected as `budget_mint` and `in_mint`.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Token-2022's own native mint (a different address from the classic one).
/// Rejected exactly like [`NATIVE_MINT`]: a native account's `amount` can be
/// changed by anyone through lamport donation plus `SyncNative`.
pub const NATIVE_MINT_2022: Pubkey = pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

/// Raydium CP-Swap on mainnet-beta.
pub const CPMM_MAINNET_ID: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/// Raydium CP-Swap on devnet.
pub const CPMM_DEVNET_ID: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
/// Mock AMM (test and demo only). Allowlisted solely by the `test-amm` feature.
pub const MOCK_AMM_ID: Pubkey = pubkey!("6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw");

/// Discriminator the relay reports to `verify` for an SPL `TransferChecked`:
/// the SPL tag byte (12) zero padded to 8 bytes. SPL instructions carry no
/// 8-byte discriminator, so this is a documented relay convention that the
/// owner sees in the mandate.
pub const TRANSFER_CHECKED_DISC: [u8; 8] = [12, 0, 0, 0, 0, 0, 0, 0];
/// First 8 bytes of `sha256("global:swap_base_input")` (Anchor rule), the
/// Raydium CP-Swap exact-in swap instruction.
pub const SWAP_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

/// Seed of the policy PDA (`["policy", mandate]`, owned by the relay).
pub const POLICY_SEED: &[u8] = b"policy";
/// Seed of the authority PDA (`["authority", mandate]`, the SPL delegate).
pub const AUTHORITY_SEED: &[u8] = b"authority";

/// Instruction tag of `init_policy`.
pub const TAG_INIT_POLICY: u8 = 0;
/// Instruction tag of `set_paused`.
pub const TAG_SET_PAUSED: u8 = 1;
/// Instruction tag of `close_policy`.
pub const TAG_CLOSE_POLICY: u8 = 2;
/// Instruction tag of `transfer`.
pub const TAG_TRANSFER: u8 = 3;
/// Instruction tag of `swap`.
pub const TAG_SWAP: u8 = 4;

/// AgentAuth `verify` instruction tag (locked ABI).
pub const VERIFY_TAG: u8 = 3;
/// SPL `TransferChecked` instruction tag (same for Token and Token-2022).
pub const SPL_TRANSFER_CHECKED_TAG: u8 = 12;

/// Is `key` an AMM program this build is willing to pin in a policy?
///
/// * default (`devnet`): Raydium CP-Swap devnet id;
/// * no feature (`--no-default-features`): Raydium CP-Swap mainnet id;
/// * `test-amm` additionally allows [`MOCK_AMM_ID`].
pub fn amm_allowed(key: &Pubkey) -> bool {
    #[cfg(feature = "devnet")]
    if key == &CPMM_DEVNET_ID {
        return true;
    }
    #[cfg(not(feature = "devnet"))]
    if key == &CPMM_MAINNET_ID {
        return true;
    }
    #[cfg(feature = "test-amm")]
    if key == &MOCK_AMM_ID {
        return true;
    }
    false
}

/// Is `key` the classic Token or the Token-2022 program?
pub fn is_token_program(key: &Pubkey) -> bool {
    key == &TOKEN_ID || key == &TOKEN22_ID
}

/// Is `key` one of the two native (wrapped SOL) mints?
pub fn is_native_mint(key: &Pubkey) -> bool {
    key == &NATIVE_MINT || key == &NATIVE_MINT_2022
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RT-F3: both wSOL mints are native; ordinary mints and the token program
    /// ids are not.
    #[test]
    fn native_mints_recognised() {
        assert!(is_native_mint(&NATIVE_MINT));
        assert!(is_native_mint(&NATIVE_MINT_2022));
        assert!(!is_native_mint(&TOKEN_ID));
        assert!(!is_native_mint(&TOKEN22_ID));
        assert!(!is_native_mint(&[0u8; 32]));
    }
}
