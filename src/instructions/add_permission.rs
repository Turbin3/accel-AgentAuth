use crate::{constants::{MANDATE_DISCRIMINATOR, MAX_DISCRIMINATORS, MAX_PERMISSIONS}, state::Mandate};
use pinocchio::{ProgramResult, account_info::AccountInfo, pubkey::{Pubkey}
    };
use crate::MandateError;

// TODO(P3): owner-only; append a permission slot for a target program + limits.
pub fn add_permission(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

        let [
        owner_account,
        mandate_pda,
        _system_program
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


    if data.len() < 49 {
        return Err(MandateError::InvalidInstructionData.into());
    }


    let target_program = unsafe { &(data.as_ptr() as *const [u8; 32]).read_unaligned() };
    let spend_limit = unsafe { (data.as_ptr().add(32) as *const u64).read_unaligned() };
    let per_tx_limit = unsafe { (data.as_ptr().add(40) as *const u64).read_unaligned() };
    //let discriminator: &[[u8; 8]] = unsafe { &(data.as_ptr().add(48) as *const [[u8; 8]]).read_unaligned() };
    let disc_len = data[48];


    if disc_len > MAX_DISCRIMINATORS as u8 {
        return Err(MandateError::TooManyDiscriminators.into());
    }

    let expected_len = 49 + (disc_len as usize * 8);
    if data.len() < expected_len {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let discriminator: &[[u8; 8]] = unsafe {
        core::slice::from_raw_parts(
            data.as_ptr().add(49) as *const [u8; 8],
            disc_len as usize
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

    let next_len = (current_len as u16)
        .checked_add(1)
        .ok_or(MandateError::ArithmeticOverflow)?;

    mandate.set_permissions_len(next_len as usize);

    Ok(())

}
