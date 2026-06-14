mod add_permission;
mod create_mandate;
mod remove_permission;
mod revoke_mandate;
mod verify;

pub use add_permission::add_permission;
pub use create_mandate::create_mandate;
pub use remove_permission::remove_permission;
pub use revoke_mandate::revoke_mandate;
pub use verify::verify;

use crate::error::MandateError;

/// First byte of the instruction data selects the handler.
pub enum Instruction {
    CreateMandate,
    AddPermission,
    RemovePermission,
    Verify,
    RevokeMandate,
}

impl Instruction {
    pub fn from_tag(tag: u8) -> Result<Self, MandateError> {
        match tag {
            0 => Ok(Instruction::CreateMandate),
            1 => Ok(Instruction::AddPermission),
            2 => Ok(Instruction::RemovePermission),
            3 => Ok(Instruction::Verify),
            4 => Ok(Instruction::RevokeMandate),
            _ => Err(MandateError::InvalidDiscriminator),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_routes_each_tag() {
        assert!(matches!(Instruction::from_tag(0), Ok(Instruction::CreateMandate)));
        assert!(matches!(Instruction::from_tag(1), Ok(Instruction::AddPermission)));
        assert!(matches!(Instruction::from_tag(2), Ok(Instruction::RemovePermission)));
        assert!(matches!(Instruction::from_tag(3), Ok(Instruction::Verify)));
        assert!(matches!(Instruction::from_tag(4), Ok(Instruction::RevokeMandate)));
        assert!(matches!(
            Instruction::from_tag(5),
            Err(MandateError::InvalidDiscriminator)
        ));
        assert!(matches!(
            Instruction::from_tag(255),
            Err(MandateError::InvalidDiscriminator)
        ));
    }
}
