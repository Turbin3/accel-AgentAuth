use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Assign, CreateAccount, Transfer};

use super::{expect_end, take_u64};
use crate::constants::{ACCOUNT_SIZE, MANDATE_DISCRIMINATOR, MANDATE_SEED, OFF_DISC};
use crate::error::MandateError;
use crate::state::Mandate;

/// Create the mandate PDA `["mandate", owner, agent]` and write its header.
///
/// Accounts: `[owner (signer, writable), agent, mandate (writable),
/// system_program]`. The agent does not sign and may be any key except the
/// owner's own.
/// Data (after the tag): `expiry i64`, nothing after. The expiry is the first
/// second at which the mandate is invalid and must be in the future.
///
/// The address is public and predictable, so anyone can send lamports to it
/// before it exists. This handler therefore accepts every state a PDA can be in:
///
/// * no lamports: `CreateAccount`;
/// * holding lamports as a plain system account (griefing pre-fund, or a
///   refund after `revoke_mandate`): top up to rent exemption, `Assign` to this
///   program (the PDA signs) and grow it to 2136 bytes;
/// * already owned by this program, 2136 bytes, discriminator 0 (a zeroed husk
///   left by the v0.1 binary): top up and initialise in place;
/// * discriminator 1: `AlreadyInitialized`.
pub fn create_mandate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [owner, agent, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(MandateError::InvalidSigner.into());
    }
    if owner.key() == agent.key() {
        return Err(MandateError::InvalidAgent.into());
    }
    let (expiry, rest) = take_u64(data)?;
    expect_end(rest)?;
    let expiry = expiry as i64;

    let (expected, bump) = find_program_address(
        &[MANDATE_SEED, owner.key().as_ref(), agent.key().as_ref()],
        program_id,
    );
    if mandate_account.key() != &expected {
        return Err(MandateError::InvalidAccountType.into());
    }
    if expiry <= Clock::get()?.unix_timestamp {
        return Err(MandateError::InvalidExpiry.into());
    }
    if !mandate_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let rent = Rent::get()?.minimum_balance(ACCOUNT_SIZE);
    let bump_seed = [bump];
    let seeds = [
        Seed::from(MANDATE_SEED),
        Seed::from(owner.key().as_ref()),
        Seed::from(agent.key().as_ref()),
        Seed::from(&bump_seed),
    ];
    let pda_signer = [Signer::from(&seeds)];

    if mandate_account.is_owned_by(program_id) {
        // A husk: right size, never initialised. Anything else is refused.
        if mandate_account.data_len() != ACCOUNT_SIZE {
            return Err(MandateError::InvalidAccountType.into());
        }
        match mandate_account.try_borrow_data()?.get(OFF_DISC) {
            Some(&MANDATE_DISCRIMINATOR) => return Err(MandateError::AlreadyInitialized.into()),
            Some(0) => {}
            _ => return Err(MandateError::InvalidAccountType.into()),
        }
        top_up(owner, mandate_account, rent)?;
    } else if mandate_account.is_owned_by(&pinocchio_system::ID) {
        if mandate_account.data_len() != 0 {
            // Cannot happen for a PDA of this program (only we can allocate it),
            // and System `Assign` could not adopt it either.
            return Err(MandateError::InvalidAccountType.into());
        }
        if mandate_account.lamports() == 0 {
            CreateAccount {
                from: owner,
                to: mandate_account,
                lamports: rent,
                space: ACCOUNT_SIZE as u64,
                owner: program_id,
            }
            .invoke_signed(&pda_signer)?;
        } else {
            top_up(owner, mandate_account, rent)?;
            Assign {
                account: mandate_account,
                owner: program_id,
            }
            .invoke_signed(&pda_signer)?;
            // Now ours: grow it directly instead of a System `Allocate` CPI.
            mandate_account.resize(ACCOUNT_SIZE)?;
        }
    } else {
        return Err(MandateError::AccountOwnerMismatch.into());
    }

    let mut account_data = mandate_account.try_borrow_mut_data()?;
    Mandate::initialize(&mut account_data, owner.key(), agent.key(), expiry, bump)?;
    Ok(())
}

/// Pay the owner's share so `mandate` holds at least `rent` lamports.
fn top_up(owner: &AccountInfo, mandate: &AccountInfo, rent: u64) -> ProgramResult {
    match rent.checked_sub(mandate.lamports()) {
        Some(missing) if missing > 0 => Transfer {
            from: owner,
            to: mandate,
            lamports: missing,
        }
        .invoke(),
        _ => Ok(()),
    }
}
