use crate::constants::{MANDATE_DISCRIMINATOR, MANDATE_SEED};
use crate::error::MandateError;
use crate::state::Mandate;
use pinocchio::pubkey::find_program_address;
use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

// TODO(P2): the hot path. Check active + not expired, match program + discriminator,
// enforce per-tx and total spend limits, then bump counters. ~49-byte ABI.
pub fn verify(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Parse Instruction data
    if data.len() != 48 {
        return Err(MandateError::InvalidInstructionData.into());
    }

    let target_program_id: &[u8; 32] = data[0..32].try_into().unwrap();
    let target_ix_disc: &[u8; 8] = data[32..40].try_into().unwrap();
    let amount = u64::from_le_bytes(data[40..48].try_into().unwrap());

    // Parse accounts
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let mandate_account = &accounts[0];
    let owner_account = &accounts[1];
    let agent_account = &accounts[2];

    //validate accounts
    let (expected_pda, _bump) = find_program_address(
        &[
            MANDATE_SEED,
            owner_account.key().as_ref(),
            agent_account.key().as_ref(),
        ],
        program_id,
    );

    if mandate_account.key() != &expected_pda {
        return Err(ProgramError::InvalidAccountData);
    };

    let mut mandate_acc_data = mandate_account
        .try_borrow_mut_data()
        .map_err(|_| ProgramError::AccountBorrowFailed)?;
    let mut mandate = Mandate::from_bytes(&mut mandate_acc_data)?;

    if mandate.discriminator() != MANDATE_DISCRIMINATOR {
        return Err(MandateError::InvalidAccountType.into());
    };

    // check if mandate is active
    if !mandate.is_active() {
        return Err(MandateError::NotActive.into());
    };

    //check expiry
    let current_time = Clock::get()?.unix_timestamp;
    if current_time > mandate.expiry() {
        return Err(MandateError::Expired.into());
    };

    //check if owner owns mandate
    if owner_account.key() != mandate.owner() {
        return Err(MandateError::NotOwner.into());
    };

    // check if agent in mandate
    if agent_account.key() != mandate.agent() {
        return Err(MandateError::UnknownAgent.into());
    }

    //check if agent is signer
    if !agent_account.is_signer() {
        return Err(MandateError::InvalidSigner.into());
    }

    let permission_index = mandate
        .find_permission(target_program_id)
        .ok_or(MandateError::ProgramNotAllowed)?;

    {
        //permission checks
        let permission = mandate.permission(permission_index);

        if !permission.allows(&target_ix_disc) {
            return Err(MandateError::DiscriminatorNotAllowed.into());
        };

        let per_tx_limit = permission.per_tx_limit();
        if per_tx_limit != 0 && amount > per_tx_limit {
            return Err(MandateError::PerTxExceeded.into());
        }

        let spend_limit = permission.spend_limit();
        if spend_limit != 0 {
            let projected = permission
                .spend_total()
                .checked_add(amount)
                .ok_or(MandateError::ArithmeticOverflow)?;
            if projected > spend_limit {
                return Err(MandateError::SpendLimitExceeded.into());
            }
        }
    };

    {
        // updating permission base on previous action
        let perm_read = mandate.permission(permission_index);
        let total_spent = perm_read
            .spend_total()
            .checked_add(amount)
            .ok_or(MandateError::ArithmeticOverflow)?;
        let permission_call_count = perm_read
            .call_count()
            .checked_add(1)
            .ok_or(MandateError::ArithmeticOverflow)?;
        let mut permission = mandate.permission_mut(permission_index);
        permission.set_spend_total(total_spent);
        permission.set_call_count(permission_call_count);
    };

    Ok(())
}
