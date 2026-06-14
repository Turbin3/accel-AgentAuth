use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

// TODO(P3): owner-only; append a permission slot for a target program + limits.
pub fn add_permission(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    unimplemented!("add_permission: P3")
}
