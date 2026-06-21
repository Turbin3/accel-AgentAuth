use crate::{constants::{MANDATE_DISCRIMINATOR, MAX_DISCRIMINATORS, MAX_PERMISSIONS}, state::Mandate};
use pinocchio::{ProgramResult, account_info::AccountInfo, pubkey::{Pubkey}, program_error::ProgramError
    };
use crate::MandateError;

// TODO(P3): owner-only; append a permission slot for a target program + limits.
pub fn add_permission(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

    if accounts.len() < 2 {
        return Err(MandateError::InvalidInstructionData.into());
    }
    let owner_account = &accounts[0];
    let mandate_pda = &accounts[1];

    if !owner_account.is_signer() {
        return Err(MandateError::PermissionNotFound.into())
    }

    if mandate_pda.owner() != program_id {
        return Err(MandateError::InvalidAccountType.into());
    }

    if !mandate_pda.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut mandate_data = mandate_pda.try_borrow_mut_data()?;

    let mut mandate = Mandate::from_bytes(&mut mandate_data)?;
    if mandate.discriminator() != MANDATE_DISCRIMINATOR {
        return Err(MandateError::InvalidAccountType.into())
    }

    if !mandate.is_active() {
        return Err(MandateError::NotActive.into());
    };

    if owner_account.key().as_ref() != mandate.owner() {
        return Err(MandateError::NotOwner.into());
    };


    if data.len() < 49 {
        return Err(MandateError::InvalidInstructionData.into());
    }


    let target_program = unsafe { &(data.as_ptr() as *const [u8; 32]).read_unaligned() };
    let spend_limit = unsafe { (data.as_ptr().add(32) as *const u64).read_unaligned() };
    let per_tx_limit = unsafe { (data.as_ptr().add(40) as *const u64).read_unaligned() };
    let disc_len = data[48] as usize;


    if disc_len > MAX_DISCRIMINATORS {
        return Err(MandateError::TooManyDiscriminators.into());
    }

    let expected_len = 49 + (disc_len * 8);
    if data.len() < expected_len {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let discriminator = unsafe {
        core::slice::from_raw_parts(
            data.as_ptr().add(49) as *const [u8; 8],
            disc_len
        )
    };

    let current_len = mandate.permissions_len();

    if current_len >= MAX_PERMISSIONS {
        return Err(MandateError::PermissionsFull.into());
    }

    //let mandate_bool = mandate.find_permission(&target_program);

    if mandate.find_permission(target_program).is_some() {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let _ = mandate.append_permission(target_program, spend_limit, per_tx_limit, discriminator);

    Ok(())

}
