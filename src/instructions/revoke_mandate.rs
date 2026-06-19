use crate::{
    constants::{MANDATE_DISCRIMINATOR, MANDATE_SEED},
    error::MandateError,
    ACCOUNT_SIZE, OFF_AGENT, OFF_DISC, OFF_OWNER,
};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

pub fn revoke_mandate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    // ── account parsing ────────────────────────────────────────────────────
    if accounts.len() < 2 {
        return Err(MandateError::InvalidInstructionData.into());
    }
    let owner_account = &accounts[0];
    let mandate_pda = &accounts[1];

    // Owner must sign — no unsigned kill-switches.
    if !owner_account.is_signer() {
        return Err(MandateError::InvalidSigner.into());
    }

    // Mandate must be owned by this program — prevents operating on foreign accounts.
    if mandate_pda.owner() != program_id {
        return Err(MandateError::AccountOwnerMismatch.into());
    }

    // Mandate must be declared writable by the caller.
    if !mandate_pda.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ── read fields needed for validation before zeroing ───────────────────
    let (stored_owner, stored_agent) = {
        let data = mandate_pda
            .try_borrow_mut_data()
            .map_err(|_| ProgramError::AccountBorrowFailed)?;

        if data.len() != ACCOUNT_SIZE {
            return Err(MandateError::InvalidInstructionData.into());
        }

        // Must be an initialised mandate (discriminator == 1).
        if data[OFF_DISC] != MANDATE_DISCRIMINATOR {
            return Err(MandateError::InvalidAccountType.into());
        }

        let mut o = [0u8; 32];
        let mut a = [0u8; 32];
        o.copy_from_slice(&data[OFF_OWNER..OFF_OWNER + 32]);
        a.copy_from_slice(&data[OFF_AGENT..OFF_AGENT + 32]);
        (o, a)
    }; // data borrow dropped

    // Signer must be the owner recorded inside the mandate.
    if owner_account.key().as_ref() != &stored_owner {
        return Err(MandateError::NotOwner.into());
    }

    // Re-derive the PDA — prevents passing an arbitrary account whose stored
    // owner field was crafted to match.
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[MANDATE_SEED, owner_account.key().as_ref(), &stored_agent],
        program_id,
    );
    if expected_pda != *mandate_pda.key() {
        return Err(ProgramError::InvalidAccountData);
    }

    // ── close: zero data then drain lamports ───────────────────────────────

    // 1. Zero every byte — no lingering readable state.
    {
        let mut data = mandate_pda
            .try_borrow_mut_data()
            .map_err(|_| ProgramError::AccountBorrowFailed)?;
        data.fill(0);
    } // data borrow dropped before CPI

    // 2. Return the full rent to the owner via system-program Transfer CPI,
    //    signed by the mandate PDA using its derivation seeds + bump.
    let rent_lamports = mandate_pda.lamports();
    let bump_arr = [bump];
    let signer_seeds = [
        Seed::from(MANDATE_SEED),
        Seed::from(owner_account.key().as_ref()),
        Seed::from(&stored_agent[..]),
        Seed::from(&bump_arr[..]),
    ];
    let signer = Signer::from(&signer_seeds);

    Transfer {
        from: mandate_pda,
        to: owner_account,
        lamports: rent_lamports,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}
