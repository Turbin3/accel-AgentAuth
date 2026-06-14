use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

// TODO(P2): the hot path. Check active + not expired, match program + discriminator,
// enforce per-tx and total spend limits, then bump counters. ~49-byte ABI.
pub fn verify(_program_id: &Pubkey, _accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    unimplemented!("verify: P2")
}
