//! Shared validation routines (RELAY-SPEC section 6) and the common
//! pre-flight sequence of the two agent-facing handlers (section 7.4 steps 3-9,
//! section 7.5 steps 3-9).
//!
//! Token-account and mint checks live in [`crate::token`].

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::bytes::{byte_at, key_at, slice_at};
use crate::error::RelayError;
use crate::ids::AGENT_AUTH_ID;
use crate::state::{
    Policy, FLAGS_RESERVED_MASK, FLAG_PAUSED, FLAG_STRICT_TOP_LEVEL, MANDATE_DISC, MANDATE_LEN,
    MANDATE_OFF_AGENT, MANDATE_OFF_DISC, MANDATE_OFF_EXPIRY, MANDATE_OFF_OWNER, POLICY_DISC,
    POLICY_VERSION,
};

/// `check_policy` of RELAY-SPEC 6.1 (error 101): relay-owned, 944 bytes,
/// discriminator `0xA7`, version 1, reserved flag bits clear. Returns a view
/// over `data` (the caller's borrow of `policy`).
pub fn check_policy<'a>(
    program_id: &Pubkey,
    policy: &AccountInfo,
    data: &'a [u8],
) -> Result<Policy<'a>, ProgramError> {
    let bad = RelayError::InvalidPolicy;
    if policy.owner() != program_id {
        return Err(bad.into());
    }
    let p = Policy::new(data).ok_or(bad)?;
    if p.disc() != POLICY_DISC
        || p.version() != POLICY_VERSION
        || p.flags() & FLAGS_RESERVED_MASK != 0
    {
        return Err(bad.into());
    }
    Ok(p)
}

/// `check_mandate` of RELAY-SPEC 6.2 (error 117): a genuine AgentAuth mandate
/// bound to `owner` and `agent`. Active flag and expiry are left to `verify`.
pub fn check_mandate(
    mandate: &AccountInfo,
    mandate_data: &[u8],
    owner: &Pubkey,
    agent: &Pubkey,
) -> Result<(), ProgramError> {
    if mandate.owner() != &AGENT_AUTH_ID
        || mandate_data.len() != MANDATE_LEN
        || byte_at(mandate_data, MANDATE_OFF_DISC) != MANDATE_DISC
        || key_at(mandate_data, MANDATE_OFF_OWNER) != owner
        || key_at(mandate_data, MANDATE_OFF_AGENT) != agent
    {
        return Err(RelayError::InvalidMandate.into());
    }
    Ok(())
}

/// Current CPI stack height (1 = top-level instruction).
#[cfg(target_os = "solana")]
#[allow(unsafe_code)]
fn stack_height() -> u64 {
    // SAFETY: `sol_get_stack_height` is a parameterless runtime syscall that
    // only returns a number; it touches no memory.
    unsafe { pinocchio::syscalls::sol_get_stack_height() }
}

/// Host builds (unit tests) behave as a top-level instruction.
#[cfg(not(target_os = "solana"))]
fn stack_height() -> u64 {
    1
}

/// Flags gate (RELAY-SPEC 7.4 step 6): paused -> 116; `STRICT_TOP_LEVEL` and
/// stack height != 1 -> 115.
pub fn check_flags(flags: u8) -> Result<(), ProgramError> {
    if flags & FLAG_PAUSED != 0 {
        return Err(RelayError::Paused.into());
    }
    if flags & FLAG_STRICT_TOP_LEVEL != 0 && stack_height() != 1 {
        return Err(RelayError::NotTopLevel.into());
    }
    Ok(())
}

/// Bindings (RELAY-SPEC 7.4 step 8, error 102): the policy was created for
/// exactly these accounts.
fn check_bindings(
    p: &Policy,
    mandate: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    authority: &Pubkey,
) -> Result<(), ProgramError> {
    if p.mandate() != mandate
        || p.owner() != owner
        || p.agent() != agent
        || p.authority() != authority
    {
        return Err(RelayError::AccountMismatch.into());
    }
    Ok(())
}

/// Stale-policy guard (RELAY-SPEC 7.4 step 9, error 118): the policy was
/// created for the mandate generation that is live now.
fn check_fresh(p: &Policy, mandate_data: &[u8]) -> Result<(), ProgramError> {
    if slice_at(mandate_data, MANDATE_OFF_EXPIRY, 8) != p.mandate_expiry_bytes() {
        return Err(RelayError::StalePolicy.into());
    }
    Ok(())
}

/// The accounts shared by `transfer` and `swap`.
pub struct Actors<'a> {
    /// Agent (signer).
    pub agent: &'a AccountInfo,
    /// AgentAuth mandate (writable, passed to `verify`).
    pub mandate: &'a AccountInfo,
    /// Owner (from the mandate).
    pub owner: &'a AccountInfo,
    /// Relay policy PDA.
    pub policy: &'a AccountInfo,
    /// Authority PDA (SPL delegate).
    pub authority: &'a AccountInfo,
    /// AgentAuth program account (must be the compiled id).
    pub agentauth_program: &'a AccountInfo,
}

/// Steps 3 to 9 of `transfer` / `swap`, in the specified order:
/// agent signer (107), AgentAuth id (103), `check_policy` (101), flags
/// (116 / 115), `check_mandate` (117), bindings (102), stale guard (118).
///
/// `policy_data` and `mandate_data` are the caller's data borrows; they must
/// be dropped before the first CPI. Returns the validated policy view.
pub fn check_actors<'p>(
    program_id: &Pubkey,
    a: &Actors,
    policy_data: &'p [u8],
    mandate_data: &[u8],
) -> Result<Policy<'p>, ProgramError> {
    if !a.agent.is_signer() {
        return Err(RelayError::AgentNotSigner.into());
    }
    if a.agentauth_program.key() != &AGENT_AUTH_ID {
        return Err(RelayError::WrongProgram.into());
    }
    let p = check_policy(program_id, a.policy, policy_data)?;
    check_flags(p.flags())?;
    check_mandate(a.mandate, mandate_data, a.owner.key(), a.agent.key())?;
    check_bindings(
        &p,
        a.mandate.key(),
        a.owner.key(),
        a.agent.key(),
        a.authority.key(),
    )?;
    check_fresh(&p, mandate_data)?;
    Ok(p)
}
