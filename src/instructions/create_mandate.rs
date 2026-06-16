use std::borrow::Cow::Owned;
use crate::{constants::{MANDATE_DISCRIMINATOR, MANDATE_SEED}, state::Mandate};
use pinocchio::{ProgramResult, cpi::{Seed, Signer}, account_info::AccountInfo, instruction::Signer, program_error::ProgramError, pubkey::{Pubkey, find_program_address}};

use crate::MandateError;

// TODO(P3): create + init the mandate PDA, write owner/agent/expiry, mark active.
pub fn create_mandate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

    let [
        owner_account,
        agent_account,
        mandate_pda,
        system_program
    ] = accounts 
    else {
        return Err(MandateError::InvalidInstructionData.into());
    };

    if !owner_account.is_signer() {
        return Err(MandateError::PermissionNotFound.into())
    }

    let (expected_pda, _bump) = find_program_address(
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

    let mandate = Mandate::from_bytes(&mut mandate_data)?;
    if mandate.discriminator() == MANDATE_DISCRIMINATOR {
        return Err(MandateError::AlreadyInitialized.into())
    }


    if data.len() < 8 {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let expiry = unsafe { (data.as_ptr() as *const i64).read_unaligned() };


    let signer_seeds = [
        Seed::from(MANDATE_SEED),
        Seed::from(owner_account.key().as_ref()),
        Seed::from(agent_account.key().as_ref()),
        Seed::from(bump_bytes.as_ref()),
    ];
    let signer = Signer::from(&signer_seeds);


    unimplemented!("create_mandate: P3")
}
