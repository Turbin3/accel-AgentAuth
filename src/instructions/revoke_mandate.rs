use pinocchio::{ProgramResult, account_info::AccountInfo, pubkey::{Pubkey}};

// TODO(P4): owner-only; flip active to false so every later verify fails.
pub fn revoke_mandate(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {

    unimplemented!("revoke_mandate: P4")

}
