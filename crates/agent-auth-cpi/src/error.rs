//! Typed errors raised by this crate *before* any CPI is made.
//!
//! Errors that come back from the AgentAuth program itself (revoked, expired,
//! over a limit, program or instruction not allowed, ...) are NOT wrapped: they
//! propagate unchanged as `ProgramError::Custom(1..=18)` (see the core program's
//! `MandateError`), and on Solana a failed CPI aborts the whole transaction anyway.
//!
//! The codes below live in their own range (`0x4141_0001..`, "AA" in ASCII) so
//! they can never be confused with the core's `1..=18`, the relay's `100..`, or
//! small custom codes of your own program.

use pinocchio::program_error::ProgramError;

/// Base of the custom-error range used by this crate.
pub const ERROR_BASE: u32 = 0x4141_0000;

/// Why a pre-CPI check refused to call AgentAuth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum CpiError {
    /// The account supplied as the AgentAuth program is not [`crate::AGENT_AUTH_ID`].
    /// This is the confused-deputy defence: the transaction never gets to pick
    /// which program receives your `verify` call.
    WrongAgentAuthProgram = ERROR_BASE + 1,
    /// The mandate account is not owned by [`crate::AGENT_AUTH_ID`] (for example a
    /// look-alike account owned by an attacker program).
    MandateNotOwnedByAgentAuth = ERROR_BASE + 2,
    /// The mandate account data length is not [`crate::MANDATE_ACCOUNT_SIZE`].
    MandateBadSize = ERROR_BASE + 3,
    /// The mandate discriminator byte is not [`crate::MANDATE_DISCRIMINATOR`].
    MandateBadDiscriminator = ERROR_BASE + 4,
    /// The mandate account was not passed as writable to this instruction
    /// (`verify` bumps its counters, so the CPI would fail with a privilege
    /// escalation).
    MandateNotWritable = ERROR_BASE + 5,
    /// The mandate data is currently borrowed mutably by the caller; release the
    /// borrow before calling [`crate::VerifyCpi::invoke`].
    MandateBorrowed = ERROR_BASE + 6,
    /// `mandate.owner` is not the owner the integrator expects. This is the
    /// check that stops an attacker-minted mandate (attacker as owner, victim's
    /// agent or the attacker's own key as agent) from spending someone else's funds.
    OwnerMismatch = ERROR_BASE + 7,
    /// The `owner` account passed for the CPI is not the expected owner.
    OwnerAccountMismatch = ERROR_BASE + 8,
    /// `mandate.agent` is not the key of the agent account that is being verified.
    AgentMismatch = ERROR_BASE + 9,
    /// The agent account did not sign (and no PDA signer seeds were supplied).
    AgentNotSigner = ERROR_BASE + 10,
}

impl CpiError {
    /// The `ProgramError::Custom` code this error converts to.
    pub const fn code(self) -> u32 {
        self as u32
    }

    /// Inverse of [`CpiError::code`]; `None` for any code outside this crate's range.
    pub const fn from_code(code: u32) -> Option<Self> {
        Some(match code.wrapping_sub(ERROR_BASE) {
            1 => Self::WrongAgentAuthProgram,
            2 => Self::MandateNotOwnedByAgentAuth,
            3 => Self::MandateBadSize,
            4 => Self::MandateBadDiscriminator,
            5 => Self::MandateNotWritable,
            6 => Self::MandateBorrowed,
            7 => Self::OwnerMismatch,
            8 => Self::OwnerAccountMismatch,
            9 => Self::AgentMismatch,
            10 => Self::AgentNotSigner,
            _ => return None,
        })
    }

    /// A short static description, handy for `msg!` in your own program.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WrongAgentAuthProgram => "account is not the AgentAuth program",
            Self::MandateNotOwnedByAgentAuth => "mandate is not owned by AgentAuth",
            Self::MandateBadSize => "mandate has the wrong size",
            Self::MandateBadDiscriminator => "mandate has the wrong discriminator",
            Self::MandateNotWritable => "mandate account must be writable",
            Self::MandateBorrowed => "mandate data is already borrowed",
            Self::OwnerMismatch => "mandate owner is not the expected owner",
            Self::OwnerAccountMismatch => "owner account is not the expected owner",
            Self::AgentMismatch => "mandate agent is not the verified agent",
            Self::AgentNotSigner => "agent did not sign",
        }
    }
}

impl From<CpiError> for ProgramError {
    fn from(e: CpiError) -> Self {
        ProgramError::Custom(e.code())
    }
}
