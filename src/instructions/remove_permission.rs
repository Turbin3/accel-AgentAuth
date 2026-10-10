use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use super::{
    authorize_owner_accounts, expect_end, open_mandate, require_active, require_owner, take_pubkey,
};
use crate::error::MandateError;

/// Remove the whole permission slot of one target program (all of its
/// discriminators) by swap-remove: the last slot moves into the hole.
///
/// Accounts: `[owner (signer), mandate (writable)]`.
/// Data (after the tag): `program_id[32]`, nothing after.
///
/// The slot's spend history goes with it. Re-adding the program later starts
/// from zero; to change limits and keep the history use `update_permission`.
pub fn remove_permission(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [owner, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };

    let (target_program, rest) = take_pubkey(data)?;
    expect_end(rest)?;

    authorize_owner_accounts(program_id, owner, mandate_account)?;
    let mut account_data = mandate_account.try_borrow_mut_data()?;
    let mut mandate = open_mandate(&mut account_data)?;
    require_owner(&mandate, owner)?;
    require_active(&mandate)?;

    let index = mandate
        .find_permission(target_program)
        .ok_or(MandateError::PermissionNotFound)?;
    mandate.swap_remove_permission(index)?;
    Ok(())
}
