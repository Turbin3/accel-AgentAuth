//! # agent-auth-cpi
//!
//! The safe-by-default way for a Pinocchio program to ask **AgentAuth** "may
//! this agent do this?" before it moves funds or changes state on the agent's behalf.
//!
//! AgentAuth is an on-chain mandate standard: an owner grants an agent key a
//! mandate naming the programs and instruction discriminators it may call, with
//! per-transaction and lifetime limits and an expiry. Your program enforces the
//! mandate by CPI-ing the core `verify` instruction. Doing that *correctly* has two
//! confused-deputy traps, and this crate makes both impossible to fall into:
//!
//! * **Wrong program.** If you take the AgentAuth program id from the transaction, an
//!   attacker passes a "yes-man" program that approves everything. [`VerifyCpi`]
//!   always calls [`AGENT_AUTH_ID`] and rejects any other program account.
//! * **Wrong owner.** Anyone can create a mandate naming any agent, with themselves
//!   as owner. If you spend from a treasury without binding the mandate's owner to
//!   that treasury, the attacker's own mandate authorises spending someone else's
//!   money. [`VerifyCpi::expected_owner`] is a required field, and the mandate must
//!   name exactly that owner.
//!
//! ## Usage
//!
//! ```no_run
//! use agent_auth_cpi::{disc8, VerifyCpi};
//! # use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
//! # fn handler(auth: &AccountInfo, mandate: &AccountInfo, owner: &AccountInfo, agent: &AccountInfo,
//! #            treasury_owner: &Pubkey, system: &Pubkey, lamports: u64) -> Result<(), ProgramError> {
//! VerifyCpi { agent_auth_program: auth, mandate, owner, agent, expected_owner: treasury_owner,
//!             target_program: system, disc: disc8::SYSTEM_TRANSFER, amount: lamports }.invoke()?;
//! // verified: now perform the transfer, for exactly `lamports`, out of the treasury of `treasury_owner`
//! # Ok(()) }
//! ```
//!
//! ## What is enforced, and by whom
//!
//! | Check | Enforced by |
//! |---|---|
//! | callee is the real AgentAuth program, mandate is a real mandate, mandate owner and agent bound | this crate, before the CPI |
//! | active, not expired, program and `disc8` allowed, per-transaction and lifetime limits | the AgentAuth program (its error code propagates, e.g. `Custom(5)` expired, `Custom(8)` per-tx limit) |
//! | the action you perform really is the `(target_program, disc8, amount)` you reported | **you**. This is advisory authorisation: AgentAuth cannot see what your program does after `verify` returns |
//!
//! A failed `verify` aborts the whole transaction (a failing CPI cannot be caught
//! on Solana), so there is no way to "swallow" a rejection and carry on.
//!
//! ## Security checklist for integrators
//!
//! 1. **Source `expected_owner` from your own state.** Derive it from the account
//!    you are protecting (a vault PDA seeded by the owner key, a stored authority
//!    field, ...). Never read it from instruction data or an account the agent
//!    chooses, or you rebuild the owner-binding hole. Then make the funds follow it:
//!    sign for a PDA derived from that same owner (`["treasury", owner]`), so a
//!    mandate can only ever spend its own owner's money.
//! 2. **Report the real amount** and the real `(target_program, disc8)`. Compute
//!    them from the same values you act on; do not take a separate "amount to verify"
//!    from the caller. `verify` cannot see the transfer you make afterwards.
//! 3. **Verify first, act second, in the same instruction.** Do not cache a past
//!    success, and do not skip verification on any code path that moves value.
//! 4. **Pass the AgentAuth program account** (and the mandate as writable) in your
//!    instruction's account list; `verify` increments counters in the mandate.
//! 5. **Do not hold a borrow of the mandate data across the call**
//!    ([`CpiError::MandateBorrowed`]).
//! 6. **Mind the call depth.** `verify` runs one level below your program; at the
//!    runtime's current CPI limit your program must be at stack height 4 or lower.
//! 7. **PDA agents:** use [`VerifyCpi::invoke_signed`] with the seeds of the PDA that
//!    is `mandate.agent`; the runtime rejects seeds that do not derive it.
//! 8. **Treat `disc8` carefully.** Use [`disc8`] (1-byte tag: tag then 7 zero bytes,
//!    never the first 8 raw instruction bytes; Anchor: the 8-byte hash) so the value
//!    matches what the owner's mandate lists (see the registry).
//! 9. The mandate's owner is only as trustworthy as their key. A mandate says what an
//!    owner *allowed*; it is not an audit or endorsement of the agent.
//!
//! This is unaudited prototype code (devnet). It does not make a program safe on its
//! own: the rest of your program's access control still applies.
//!
//! ## Reading a mandate yourself
//!
//! [`MandateHeader`] is a zero-copy view (`owner()`, `agent()`, `expiry()`,
//! `active()`) that only constructs from an account owned by [`AGENT_AUTH_ID`] with
//! the right size and discriminator. Use it for your own policy on top of `verify`.
//!
//! ## `no_std`
//!
//! The only dependency is `pinocchio` (the exact Pinocchio version is pinned by the
//! workspace). The crate performs no heap allocation and no logging.
#![no_std]

mod error;
mod mandate;
mod verify;

pub mod disc8;

pub use error::{CpiError, ERROR_BASE};
pub use mandate::MandateHeader;
pub use pinocchio::pubkey::Pubkey;
pub use verify::{verify_instruction_data, VerifyCpi};

/// The real AgentAuth core program id
/// (`AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if`). [`VerifyCpi`] only ever calls this.
pub const AGENT_AUTH_ID: Pubkey = [
    0x8a, 0x87, 0x11, 0xe6, 0x16, 0x3f, 0x96, 0xf6, 0x86, 0x1f, 0xf5, 0x57, 0xdf, 0x8f, 0x70, 0x35,
    0xdd, 0xbd, 0x8f, 0xed, 0x63, 0x57, 0x6c, 0xa7, 0x22, 0x55, 0x86, 0x0e, 0xde, 0xfa, 0x19, 0xbc,
];

/// Instruction tag of `verify` in the core program.
pub const VERIFY_TAG: u8 = 3;
/// Length of the `verify` instruction data: tag + program[32] + disc8[8] + amount u64.
pub const VERIFY_DATA_LEN: usize = 49;

/// Total size of a mandate account.
pub const MANDATE_ACCOUNT_SIZE: usize = 2136;
/// Value of the discriminator byte of an initialised mandate.
pub const MANDATE_DISCRIMINATOR: u8 = 1;

pub(crate) const OFF_DISC: usize = 0;
pub(crate) const OFF_OWNER: usize = 1;
pub(crate) const OFF_AGENT: usize = 33;
pub(crate) const OFF_EXPIRY: usize = 65;
pub(crate) const OFF_ACTIVE: usize = 73;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_id_matches_base58() {
        let want: solana_pubkey::Pubkey = "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
            .parse()
            .unwrap();
        assert_eq!(AGENT_AUTH_ID, want.to_bytes());
    }

    #[test]
    fn error_codes_round_trip_and_avoid_core_range() {
        for code in ERROR_BASE + 1..=ERROR_BASE + 10 {
            let e = CpiError::from_code(code).unwrap();
            assert_eq!(e.code(), code);
            assert!(!e.as_str().is_empty());
        }
        assert_eq!(CpiError::from_code(0), None);
        assert_eq!(CpiError::from_code(7), None);
        assert_eq!(CpiError::from_code(ERROR_BASE), None);
        assert_eq!(CpiError::from_code(ERROR_BASE + 11), None);
        assert_eq!(CpiError::from_code(u32::MAX), None);
    }
}
