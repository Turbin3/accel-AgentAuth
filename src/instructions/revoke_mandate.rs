use pinocchio::{
    account_info::AccountInfo,
    pubkey::{create_program_address, find_program_address, Pubkey},
    ProgramResult,
};

use super::{authorize_owner_accounts, expect_end, open_mandate, require_owner};
use crate::constants::MANDATE_SEED;
use crate::error::MandateError;

/// Close the mandate for good: the owner gets every lamport back, the data is
/// zeroed and shrunk to 0 bytes and the account is assigned back to the System
/// Program. Nothing program-owned survives, so the address is an ordinary
/// system account afterwards: it can be re-funded (even in the same
/// transaction) and `create_mandate` can adopt it again.
///
/// Accounts: `[owner (signer, writable), mandate (writable)]` (a trailing
/// System Program account is accepted and ignored).
/// Data (after the tag): none.
///
/// Revocation is permanent for *this* mandate and its counters. Nothing stops
/// the owner from creating a new mandate at the same address afterwards: it
/// starts from zero. Integrators that need to tell generations apart should
/// bind to the stored `expiry`/`bump`, not to the address alone. A paused
/// mandate can still be revoked.
pub fn revoke_mandate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [owner, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };
    expect_end(data)?;
    authorize_owner_accounts(program_id, owner, mandate_account)?;

    {
        let mut account_data = mandate_account.try_borrow_mut_data()?;
        let mandate = open_mandate(&mut account_data)?;
        require_owner(&mandate, owner)?;

        // The address must be the canonical PDA of (owner, agent). With a
        // stored bump that is one cheap syscall; mandates made by the v0.1
        // binary (version 0) carry no bump and fall back to the search.
        let bump = if mandate.version() >= 1 {
            mandate.bump()
        } else {
            find_program_address(
                &[MANDATE_SEED, owner.key().as_ref(), mandate.agent()],
                program_id,
            )
            .1
        };
        let derived = create_program_address(
            &[MANDATE_SEED, owner.key().as_ref(), mandate.agent(), &[bump]],
            program_id,
        )
        .map_err(|_| MandateError::InvalidAccountType)?;
        if mandate_account.key() != &derived {
            return Err(MandateError::InvalidAccountType.into());
        }

        // Wipe the header and counters before the account goes away.
        account_data.fill(0);
    }

    {
        let mut owner_lamports = owner.try_borrow_mut_lamports()?;
        let mut mandate_lamports = mandate_account.try_borrow_mut_lamports()?;
        *owner_lamports = owner_lamports
            .checked_add(*mandate_lamports)
            .ok_or(MandateError::ArithmeticOverflow)?;
        *mandate_lamports = 0;
    }

    // Length 0, System owner: a plain empty account, nothing left to adopt.
    mandate_account.close()
}
