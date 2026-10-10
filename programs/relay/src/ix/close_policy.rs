//! `2 close_policy` - RELAY-SPEC section 7.3.
//!
//! Owner-only. Returns all policy lamports to the owner, zero-fills the data
//! and closes the account. Works regardless of the mandate's state, so the
//! one-transaction unwind (section 12.3) can always include it. A fresh
//! `init_policy` in a later transaction creates a new policy.
//!
//! Data `[2]`; accounts (exactly 2): `owner` (signer, writable), `policy` (writable).

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::checks::check_policy;
use crate::error::RelayError;
use crate::events;

/// Handler for `close_policy`. `data` is the full instruction data (tag included).
pub fn close_policy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 1 {
        return Err(RelayError::InvalidInstructionData.into());
    }
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

    // Zero-fill so no stale configuration survives in the account buffer, then
    // move every lamport to the owner and close (owner/lamports/len zeroed).
    policy.try_borrow_mut_data()?.fill(0);
    let moved = policy.lamports();
    let new_owner_balance = owner
        .lamports()
        .checked_add(moved)
        .ok_or(RelayError::ArithmeticOverflow)?;
    *owner.try_borrow_mut_lamports()? = new_owner_balance;
    *policy.try_borrow_mut_lamports()? = 0;
    policy.close()?;

    events::emit_policy_closed(&mandate, policy.key());
    Ok(())
}
