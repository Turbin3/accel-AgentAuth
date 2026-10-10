//! Zero-copy, read-only view over the header of an AgentAuth mandate account.
//!
//! Layout (locked by the core program, 2136 bytes in total):
//!
//! | offset | field | type |
//! |---|---|---|
//! | 0 | discriminator (`1` once initialised) | `u8` |
//! | 1 | owner | `[u8; 32]` |
//! | 33 | agent | `[u8; 32]` |
//! | 65 | expiry (unix seconds) | `i64` LE |
//! | 73 | active | `u8` (`1` = active) |
//!
//! [`MandateHeader::parse`] only succeeds for an account that is owned by
//! [`crate::AGENT_AUTH_ID`], has the exact size and carries discriminator `1`,
//! so a header you hold is never read from a look-alike account.
//!
//! ```no_run
//! # use pinocchio::account_info::AccountInfo;
//! # fn f(mandate: &AccountInfo, expected_owner: &[u8; 32]) -> Result<(), pinocchio::program_error::ProgramError> {
//! use agent_auth_cpi::MandateHeader;
//! let data = mandate.try_borrow_data()?;
//! let m = MandateHeader::parse(mandate.owner(), &data)?;
//! if m.owner() != expected_owner || !m.active() {
//!     return Err(pinocchio::program_error::ProgramError::InvalidAccountData);
//! }
//! # Ok(()) }
//! ```

use pinocchio::pubkey::Pubkey;

use crate::{
    CpiError, AGENT_AUTH_ID, MANDATE_ACCOUNT_SIZE, MANDATE_DISCRIMINATOR, OFF_ACTIVE, OFF_AGENT,
    OFF_DISC, OFF_EXPIRY, OFF_OWNER,
};

/// Borrow a 32-byte key at a fixed offset. The offsets are constants inside a
/// fixed-size array, so the bounds are known at compile time.
fn key_at(data: &[u8; MANDATE_ACCOUNT_SIZE], off: usize) -> &Pubkey {
    match data[off..].first_chunk::<32>() {
        Some(key) => key,
        None => unreachable!(),
    }
}

/// A validated read-only view over a mandate account's data.
#[derive(Clone, Copy)]
pub struct MandateHeader<'a> {
    data: &'a [u8; MANDATE_ACCOUNT_SIZE],
}

impl<'a> MandateHeader<'a> {
    /// Validate and wrap the data of a mandate account.
    ///
    /// `account_owner` must be the runtime owner of the account (pass
    /// `account.owner()`); `data` is its data. Fails unless the account is owned
    /// by [`AGENT_AUTH_ID`], is exactly [`MANDATE_ACCOUNT_SIZE`] bytes and has the
    /// mandate discriminator.
    pub fn parse(account_owner: &Pubkey, data: &'a [u8]) -> Result<Self, CpiError> {
        if account_owner != &AGENT_AUTH_ID {
            return Err(CpiError::MandateNotOwnedByAgentAuth);
        }
        Self::parse_unowned_checked(data)
    }

    /// Size and discriminator checks only (the caller already verified ownership).
    pub(crate) fn parse_unowned_checked(data: &'a [u8]) -> Result<Self, CpiError> {
        let data: &[u8; MANDATE_ACCOUNT_SIZE] =
            data.try_into().map_err(|_| CpiError::MandateBadSize)?;
        if data[OFF_DISC] != MANDATE_DISCRIMINATOR {
            return Err(CpiError::MandateBadDiscriminator);
        }
        Ok(Self { data })
    }

    /// Who created the mandate and owns the authority it delegates.
    pub fn owner(&self) -> &'a Pubkey {
        key_at(self.data, OFF_OWNER)
    }

    /// The only key allowed to act under this mandate.
    pub fn agent(&self) -> &'a Pubkey {
        key_at(self.data, OFF_AGENT)
    }

    /// Expiry as unix seconds. The core treats the mandate as expired when
    /// `now > expiry`.
    pub fn expiry(&self) -> i64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[OFF_EXPIRY..OFF_EXPIRY + 8]);
        i64::from_le_bytes(b)
    }

    /// `true` while the active flag is set.
    pub fn active(&self) -> bool {
        self.data[OFF_ACTIVE] == 1
    }

    /// `true` once `now` (unix seconds, e.g. from the Clock sysvar) is past expiry.
    pub fn is_expired(&self, now: i64) -> bool {
        now > self.expiry()
    }

    /// Succeeds only if `mandate.owner == expected`.
    pub fn require_owner(&self, expected: &Pubkey) -> Result<(), CpiError> {
        if self.owner() == expected {
            Ok(())
        } else {
            Err(CpiError::OwnerMismatch)
        }
    }

    /// Succeeds only if `mandate.agent == expected`.
    pub fn require_agent(&self, expected: &Pubkey) -> Result<(), CpiError> {
        if self.agent() == expected {
            Ok(())
        } else {
            Err(CpiError::AgentMismatch)
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec;

    fn blob() -> std::vec::Vec<u8> {
        let mut d = vec![0u8; MANDATE_ACCOUNT_SIZE];
        d[OFF_DISC] = MANDATE_DISCRIMINATOR;
        d[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(&[7; 32]);
        d[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(&[9; 32]);
        d[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&(-5i64).to_le_bytes());
        d[OFF_ACTIVE] = 1;
        d
    }

    #[test]
    fn reads_fields() {
        let d = blob();
        let m = MandateHeader::parse(&AGENT_AUTH_ID, &d).unwrap();
        assert_eq!(m.owner(), &[7; 32]);
        assert_eq!(m.agent(), &[9; 32]);
        assert_eq!(m.expiry(), -5);
        assert!(m.active());
        assert!(m.is_expired(-4));
        assert!(!m.is_expired(-5));
        assert_eq!(m.require_owner(&[7; 32]), Ok(()));
        assert_eq!(m.require_owner(&[8; 32]), Err(CpiError::OwnerMismatch));
        assert_eq!(m.require_agent(&[9; 32]), Ok(()));
        assert_eq!(m.require_agent(&[8; 32]), Err(CpiError::AgentMismatch));
    }

    #[test]
    fn rejects_foreign_owner_size_and_disc() {
        let d = blob();
        assert_eq!(
            MandateHeader::parse(&[1; 32], &d).err(),
            Some(CpiError::MandateNotOwnedByAgentAuth)
        );
        assert_eq!(
            MandateHeader::parse(&AGENT_AUTH_ID, &d[..2135]).err(),
            Some(CpiError::MandateBadSize)
        );
        let mut long = d.clone();
        long.push(0);
        assert_eq!(
            MandateHeader::parse(&AGENT_AUTH_ID, &long).err(),
            Some(CpiError::MandateBadSize)
        );
        let mut bad = d;
        bad[OFF_DISC] = 0;
        assert_eq!(
            MandateHeader::parse(&AGENT_AUTH_ID, &bad).err(),
            Some(CpiError::MandateBadDiscriminator)
        );
    }

    #[test]
    fn inactive_flag() {
        let mut d = blob();
        d[OFF_ACTIVE] = 0;
        assert!(!MandateHeader::parse(&AGENT_AUTH_ID, &d).unwrap().active());
    }
}
