use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

// TODO(P4): owner-only; find the permission for a program and swap-remove it.
pub fn remove_permission(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    unimplemented!("remove_permission: P4")
}
