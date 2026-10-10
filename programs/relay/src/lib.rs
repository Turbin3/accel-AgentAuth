//! # AgentAuth Relay
//!
//! A Pinocchio program that turns the AgentAuth core `verify` check into a
//! *binding* precondition for exactly two typed actions, plus the owner-side
//! policy lifecycle. The contract is `RELAY-SPEC.md` (v0.1) and
//! `idl/relay-idl.json`.
//!
//! | tag | instruction | handler | spec |
//! |---|---|---|---|
//! | 0 | `init_policy` | [`ix::init_policy`] | section 7.1 |
//! | 1 | `set_paused` | [`ix::set_paused`] | section 7.2 |
//! | 2 | `close_policy` | [`ix::close_policy`] | section 7.3 |
//! | 3 | `transfer` | [`ix::transfer`] | section 7.4 |
//! | 4 | `swap` | [`ix::swap`] | section 7.5 |
//!
//! Shared validation routines (spec section 6) are in [`checks`] and
//! [`token`]; layouts in [`state`]; errors 100..=119 in [`error`]; events in
//! [`events`]; the `verify` and `TransferChecked` CPIs in [`cpi`].
//!
//! Hard-enforcement scope: only `transfer` (SPL `TransferChecked`) and the
//! single pinned `swap` are enforced by this program. Unaudited prototype.
//!
//! ## Code standards
//!
//! * `no_std` on-chain; no `unwrap`/`expect`/indexing/panic reachable from
//!   untrusted input (enforced by the `deny` lints below).
//! * The only `unsafe` is the entrypoint/allocator/panic-handler macros and one
//!   parameterless syscall (`sol_get_stack_height`), each justified where used.
//! * Every data borrow is dropped before every CPI.
//! * Handlers are split into `#[inline(never)]` helpers to keep each SBF stack
//!   frame well below 4096 bytes.

#![cfg_attr(target_os = "solana", no_std)]
#![deny(unsafe_code, missing_docs)]
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

pub mod bytes;
pub mod checks;
pub mod cpi;
pub mod error;
pub mod events;
pub mod ids;
pub mod ix;
pub mod math;
pub mod state;
pub mod token;

pub use error::RelayError;

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use ids::{TAG_CLOSE_POLICY, TAG_INIT_POLICY, TAG_SET_PAUSED, TAG_SWAP, TAG_TRANSFER};

// The entrypoint, bump allocator and panic handler are wired by hand because the
// crate is `no_std` on-chain. The macros expand to `unsafe` (raw input buffer
// deserialization, global allocator, `#[panic_handler]`); that is the only
// `unsafe` besides the stack-height syscall.
//
// The account bound is 20, not the default 254: it shrinks the entrypoint's
// stack array, and because any extra accounts beyond 20 are ignored, 20 (one
// above the largest instruction, `swap` with 19) still lets the exact-count
// destructuring in every handler reject an over-long account list.
#[cfg(target_os = "solana")]
#[allow(unsafe_code, missing_docs)]
mod entry {
    pinocchio::program_entrypoint!(crate::process_instruction, 20);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// Program entrypoint logic: dispatch on the 1-byte tag. An empty or unknown
/// tag is `InvalidInstructionData` (100). Each handler receives the full
/// instruction data (tag included) and validates its own length.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let tag = *instruction_data
        .first()
        .ok_or(ProgramError::from(RelayError::InvalidInstructionData))?;
    match tag {
        TAG_INIT_POLICY => ix::init_policy::init_policy(program_id, accounts, instruction_data),
        TAG_SET_PAUSED => ix::set_paused::set_paused(program_id, accounts, instruction_data),
        TAG_CLOSE_POLICY => ix::close_policy::close_policy(program_id, accounts, instruction_data),
        TAG_TRANSFER => ix::transfer::transfer(program_id, accounts, instruction_data),
        TAG_SWAP => ix::swap::swap(program_id, accounts, instruction_data),
        _ => Err(RelayError::InvalidInstructionData.into()),
    }
}
