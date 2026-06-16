use crate::{constants::{MANDATE_DISCRIMINATOR}, state::Mandate};
use pinocchio::{ProgramResult, account_info::AccountInfo, pubkey::{Pubkey}
    };
use crate::MandateError;

// TODO(P4): owner-only; flip active to false so every later verify fails.
pub fn revoke_mandate(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {

    /*
    let [
        owner_account,
        mandate_pda,
    ] = accounts 
    else {
        return Err(MandateError::InvalidInstructionData.into());
    };
    */

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

    {        
        let mut mandate_data = mandate_pda.try_borrow_mut_data()?;

        if mandate_data.len() == 0 {
            return Err(MandateError::InvalidAccountType.into());
        }

        let mandate = Mandate::from_bytes(&mut mandate_data)?;
        if mandate.discriminator() != MANDATE_DISCRIMINATOR {
            return Err(MandateError::InvalidAccountType.into())
        }

        if !mandate.is_active() {
            return Err(MandateError::NotActive.into());
        };

        if owner_account.key() != mandate.owner() {
            return Err(MandateError::NotOwner.into());
        };
    }


    let lamports = mandate_pda.lamports();
    *owner_account.try_borrow_mut_lamports()? += lamports;
    *mandate_pda.try_borrow_mut_lamports()? = 0;


    {
        let mut mandate_data = mandate_pda.try_borrow_mut_data()?;
        mandate_data.fill(0);
    }


    let _ = mandate_pda.resize(0);
    unsafe {mandate_pda.assign(&pinocchio_system::ID)};


    Ok(())


}
