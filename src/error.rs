//! Stable error codes and the instruction x condition -> code table.
//!
//! The numbers are part of the public contract: integrators and the SDK match
//! on them. Codes 1..=18 are frozen since v0.1; 19.. are appended, never
//! renumbered. Every failure a handler raises on purpose is a `MandateError`
//! (`ProgramError::Custom(code)`); the only built-in errors left are
//! `NotEnoughAccountKeys` (verify, missing accounts) and `InvalidAccountData`
//! (a mandate passed read-only to an instruction that must write it).
//!
//! # Table
//!
//! | condition                                              | code | name                    |
//! |--------------------------------------------------------|------|-------------------------|
//! | unknown instruction tag                                |   1  | `InvalidDiscriminator`  |
//! | signer is not `mandate.owner` / verify owner mismatch  |   2  | `NotOwner`              |
//! | create on an initialised mandate (disc == 1)           |   3  | `AlreadyInitialized`    |
//! | mandate paused (`set_active 0`)                        |   4  | `NotActive`             |
//! | verify at or after `expiry` (now >= expiry)            |   5  | `Expired`               |
//! | verify: no slot for the reported program id            |   6  | `ProgramNotAllowed`     |
//! | verify: discriminator not in the slot's allow-list     |   7  | `DiscriminatorNotAllowed` |
//! | verify: amount > per_tx_limit (limit != 0)             |   8  | `PerTxExceeded`         |
//! | verify: spend_total + amount > spend_limit (limit != 0, an overflowing sum counts as exceeded) | 9 | `SpendLimitExceeded` |
//! | add: 16 slots in use                                   |  10  | `PermissionsFull`       |
//! | add: more than 8 discriminators                        |  11  | `TooManyDiscriminators` |
//! | remove / update: no slot for the program id            |  12  | `PermissionNotFound`    |
//! | revoke: lamport credit to the owner overflows          |  13  | `ArithmeticOverflow`    |
//! | mandate account not owned by this program              |  14  | `AccountOwnerMismatch`  |
//! | wrong data length / wrong number of accounts           |  15  | `InvalidInstructionData`|
//! | wrong discriminator byte, wrong account size, corrupt header, or the mandate address is not the canonical PDA | 16 | `InvalidAccountType` |
//! | verify: agent key != `mandate.agent`                   |  17  | `UnknownAgent`          |
//! | a required signature is missing (owner, or agent in verify) | 18 | `InvalidSigner`     |
//! | create: owner == agent                                 |  19  | `InvalidAgent`          |
//! | create: expiry <= current time                         |  20  | `InvalidExpiry`         |
//! | add: a slot for that program already exists            |  21  | `DuplicatePermission`   |
//! | add: zero discriminators                               |  22  | `EmptyDiscriminators`   |
//!
//! Per instruction, in the order the checks run:
//!
//! * `create_mandate`: accounts (15), owner signs (18), owner != agent (19),
//!   data length (15), PDA address (16), expiry (20), mandate writable
//!   (`InvalidAccountData`), then by the PDA's current owner: other than this
//!   program or System (14); this program: size / discriminator (16 / 3).
//! * `add_permission`, `remove_permission`, `update_permission`, `set_active`:
//!   accounts (15), data length (15), owner signs (18), mandate owned by this
//!   program (14), mandate writable (`InvalidAccountData`), size and
//!   discriminator (16), signer is the mandate owner (2), mandate active (4,
//!   not for `set_active`), then the instruction's own conditions.
//! * `revoke_mandate`: as above up to the owner check; then the PDA address
//!   (16). It does not require the mandate to be active: a paused mandate can
//!   still be revoked.
//! * `verify`: data length (15), accounts (`NotEnoughAccountKeys`), mandate
//!   owned by this program (14), writable (`InvalidAccountData`), size and
//!   discriminator (16), active (4), not expired (5), owner key (2), agent key
//!   (17), agent signs (18), program (6), discriminator (7), per-tx (8),
//!   lifetime (9).

use pinocchio::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MandateError {
    InvalidDiscriminator = 1,
    NotOwner = 2,
    AlreadyInitialized = 3,
    NotActive = 4,
    Expired = 5,
    ProgramNotAllowed = 6,
    DiscriminatorNotAllowed = 7,
    PerTxExceeded = 8,
    SpendLimitExceeded = 9,
    PermissionsFull = 10,
    TooManyDiscriminators = 11,
    PermissionNotFound = 12,
    ArithmeticOverflow = 13,
    AccountOwnerMismatch = 14,
    InvalidInstructionData = 15,
    InvalidAccountType = 16,
    UnknownAgent = 17,
    InvalidSigner = 18,
    InvalidAgent = 19,
    InvalidExpiry = 20,
    DuplicatePermission = 21,
    EmptyDiscriminators = 22,
}

impl From<MandateError> for ProgramError {
    fn from(e: MandateError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
