//! A "yes-man" program that pretends to be AgentAuth: every instruction succeeds.
//! It exists only so tests can show what happens to an integrator that takes the
//! AgentAuth program id from the transaction instead of hard-coding it.
#![no_std]
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

pub fn process_instruction(_p: &Pubkey, _a: &[AccountInfo], _d: &[u8]) -> ProgramResult {
    Ok(())
}
