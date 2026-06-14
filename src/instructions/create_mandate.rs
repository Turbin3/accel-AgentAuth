use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

// TODO(P3): create + init the mandate PDA, write owner/agent/expiry, mark active.
pub fn create_mandate(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    unimplemented!("create_mandate: P3")
}
