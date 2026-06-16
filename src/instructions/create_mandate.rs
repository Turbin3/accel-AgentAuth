use crate::{ACCOUNT_SIZE, constants::{MANDATE_DISCRIMINATOR, MANDATE_SEED, OFF_ACTIVE, OFF_AGENT, OFF_DISC, OFF_EXPIRY, OFF_OWNER, OFF_PERM_LEN}};
use pinocchio::{ProgramResult, account_info::AccountInfo, program_error::ProgramError, pubkey::{Pubkey, find_program_address},
     sysvars::{Sysvar, rent::Rent}
    };
use pinocchio_system::instructions::CreateAccount;
use pinocchio::instruction::{Seed, Signer};

use crate::MandateError;

// TODO(P3): create + init the mandate PDA, write owner/agent/expiry, mark active.
pub fn create_mandate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

    if accounts.len() < 3 {
        return Err(MandateError::InvalidInstructionData.into());
    }
    let owner_account = &accounts[0];
    let agent_account = &accounts[1];
    let mandate_pda = &accounts[2];


    if !owner_account.is_signer() {
        return Err(MandateError::PermissionNotFound.into())
    }

    let (expected_pda, bump) = find_program_address(
        &[
            MANDATE_SEED,
            owner_account.key().as_ref(),
            agent_account.key().as_ref(),
        ],
        program_id,
    );
    if expected_pda != *mandate_pda.key() {
        return Err(ProgramError::InvalidAccountData)
    }

    let mut mandate_data = mandate_pda.try_borrow_mut_data()?;

    /*
    let mandate = Mandate::from_bytes(&mut mandate_data)?;
    if mandate.discriminator() == MANDATE_DISCRIMINATOR {
        return Err(MandateError::AlreadyInitialized.into())
    }
    */
    if mandate_data[OFF_DISC] == MANDATE_DISCRIMINATOR {
        return Err(MandateError::AlreadyInitialized.into())
    }

    if data.len() < 8 {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let expiry = unsafe { *(data.as_ptr() as *const &[u8; 8]) };

    let bump_arr = [bump];
    let signer_seeds = [
        Seed::from(MANDATE_SEED),
        Seed::from(owner_account.key().as_ref()),
        Seed::from(agent_account.key().as_ref()),
        Seed::from(&bump_arr),
    ];

    let signer = Signer::from(&signer_seeds);


    let rent = Rent::get()?.minimum_balance(ACCOUNT_SIZE);

    CreateAccount {
        from: owner_account,
        to: mandate_pda,
        lamports: rent,
        space: ACCOUNT_SIZE as u64,
        owner: program_id
    }
    .invoke_signed(&[signer])?;


    mandate_data[OFF_DISC] = MANDATE_DISCRIMINATOR;
    mandate_data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(owner_account.key().as_ref());
    mandate_data[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(agent_account.key().as_ref());
    mandate_data[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(expiry);
    mandate_data[OFF_ACTIVE] = 1;
    
    mandate_data[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&0u16.to_le_bytes());

    Ok(())

}
