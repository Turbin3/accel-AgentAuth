//! `1 set_paused` - RELAY-SPEC section 7.2.
//!
//! Owner-only reversible kill switch: sets or clears `flags` bit0. The only
//! policy byte that ever changes after `init_policy`.
//!
//! Data `[1, paused]`; accounts (exactly 2): `owner` (signer), `policy` (writable).
//! A policy passed read-only is refused with `AccountMismatch` (102) instead of the
//! runtime failing the transaction with `ReadonlyDataModified` after the program returns.

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::checks::check_policy;
use crate::error::RelayError;
use crate::events;
use crate::state::{FLAG_PAUSED, OFF_FLAGS};

/// Handler for `set_paused`. `data` is the full instruction data (tag included).
pub fn set_paused(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let paused = match data {
        [_, 0] => false,
        [_, 1] => true,
        _ => return Err(RelayError::InvalidInstructionData.into()),
    };
    let [owner, policy] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer() {
        return Err(RelayError::OwnerNotSigner.into());
    }
    let mandate = {
        let d = policy.try_borrow_data()?;
        let p = check_policy(program_id, policy, &d)?;
        if p.owner() != owner.key() {
            return Err(RelayError::NotPolicyOwner.into());
        }
        *p.mandate()
    };
    // Fail with a relay code, not a runtime `ReadonlyDataModified` after return.
    if !policy.is_writable() {
        return Err(RelayError::AccountMismatch.into());
    }
    {
        let mut d = policy.try_borrow_mut_data()?;
        let flags = d.get_mut(OFF_FLAGS).ok_or(RelayError::InvalidPolicy)?;
        if paused {
            *flags |= FLAG_PAUSED;
        } else {
            *flags &= !FLAG_PAUSED;
        }
    }
    events::emit_paused_changed(&mandate, paused);
    Ok(())
}
