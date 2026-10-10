use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use super::{
    authorize_owner_accounts, open_mandate, require_active, require_owner, take_pubkey, take_u64,
};
use crate::constants::MAX_DISCRIMINATORS;
use crate::error::MandateError;

/// Append a permission slot for one target program.
///
/// Accounts: `[owner (signer), mandate (writable)]`.
/// Data (after the tag): `program_id[32] | spend_limit u64 | per_tx_limit u64 |
/// disc_len u8 | discriminators[8 * disc_len]`, nothing after.
///
/// `spend_limit == 0` and `per_tx_limit == 0` mean **unlimited**, not "spend
/// nothing". At least one discriminator is required; an empty allow-list would
/// deny every call. One slot per program id: use `update_permission` to change
/// the limits of an existing slot.
pub fn add_permission(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [owner, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };

    let (target_program, rest) = take_pubkey(data)?;
    let (spend_limit, rest) = take_u64(rest)?;
    let (per_tx_limit, rest) = take_u64(rest)?;
    let (&disc_len, disc_bytes) = rest
        .split_first()
        .ok_or(MandateError::InvalidInstructionData)?;
    let (discriminators, trailing) = disc_bytes.as_chunks::<8>();
    if discriminators.len() != disc_len as usize || !trailing.is_empty() {
        return Err(MandateError::InvalidInstructionData.into());
    }

    authorize_owner_accounts(program_id, owner, mandate_account)?;
    let mut account_data = mandate_account.try_borrow_mut_data()?;
    let mut mandate = open_mandate(&mut account_data)?;
    require_owner(&mandate, owner)?;
    require_active(&mandate)?;

    if discriminators.is_empty() {
        return Err(MandateError::EmptyDiscriminators.into());
    }
    if discriminators.len() > MAX_DISCRIMINATORS {
        return Err(MandateError::TooManyDiscriminators.into());
    }
    if mandate.find_permission(target_program).is_some() {
        return Err(MandateError::DuplicatePermission.into());
    }

    // Fails with PermissionsFull when all 16 slots are in use.
    mandate.append_permission(target_program, spend_limit, per_tx_limit, discriminators)?;
    Ok(())
}
