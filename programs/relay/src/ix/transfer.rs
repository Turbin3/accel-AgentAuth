//! `3 transfer` - RELAY-SPEC section 7.4.
//!
//! The agent supplies only an amount. The relay validates the policy, the
//! mandate and every token account, calls AgentAuth `verify` (target = the
//! pinned Token program, discriminator = `TRANSFER_CHECKED_DISC`, the same
//! `amount` that is moved), then performs an SPL `TransferChecked` from the
//! owner's source account to an allowlisted recipient, signed by the authority
//! PDA (the SPL delegate), and finally proves the exact balance deltas.
//!
//! Data `[3] + amount u64 LE` (9 bytes); accounts (exactly 10): `agent` (signer),
//! `mandate` (writable), `owner`, `policy`, `authority`, `source` (writable),
//! `destination` (writable), `mint`, `token_program`, `agentauth_program`.

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::bytes::u64_at;
use crate::checks::{check_actors, Actors};
use crate::cpi::{self, TransferChecked};
use crate::error::RelayError;
use crate::events;
use crate::ids::{is_token_program, TRANSFER_CHECKED_DISC};
use crate::token::{check_mint, token_acct_ok, TokenAcct, TA_AMOUNT};

/// Total `transfer` data length: tag + amount.
pub const TRANSFER_DATA_LEN: usize = 9;

/// Values produced by the pre-flight and consumed after the CPIs.
struct Pre {
    decimals: u8,
    authority_bump: u8,
    src_before: u64,
    dst_before: u64,
}

/// Handler for `transfer`. `data` is the full instruction data (tag included).
pub fn transfer(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let amount = parse_amount(data)?;
    let [agent, mandate, owner, policy, authority, source, destination, mint, token_program, agentauth_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let actors = Actors {
        agent,
        mandate,
        owner,
        policy,
        authority,
        agentauth_program,
    };

    // Every borrow taken in `preflight` is dropped when it returns.
    let pre = preflight(
        program_id,
        &actors,
        source,
        destination,
        mint,
        token_program,
        amount,
    )?;

    cpi::verify(
        mandate,
        owner,
        agent,
        token_program.key(),
        &TRANSFER_CHECKED_DISC,
        amount,
    )?;
    cpi::transfer_checked(
        &TransferChecked {
            token_program,
            source,
            mint,
            destination,
            authority,
            mandate: mandate.key(),
            authority_bump: pre.authority_bump,
        },
        amount,
        pre.decimals,
    )?;

    verify_deltas(source, destination, &pre, amount)?;
    events::emit_transfer(mandate.key(), destination.key(), mint.key(), amount);
    Ok(())
}

/// Step 1: exact length, non-zero amount (100).
fn parse_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != TRANSFER_DATA_LEN {
        return Err(RelayError::InvalidInstructionData.into());
    }
    let amount = u64_at(data, 1);
    if amount == 0 {
        return Err(RelayError::InvalidInstructionData.into());
    }
    Ok(amount)
}

/// Steps 3 to 14: every check that precedes the first CPI.
#[inline(never)]
fn preflight(
    program_id: &Pubkey,
    a: &Actors,
    source: &AccountInfo,
    destination: &AccountInfo,
    mint: &AccountInfo,
    token_program: &AccountInfo,
    amount: u64,
) -> Result<Pre, ProgramError> {
    let policy_data = a.policy.try_borrow_data()?;
    let mandate_data = a.mandate.try_borrow_data()?;
    let p = check_actors(program_id, a, &policy_data, &mandate_data)?;
    let cfg = p.config();

    // Step 10: pins, then the token program must be Token or Token-2022.
    if token_program.key() != cfg.token_program()
        || mint.key() != cfg.budget_mint()
        || source.key() != cfg.source_account()
    {
        return Err(RelayError::AccountMismatch.into());
    }
    if !is_token_program(token_program.key()) {
        return Err(RelayError::WrongProgram.into());
    }

    // Step 11: allowlisted recipient, never the source itself.
    if !cfg.is_recipient(destination.key()) || destination.key() == source.key() {
        return Err(RelayError::RecipientNotAllowed.into());
    }

    // Step 12: mint and account owners.
    let decimals = check_mint(mint, token_program.key())?;
    if source.owner() != token_program.key() || destination.owner() != token_program.key() {
        return Err(RelayError::WrongProgram.into());
    }

    // Step 13: source is the owner's account, delegated to the authority PDA.
    let src_before = {
        let d = token_acct_ok(source, token_program.key())?;
        let t = TokenAcct(&d);
        if t.mint() != cfg.budget_mint()
            || t.owner() != p.owner()
            || !t.delegate_is(a.authority.key())
            || t.delegated_amount() < amount
        {
            return Err(RelayError::TokenAccountState.into());
        }
        t.amount()
    };

    // Step 14: destination holds the budget mint (its owner is a third party).
    let dst_before = {
        let d = token_acct_ok(destination, token_program.key())?;
        let t = TokenAcct(&d);
        if t.mint() != cfg.budget_mint() {
            return Err(RelayError::TokenAccountState.into());
        }
        t.amount()
    };

    Ok(Pre {
        decimals,
        authority_bump: p.authority_bump(),
        src_before,
        dst_before,
    })
}

/// Steps 17: fresh reads; the source fell by exactly `amount` and the
/// destination rose by exactly `amount` (106, or 114 on underflow).
#[inline(never)]
fn verify_deltas(
    source: &AccountInfo,
    destination: &AccountInfo,
    pre: &Pre,
    amount: u64,
) -> ProgramResult {
    let src_after = u64_at(&source.try_borrow_data()?, TA_AMOUNT);
    let dst_after = u64_at(&destination.try_borrow_data()?, TA_AMOUNT);
    let debited = pre
        .src_before
        .checked_sub(src_after)
        .ok_or(RelayError::ArithmeticOverflow)?;
    let credited = dst_after
        .checked_sub(pre.dst_before)
        .ok_or(RelayError::ArithmeticOverflow)?;
    if debited != amount || credited != amount {
        return Err(RelayError::BalanceDeltaViolation.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_parsing() {
        let mut d = vec![3u8];
        d.extend_from_slice(&5u64.to_le_bytes());
        assert_eq!(parse_amount(&d).ok(), Some(5));
        // golden/transfer_ix_data.hex
        assert_eq!(
            parse_amount(&[0x03, 0xc0, 0xc6, 0x2d, 0, 0, 0, 0, 0]).ok(),
            Some(3_000_000)
        );
        for bad in [&d[..8], &[d.as_slice(), &[0]].concat()[..]] {
            assert_eq!(
                parse_amount(bad).err(),
                Some(ProgramError::Custom(100)),
                "len {}",
                bad.len()
            );
        }
        let zero = [3u8, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(parse_amount(&zero).err(), Some(ProgramError::Custom(100)));
    }
}
