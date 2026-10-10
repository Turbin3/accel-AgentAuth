//! Relay error codes (`ProgramError::Custom(100..=119)`), RELAY-SPEC section 9.
//!
//! The numbers are part of the public ABI (the SDK, CLI and dashboard decode
//! them) and never collide with the AgentAuth core codes `1..=18` that surface
//! unchanged through `verify`. Attribute an error to a program by the failing
//! program id in the logs, not by the number alone.

use pinocchio::program_error::ProgramError;

/// Errors raised by the relay itself. See RELAY-SPEC section 9 for when each
/// is raised.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RelayError {
    /// Unknown or empty tag, wrong data length, zero amount, bad `paused` byte.
    InvalidInstructionData = 100,
    /// Policy owner program, length, discriminator, version or reserved flag bits wrong.
    InvalidPolicy = 101,
    /// A passed key differs from a pinned key, a derived PDA or a mandate binding.
    AccountMismatch = 102,
    /// AgentAuth, Token or AMM program id is not the compiled or pinned one;
    /// an account owner program is wrong; a mint is not an initialised
    /// extension-free mint.
    WrongProgram = 103,
    /// Destination not on the recipient allowlist, or destination equals source.
    RecipientNotAllowed = 104,
    /// Token-account layout, mint, owner field, frozen state, delegate other
    /// than the authority PDA, or `delegated_amount` / balance too low.
    TokenAccountState = 105,
    /// A post-CPI balance change differs from the exact amount requested.
    BalanceDeltaViolation = 106,
    /// The agent did not sign.
    AgentNotSigner = 107,
    /// The owner did not sign.
    OwnerNotSigner = 108,
    /// The signer is not the owner recorded in the mandate or policy.
    NotPolicyOwner = 109,
    /// `swap` on a policy created with `swap_enabled = 0`.
    SwapDisabled = 110,
    /// Swap deadline in the past or beyond `max_deadline_slots`.
    DeadlineExpired = 111,
    /// Swap output below the effective floor (reachable only when the AMM
    /// returned `Ok` but under-delivered).
    SlippageFloorViolated = 112,
    /// `init_policy` validation failed (config, flags, agent == owner, policy exists).
    InvalidConfig = 113,
    /// Floor math or delta arithmetic overflowed or underflowed.
    ArithmeticOverflow = 114,
    /// `STRICT_TOP_LEVEL` is set and the stack height is not 1.
    NotTopLevel = 115,
    /// The policy is paused.
    Paused = 116,
    /// Not a live AgentAuth mandate for this owner and agent (includes revoked mandates).
    InvalidMandate = 117,
    /// The policy `mandate_expiry` differs from the live mandate's expiry.
    StalePolicy = 118,
    /// A callee changed the owner program, data length, owner field, close
    /// authority or delegate of an owner-side token account.
    AccountInvariantViolated = 119,
}

impl RelayError {
    /// Every variant, in code order (100..=119).
    pub const ALL: [RelayError; 20] = [
        RelayError::InvalidInstructionData,
        RelayError::InvalidPolicy,
        RelayError::AccountMismatch,
        RelayError::WrongProgram,
        RelayError::RecipientNotAllowed,
        RelayError::TokenAccountState,
        RelayError::BalanceDeltaViolation,
        RelayError::AgentNotSigner,
        RelayError::OwnerNotSigner,
        RelayError::NotPolicyOwner,
        RelayError::SwapDisabled,
        RelayError::DeadlineExpired,
        RelayError::SlippageFloorViolated,
        RelayError::InvalidConfig,
        RelayError::ArithmeticOverflow,
        RelayError::NotTopLevel,
        RelayError::Paused,
        RelayError::InvalidMandate,
        RelayError::StalePolicy,
        RelayError::AccountInvariantViolated,
    ];

    /// First relay error code.
    pub const FIRST: u32 = 100;
    /// Last relay error code.
    pub const LAST: u32 = 119;

    /// The numeric code carried in `ProgramError::Custom`.
    pub const fn code(self) -> u32 {
        self as u32
    }
}

impl From<RelayError> for ProgramError {
    fn from(e: RelayError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FE-04: codes are contiguous 100..=119 in declaration order.
    #[test]
    fn codes_are_contiguous_and_unique() {
        for (i, e) in RelayError::ALL.iter().enumerate() {
            assert_eq!(e.code(), RelayError::FIRST + i as u32);
        }
        assert_eq!(
            RelayError::ALL.last().map(|e| e.code()),
            Some(RelayError::LAST)
        );
    }

    #[test]
    fn converts_to_custom() {
        assert_eq!(
            ProgramError::from(RelayError::Paused),
            ProgramError::Custom(116)
        );
    }
}
