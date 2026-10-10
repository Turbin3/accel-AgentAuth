use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use super::{open_mandate, require_active, take_pubkey, take_u64};
use crate::error::MandateError;

/// Check a reported action against the mandate and record it. The hot path.
///
/// Accounts: `[mandate (writable), owner, agent (signer)]`.
/// Data (after the tag, exactly 48 bytes): `target_program_id[32] |
/// discriminator[8] | amount u64`.
///
/// `verify` is **advisory** on its own: it checks the values the caller
/// reports, not what the caller then does, and any program can call it. It
/// only constrains an agent when an integrator derives the program id,
/// discriminator and amount from the action it is about to perform and makes
/// the action conditional on this call (the AgentAuth relay does). Integrators
/// must also pin this program's id and check `mandate.owner` against the
/// authority they protect: anyone can create a mandate naming any agent.
///
/// Limits of 0 mean **unlimited**. On a limited permission `spend_total +
/// amount` that overflows `u64` is simply over the limit (`SpendLimitExceeded`).
/// On an unlimited permission `spend_total` and `call_count` saturate, so one
/// call with a huge amount can never wedge the mandate.
pub fn verify(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target_program, rest) = take_pubkey(data)?;
    let (disc, rest) = rest
        .split_first_chunk::<8>()
        .ok_or(MandateError::InvalidInstructionData)?;
    let (amount, rest) = take_u64(rest)?;
    if !rest.is_empty() {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let [mandate_account, owner, agent, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !mandate_account.is_owned_by(program_id) {
        return Err(MandateError::AccountOwnerMismatch.into());
    }
    if !mandate_account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut account_data = mandate_account.try_borrow_mut_data()?;
    let mut mandate = open_mandate(&mut account_data)?;
    require_active(&mandate)?;
    if mandate.is_expired(Clock::get()?.unix_timestamp) {
        return Err(MandateError::Expired.into());
    }
    if owner.key().as_ref() != mandate.owner() {
        return Err(MandateError::NotOwner.into());
    }
    if agent.key().as_ref() != mandate.agent() {
        return Err(MandateError::UnknownAgent.into());
    }
    if !agent.is_signer() {
        return Err(MandateError::InvalidSigner.into());
    }

    let index = mandate
        .find_permission(target_program)
        .ok_or(MandateError::ProgramNotAllowed)?;
    let permission = mandate.permission(index);
    if !permission.allows(disc) {
        return Err(MandateError::DiscriminatorNotAllowed.into());
    }
    let per_tx_limit = permission.per_tx_limit();
    if per_tx_limit != 0 && amount > per_tx_limit {
        return Err(MandateError::PerTxExceeded.into());
    }
    let spend_limit = permission.spend_limit();
    let spend_total = if spend_limit == 0 {
        permission.spend_total().saturating_add(amount)
    } else {
        match permission.spend_total().checked_add(amount) {
            Some(total) if total <= spend_limit => total,
            _ => return Err(MandateError::SpendLimitExceeded.into()),
        }
    };
    let call_count = permission.call_count().saturating_add(1);

    let mut permission = mandate.permission_mut(index);
    permission.set_spend_total(spend_total);
    permission.set_call_count(call_count);
    Ok(())
}
