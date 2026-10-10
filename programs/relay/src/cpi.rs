//! The relay's cross-program invocations into AgentAuth and the SPL Token
//! program (the swap CPI lives with its handler in [`crate::ix::swap`]).
//!
//! All CPIs use `invoke_signed_with_bounds` with the smallest account bound,
//! to keep the 4096-byte SBF stack frame small, and are `#[inline(never)]`
//! for the same reason. Callers must have dropped every data borrow of the
//! passed accounts: Pinocchio 0.9.3 fails with `AccountBorrowFailed` otherwise.

use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke_signed_with_bounds,
    instruction::{AccountMeta, Instruction, Seed, Signer},
    pubkey::Pubkey,
    ProgramResult,
};

use crate::ids::{AGENT_AUTH_ID, AUTHORITY_SEED, SPL_TRANSFER_CHECKED_TAG, VERIFY_TAG};

/// Length of the `verify` instruction data: tag + program + disc8 + amount.
pub const VERIFY_DATA_LEN: usize = 49;
/// Length of the SPL `TransferChecked` instruction data.
pub const TRANSFER_CHECKED_DATA_LEN: usize = 10;

/// `verify` instruction data (locked ABI, RELAY-SPEC section 8):
/// `[3] + target_program_id[32] + disc8[8] + amount u64 LE`.
pub fn verify_data(target: &Pubkey, disc: &[u8; 8], amount: u64) -> [u8; VERIFY_DATA_LEN] {
    let mut d = [0u8; VERIFY_DATA_LEN];
    d[0] = VERIFY_TAG;
    d[1..33].copy_from_slice(target);
    d[33..41].copy_from_slice(disc);
    d[41..49].copy_from_slice(&amount.to_le_bytes());
    d
}

/// SPL `TransferChecked` instruction data: `[12] + amount u64 LE + decimals`.
pub fn transfer_checked_data(amount: u64, decimals: u8) -> [u8; TRANSFER_CHECKED_DATA_LEN] {
    let mut d = [0u8; TRANSFER_CHECKED_DATA_LEN];
    d[0] = SPL_TRANSFER_CHECKED_TAG;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d[9] = decimals;
    d
}

/// CPI to the compiled AgentAuth id: `verify(target, disc, amount)` with
/// accounts `[mandate W, owner R, agent R+S]`. The agent's signature extends
/// from the outer instruction; no signer seeds are used. The AgentAuth
/// program account must be in the outer instruction's accounts (the handlers
/// require it, pinned to [`AGENT_AUTH_ID`]).
#[inline(never)]
pub fn verify(
    mandate: &AccountInfo,
    owner: &AccountInfo,
    agent: &AccountInfo,
    target: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> ProgramResult {
    let data = verify_data(target, disc, amount);
    let metas = [
        AccountMeta::writable(mandate.key()),
        AccountMeta::readonly(owner.key()),
        AccountMeta::readonly_signer(agent.key()),
    ];
    let ix = Instruction {
        program_id: &AGENT_AUTH_ID,
        accounts: &metas,
        data: &data,
    };
    invoke_signed_with_bounds::<3>(&ix, &[mandate, owner, agent], &[])
}

/// Accounts of the `TransferChecked` CPI.
pub struct TransferChecked<'a> {
    /// SPL Token or Token-2022 program.
    pub token_program: &'a AccountInfo,
    /// Source token account (writable).
    pub source: &'a AccountInfo,
    /// Mint (read-only).
    pub mint: &'a AccountInfo,
    /// Destination token account (writable).
    pub destination: &'a AccountInfo,
    /// Authority PDA, the SPL delegate; signs with the stored bump.
    pub authority: &'a AccountInfo,
    /// Mandate key, the second seed of the authority PDA.
    pub mandate: &'a Pubkey,
    /// Stored authority bump.
    pub authority_bump: u8,
}

/// CPI: SPL `TransferChecked` signed by the authority PDA
/// (`["authority", mandate, bump]`).
#[inline(never)]
pub fn transfer_checked(t: &TransferChecked, amount: u64, decimals: u8) -> ProgramResult {
    let data = transfer_checked_data(amount, decimals);
    let metas = [
        AccountMeta::writable(t.source.key()),
        AccountMeta::readonly(t.mint.key()),
        AccountMeta::writable(t.destination.key()),
        AccountMeta::readonly_signer(t.authority.key()),
    ];
    let ix = Instruction {
        program_id: t.token_program.key(),
        accounts: &metas,
        data: &data,
    };
    let bump = [t.authority_bump];
    let seeds = [
        Seed::from(AUTHORITY_SEED),
        Seed::from(t.mandate),
        Seed::from(&bump),
    ];
    let signer = Signer::from(&seeds);
    invoke_signed_with_bounds::<4>(
        &ix,
        &[t.source, t.mint, t.destination, t.authority],
        &[signer],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FE-07 (Rust half): matches `golden/verify_ix_data.hex`.
    #[test]
    fn verify_data_matches_golden() {
        let token = [
            0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb,
            0x79, 0xac, 0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85,
            0x7e, 0xff, 0x00, 0xa9,
        ];
        let d = verify_data(&token, &crate::ids::TRANSFER_CHECKED_DISC, 3_000_000);
        let golden = "0306ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a90c00000000000000c0c62d0000000000";
        assert_eq!(hex(&d), golden);
    }

    #[test]
    fn transfer_checked_layout() {
        let d = transfer_checked_data(0x0102_0304_0506_0708, 6);
        assert_eq!(d[0], 12);
        assert_eq!(&d[1..9], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert_eq!(d[9], 6);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
