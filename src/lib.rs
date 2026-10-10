#![cfg_attr(target_os = "solana", no_std)]
// The only `unsafe` is what the pinocchio entrypoint macros expand to (`mod entry`).
#![deny(unsafe_code)]

mod constants;
mod error;
mod instructions;
pub mod state;

pub use constants::*;
pub use error::MandateError;

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use instructions::Instruction;

pinocchio_pubkey::declare_id!("AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if");

// The whole crate is no_std on-chain, so we wire up the entrypoint, bump
// allocator and panic handler by hand instead of the all-in-one `entrypoint!`
// (which expects std to supply the panic handler).
#[cfg(target_os = "solana")]
#[allow(unsafe_code)]
mod entry {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::from(MandateError::InvalidInstructionData))?;

    match Instruction::from_tag(*tag)? {
        Instruction::CreateMandate => instructions::create_mandate(program_id, accounts, data),
        Instruction::AddPermission => instructions::add_permission(program_id, accounts, data),
        Instruction::RemovePermission => {
            instructions::remove_permission(program_id, accounts, data)
        }
        Instruction::Verify => instructions::verify(program_id, accounts, data),
        Instruction::RevokeMandate => instructions::revoke_mandate(program_id, accounts, data),
        Instruction::SetActive => instructions::set_active(program_id, accounts, data),
        Instruction::UpdatePermission => {
            instructions::update_permission(program_id, accounts, data)
        }
    }
}
