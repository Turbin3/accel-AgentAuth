//! Mock AMM error codes (`ProgramError::Custom`), 7001..=7005.

use pinocchio::program_error::ProgramError;

/// Errors raised by the mock AMM itself. Token-program errors pass through as
/// the Token program's own `Custom(n)`; read the failing program id in the logs.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MockAmmError {
    /// Computed output is below `minimum_amount_out`.
    ExceededSlippage = 7001,
    /// `pool_state`, pool authority, a mint or a token program is not what the pool expects.
    InvalidPool = 7002,
    /// A vault key, mint, owner or pairing does not match the pool.
    InvalidVault = 7003,
    /// `amount_in` is zero, or the swap would pay out zero.
    ZeroAmount = 7004,
    /// Unknown discriminator, wrong data length, bad mode byte or too many forwarded accounts.
    InvalidInstruction = 7005,
}

impl From<MockAmmError> for ProgramError {
    fn from(e: MockAmmError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
