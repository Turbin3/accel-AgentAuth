//! `init_pool`: write a `pool_state` on a cluster where `set_account` is not available.
//!
//! Accounts: `[pool_state W, vault_0, vault_1]`. `pool_state` must already exist, be owned by
//! this program, be exactly 104 bytes and be all zero (create it with System `CreateAccount`
//! in the same transaction). Data after the discriminator: `mode u8`, `aux_key [u8;32]`.
//! Vault contents are not inspected here; `swap` validates them on every call.

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::error::MockAmmError;
use crate::mode::Mode;
use crate::pool::{PoolState, POOL_STATE_LEN};

pub fn init_pool(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let Some((&mode_byte, aux)) = data.split_first() else {
        return Err(MockAmmError::InvalidInstruction.into());
    };
    let aux_key: Pubkey = aux
        .try_into()
        .map_err(|_| ProgramError::from(MockAmmError::InvalidInstruction))?;
    let mode = Mode::from_u8(mode_byte).ok_or(MockAmmError::InvalidInstruction)?;

    let [pool_state, vault_0, vault_1, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if pool_state.owner() != program_id
        || pool_state.data_len() != POOL_STATE_LEN
        || !pool_state.is_writable()
    {
        return Err(MockAmmError::InvalidPool.into());
    }
    if vault_0.key() == vault_1.key() {
        return Err(MockAmmError::InvalidVault.into());
    }

    let mut bytes = pool_state.try_borrow_mut_data()?;
    if bytes.iter().any(|b| *b != 0) {
        return Err(MockAmmError::InvalidPool.into());
    }
    let state = PoolState {
        mode,
        vault_0: *vault_0.key(),
        vault_1: *vault_1.key(),
        aux_key,
    };
    bytes.copy_from_slice(&state.encode());
    Ok(())
}
