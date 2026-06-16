use crate::{constants::{MANDATE_DISCRIMINATOR}, state::Mandate};
use pinocchio::{ProgramResult, account_info::AccountInfo, pubkey::{Pubkey}
    };
use crate::MandateError;

// TODO(P4): owner-only; find the permission for a program and swap-remove it.
pub fn remove_permission(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

    let [
        owner_account,
        mandate_pda,
    ] = accounts 
    else {
        return Err(MandateError::InvalidInstructionData.into());
    };

    if !owner_account.is_signer() {
        return Err(MandateError::PermissionNotFound.into())
    }

    if mandate_pda.owner() != program_id {
        return Err(MandateError::InvalidAccountType.into());
    }

    let mut mandate_data = mandate_pda.try_borrow_mut_data()?;

    let mut mandate = Mandate::from_bytes(&mut mandate_data)?;
    if mandate.discriminator() != MANDATE_DISCRIMINATOR {
        return Err(MandateError::InvalidAccountType.into())
    }

    if !mandate.is_active() {
        return Err(MandateError::NotActive.into());
    };

    if owner_account.key() != mandate.owner() {
        return Err(MandateError::NotOwner.into());
    };


    if data.len() < 32 {
        return Err(MandateError::InvalidInstructionData.into());
    }


    let target_program = unsafe { &(data.as_ptr() as *const [u8; 32]).read_unaligned() };


    let permission = mandate.find_permission(target_program).ok_or(MandateError::PermissionNotFound)?;

    let _ = mandate.swap_remove_permission(permission);


    Ok(())

}
