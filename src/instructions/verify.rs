use crate::error::MandateError;
use crate::state::Mandate;
use crate::constants::{MANDATE_DISCRIMINATOR, MAN}
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

// TODO(P2): the hot path. Check active + not expired, match program + discriminator,
// enforce per-tx and total spend limits, then bump counters. ~49-byte ABI.
pub fn verify(program_id: &Pubkey, accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {

    // Parse Instruction data
    let [] = instruction_data
        else {
            Err(MandateError::InvalidInstructionData.into())
        }
}
