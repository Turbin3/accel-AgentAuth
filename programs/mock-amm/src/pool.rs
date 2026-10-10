//! `pool_state` account layout (104 bytes) and the pool authority PDA.
//!
//! ```text
//! [0]       mode      u8     0..=12, see `Mode`
//! [1..8)    zero
//! [8..40)   vault_0   pubkey token account holding one side of the pool
//! [40..72)  vault_1   pubkey token account holding the other side
//! [72..104) aux_key   pubkey attacker key / mandate key, used by some modes
//! ```
//!
//! Reserves are the live balances of the two vault token accounts (`data[64..72]` of each).
//! A pool is created in tests by `set_account` with exactly these bytes (owner = the mock AMM
//! program id), or on a cluster with the `init_pool` instruction.

use crate::error::MockAmmError;
use crate::mode::Mode;
use pinocchio::program_error::ProgramError;
use pinocchio::pubkey::Pubkey;

/// Length of the `pool_state` account data.
pub const POOL_STATE_LEN: usize = 104;
/// Offset of the mode byte.
pub const OFF_MODE: usize = 0;
/// Offset of `vault_0`.
pub const OFF_VAULT_0: usize = 8;
/// Offset of `vault_1`.
pub const OFF_VAULT_1: usize = 40;
/// Offset of `aux_key`.
pub const OFF_AUX_KEY: usize = 72;

/// Seed of the pool authority PDA (the owner of both vaults).
pub const POOL_AUTHORITY_SEED: &[u8] = b"mock_amm_auth";
/// Canonical bump of `["mock_amm_auth"]` under `MOCK_AMM_ID` (asserted by a unit test).
pub const POOL_AUTHORITY_BUMP: u8 = 255;

/// Decoded `pool_state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub mode: Mode,
    pub vault_0: Pubkey,
    pub vault_1: Pubkey,
    pub aux_key: Pubkey,
}

impl PoolState {
    /// Strict decode: exact length, known mode, reserved bytes zero. All failures are `InvalidPool`.
    pub fn parse(data: &[u8]) -> Result<PoolState, ProgramError> {
        if data.len() != POOL_STATE_LEN {
            return Err(MockAmmError::InvalidPool.into());
        }
        let mode = Mode::from_u8(data[OFF_MODE]).ok_or(MockAmmError::InvalidPool)?;
        if data[1..OFF_VAULT_0].iter().any(|b| *b != 0) {
            return Err(MockAmmError::InvalidPool.into());
        }
        Ok(PoolState {
            mode,
            vault_0: key_at(data, OFF_VAULT_0)?,
            vault_1: key_at(data, OFF_VAULT_1)?,
            aux_key: key_at(data, OFF_AUX_KEY)?,
        })
    }

    /// Serialise to the exact on-chain bytes.
    pub fn encode(&self) -> [u8; POOL_STATE_LEN] {
        let mut out = [0u8; POOL_STATE_LEN];
        out[OFF_MODE] = self.mode as u8;
        out[OFF_VAULT_0..OFF_VAULT_0 + 32].copy_from_slice(&self.vault_0);
        out[OFF_VAULT_1..OFF_VAULT_1 + 32].copy_from_slice(&self.vault_1);
        out[OFF_AUX_KEY..OFF_AUX_KEY + 32].copy_from_slice(&self.aux_key);
        out
    }
}

pub(crate) fn key_at(data: &[u8], off: usize) -> Result<Pubkey, ProgramError> {
    data.get(off..off + 32)
        .and_then(|s| <[u8; 32]>::try_from(s).ok())
        .ok_or_else(|| MockAmmError::InvalidPool.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(mode: Mode) -> PoolState {
        PoolState {
            mode,
            vault_0: [1; 32],
            vault_1: [2; 32],
            aux_key: [3; 32],
        }
    }

    #[test]
    fn encode_parse_round_trip_for_every_mode() {
        for b in 0..crate::mode::MODE_COUNT {
            let p = sample(Mode::from_u8(b).unwrap());
            assert_eq!(PoolState::parse(&p.encode()).unwrap(), p);
        }
    }

    #[test]
    fn layout_offsets_are_exact() {
        let bytes = sample(Mode::Underpay).encode();
        assert_eq!(bytes.len(), 104);
        assert_eq!(bytes[0], 10);
        assert_eq!(&bytes[1..8], &[0u8; 7]);
        assert_eq!(&bytes[8..40], &[1u8; 32]);
        assert_eq!(&bytes[40..72], &[2u8; 32]);
        assert_eq!(&bytes[72..104], &[3u8; 32]);
    }

    #[test]
    fn rejects_wrong_length() {
        let bytes = sample(Mode::Normal).encode();
        assert!(PoolState::parse(&bytes[..103]).is_err());
        let mut long = bytes.to_vec();
        long.push(0);
        assert!(PoolState::parse(&long).is_err());
        assert!(PoolState::parse(&[]).is_err());
    }

    #[test]
    fn rejects_unknown_mode_and_dirty_reserved_bytes() {
        let mut bytes = sample(Mode::Normal).encode();
        bytes[0] = 13;
        assert!(PoolState::parse(&bytes).is_err());
        let mut bytes = sample(Mode::Normal).encode();
        bytes[7] = 1;
        assert!(PoolState::parse(&bytes).is_err());
    }
}
