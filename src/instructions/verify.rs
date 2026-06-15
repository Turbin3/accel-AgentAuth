use crate::error::MandateError;
use crate::state::Mandate;
use crate::constants::{MANDATE_DISCRIMINATOR, MANDATE_SEED}
use pinocchio::pubkey::find_program_address;
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

// TODO(P2): the hot path. Check active + not expired, match program + discriminator,
// enforce per-tx and total spend limits, then bump counters. ~49-byte ABI.
pub fn verify(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {

    // Parse Instruction data
    if data.len() != 48{
        return Err(MandateError::InvalidInstructionData.into())
    }

    let ptr = data.as_ptr();
    let target_program_id: &[u8; 32] = unsafe {*(ptr as *const &[u8; 32])};
    let target_ix_disc: &[u8; 8]= unsafe {*(ptr.add(32) as *const &[u8; 8])};
    let amount_bytes: [u8; 8] = unsafe {*(ptr.add(40) as *const [u8; 8])};
    let amount = u64::from_le_bytes(amount_bytes);

    // Parse accounts
    let mandate_account = &accounts[0];
    let owner_account = &accounts[1];
    let agent_account = &accounts[2];

    //validate accounts
    let (expected_pda, _bump) = find_program_address(
        &[MANDATE_SEED, owner_account.key().as_ref(), agent_account.key().as_ref()],
        program_id
    );

    if mandate_account.key() != &expected_pda {
        return Err(ProgramError::InvalidAccountData);
    };

    let mut mandate_acc_data = mandate_account
            .try_borrow_mut_data()
            .map_err(|_| ProgramError::AccountBorrowFailed)?;
    let mut mandate = Mandate::from_bytes(&mut mandate_acc_data)?;

}
