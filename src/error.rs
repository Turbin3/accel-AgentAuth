use pinocchio::program_error::ProgramError;

// Error codes are part of the contract: callers (and the verify CPI) match on
// these numbers, so don't renumber them without telling the rest of the team.
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
}

impl From<MandateError> for ProgramError {
    fn from(e: MandateError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
