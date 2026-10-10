//! Instruction handlers and the pieces they share.
//!
//! Every handler follows the same shape: destructure the accounts, parse the
//! instruction data completely (exact length, no trailing bytes), authorise,
//! then touch state. See `error.rs` for the order of checks and the code each
//! one maps to.

mod add_permission;
mod create_mandate;
mod remove_permission;
mod revoke_mandate;
mod set_active;
mod update_permission;
mod verify;

pub use add_permission::add_permission;
pub use create_mandate::create_mandate;
pub use remove_permission::remove_permission;
pub use revoke_mandate::revoke_mandate;
pub use set_active::set_active;
pub use update_permission::update_permission;
pub use verify::verify;

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::constants::MANDATE_DISCRIMINATOR;
use crate::error::MandateError;
use crate::state::Mandate;

/// First byte of the instruction data selects the handler.
#[derive(Debug, PartialEq, Eq)]
pub enum Instruction {
    CreateMandate,
    AddPermission,
    RemovePermission,
    Verify,
    RevokeMandate,
    SetActive,
    UpdatePermission,
}

impl Instruction {
    pub fn from_tag(tag: u8) -> Result<Self, MandateError> {
        match tag {
            0 => Ok(Instruction::CreateMandate),
            1 => Ok(Instruction::AddPermission),
            2 => Ok(Instruction::RemovePermission),
            3 => Ok(Instruction::Verify),
            4 => Ok(Instruction::RevokeMandate),
            5 => Ok(Instruction::SetActive),
            6 => Ok(Instruction::UpdatePermission),
            _ => Err(MandateError::InvalidDiscriminator),
        }
    }
}

// --- data parsing ---------------------------------------------------------

/// Split a little-endian `u64` off the front of `data`.
pub(crate) fn take_u64(data: &[u8]) -> Result<(u64, &[u8]), ProgramError> {
    let (bytes, rest) = data
        .split_first_chunk::<8>()
        .ok_or(MandateError::InvalidInstructionData)?;
    Ok((u64::from_le_bytes(*bytes), rest))
}

/// Split a 32-byte key off the front of `data`.
pub(crate) fn take_pubkey(data: &[u8]) -> Result<(&Pubkey, &[u8]), ProgramError> {
    data.split_first_chunk::<32>()
        .ok_or_else(|| MandateError::InvalidInstructionData.into())
}

/// Succeed only if every byte of the instruction data was consumed.
pub(crate) fn expect_end(rest: &[u8]) -> ProgramResult {
    if rest.is_empty() {
        Ok(())
    } else {
        Err(MandateError::InvalidInstructionData.into())
    }
}

// --- authorisation shared by the owner-signed mutators ---------------------

/// The owner must have signed and the mandate must be a writable account owned
/// by this program. Does not look at the mandate's contents.
pub(crate) fn authorize_owner_accounts(
    program_id: &Pubkey,
    owner: &AccountInfo,
    mandate: &AccountInfo,
) -> ProgramResult {
    if !owner.is_signer() {
        return Err(MandateError::InvalidSigner.into());
    }
    if !mandate.is_owned_by(program_id) {
        return Err(MandateError::AccountOwnerMismatch.into());
    }
    if !mandate.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Wrap the account data as an initialised mandate (size and discriminator).
pub(crate) fn open_mandate(data: &mut [u8]) -> Result<Mandate<'_>, MandateError> {
    let mandate = Mandate::from_bytes(data)?;
    if mandate.discriminator() != MANDATE_DISCRIMINATOR {
        return Err(MandateError::InvalidAccountType);
    }
    Ok(mandate)
}

/// The signer must be the owner recorded in the mandate.
pub(crate) fn require_owner(mandate: &Mandate, owner: &AccountInfo) -> ProgramResult {
    if owner.key().as_ref() != mandate.owner() {
        return Err(MandateError::NotOwner.into());
    }
    Ok(())
}

/// Mutators other than `set_active` refuse to touch a paused mandate.
pub(crate) fn require_active(mandate: &Mandate) -> ProgramResult {
    if !mandate.is_active() {
        return Err(MandateError::NotActive.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_routes_each_tag() {
        assert_eq!(Instruction::from_tag(0), Ok(Instruction::CreateMandate));
        assert_eq!(Instruction::from_tag(1), Ok(Instruction::AddPermission));
        assert_eq!(Instruction::from_tag(2), Ok(Instruction::RemovePermission));
        assert_eq!(Instruction::from_tag(3), Ok(Instruction::Verify));
        assert_eq!(Instruction::from_tag(4), Ok(Instruction::RevokeMandate));
        assert_eq!(Instruction::from_tag(5), Ok(Instruction::SetActive));
        assert_eq!(Instruction::from_tag(6), Ok(Instruction::UpdatePermission));
        assert_eq!(
            Instruction::from_tag(7),
            Err(MandateError::InvalidDiscriminator)
        );
        assert_eq!(
            Instruction::from_tag(255),
            Err(MandateError::InvalidDiscriminator)
        );
    }

    #[test]
    fn data_parsers_reject_short_and_trailing_input() {
        assert!(take_u64(&[0; 7]).is_err());
        let (v, rest) = take_u64(&[1, 0, 0, 0, 0, 0, 0, 0, 9]).unwrap();
        assert_eq!((v, rest), (1, &[9u8][..]));
        assert!(take_pubkey(&[0; 31]).is_err());
        assert!(take_pubkey(&[0; 32]).is_ok());
        assert!(expect_end(&[]).is_ok());
        assert!(expect_end(&[0]).is_err());
    }
}
