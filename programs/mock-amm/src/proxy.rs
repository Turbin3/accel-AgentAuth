//! `proxy`: a transparent CPI forwarder used to test stack-height rules.
//!
//! Data (after the discriminator) is the inner instruction data. Accounts are
//! `[program, ...rest]`; `program` is invoked with every account in `rest`, keeping each
//! account's signer/writable flags. Running an instruction through `proxy` puts it at stack
//! height 2, which is what the relay's `STRICT_TOP_LEVEL` flag must reject.

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};

use crate::cpi::forward;

pub fn proxy(accounts: &[AccountInfo], inner_data: &[u8]) -> ProgramResult {
    let (program, rest) = accounts
        .split_first()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    forward(program.key(), inner_data, rest, program)
}
