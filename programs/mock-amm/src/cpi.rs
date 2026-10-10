//! Small CPI helpers. Every helper drops its own borrows before invoking.

use pinocchio::{
    account_info::AccountInfo,
    cpi::{invoke_signed, invoke_signed_with_bounds},
    instruction::{AccountMeta, Instruction, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::MockAmmError;

/// Largest number of accounts `proxy` / `ReenterRelay` forward (the relay swap uses 19).
pub const MAX_FORWARD: usize = 32;

/// Token `TransferChecked` (tag 12). Same layout for Token, p-token and Token-2022.
pub struct TransferChecked<'a> {
    pub token_program: &'a AccountInfo,
    pub from: &'a AccountInfo,
    pub mint: &'a AccountInfo,
    pub to: &'a AccountInfo,
    pub authority: &'a AccountInfo,
    pub amount: u64,
    pub decimals: u8,
}

impl TransferChecked<'_> {
    #[inline(never)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let mut data = [0u8; 10];
        data[0] = 12;
        data[1..9].copy_from_slice(&self.amount.to_le_bytes());
        data[9] = self.decimals;
        let metas = [
            AccountMeta::writable(self.from.key()),
            AccountMeta::readonly(self.mint.key()),
            AccountMeta::writable(self.to.key()),
            AccountMeta::readonly_signer(self.authority.key()),
        ];
        let ix = Instruction {
            program_id: self.token_program.key(),
            accounts: &metas,
            data: &data,
        };
        invoke_signed::<4>(
            &ix,
            &[self.from, self.mint, self.to, self.authority],
            signers,
        )
    }
}

/// Token `Burn` (tag 8) of `amount`, authority = `authority` (owner or delegate).
#[inline(never)]
pub fn burn(
    token_program: &AccountInfo,
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 8;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::writable(mint.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed::<3>(&ix, &[account, mint, authority], &[])
}

/// Token `Approve` (tag 4) of `amount` on `account` to `delegate`, signed by `authority`.
#[inline(never)]
pub fn approve(
    token_program: &AccountInfo,
    account: &AccountInfo,
    delegate: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = 4;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::readonly(delegate.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed::<3>(&ix, &[account, delegate, authority], &[])
}

/// Token `SetAuthority(AccountOwner)` (tag 6, type 2) on `account` to `new_owner`.
#[inline(never)]
pub fn set_account_owner(
    token_program: &AccountInfo,
    account: &AccountInfo,
    authority: &AccountInfo,
    new_owner: &Pubkey,
) -> ProgramResult {
    let mut data = [0u8; 35];
    data[0] = 6;
    data[1] = 2; // AuthorityType::AccountOwner
    data[2] = 1; // COption::Some
    data[3..35].copy_from_slice(new_owner);
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed::<2>(&ix, &[account, authority], &[])
}

/// Token `CloseAccount` (tag 9): lamports go to `destination`.
#[inline(never)]
pub fn close_account(
    token_program: &AccountInfo,
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let data = [9u8];
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let ix = Instruction {
        program_id: token_program.key(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed::<3>(&ix, &[account, destination, authority], &[])
}

/// CPI `program` with `data` and every account in `accounts`, keeping each account's
/// signer/writable flags exactly as this instruction received them. `fill` only pads the
/// fixed-size scratch arrays and is never passed to the callee.
#[inline(never)]
pub fn forward(
    program: &Pubkey,
    data: &[u8],
    accounts: &[AccountInfo],
    fill: &AccountInfo,
) -> ProgramResult {
    let n = accounts.len();
    if n > MAX_FORWARD {
        return Err(MockAmmError::InvalidInstruction.into());
    }
    let metas: [AccountMeta; MAX_FORWARD] = core::array::from_fn(|i| {
        accounts
            .get(i)
            .map(AccountMeta::from)
            .unwrap_or_else(|| AccountMeta::readonly(fill.key()))
    });
    let infos: [&AccountInfo; MAX_FORWARD] =
        core::array::from_fn(|i| accounts.get(i).unwrap_or(fill));
    let ix = Instruction {
        program_id: program,
        accounts: metas.get(..n).ok_or(ProgramError::InvalidArgument)?,
        data,
    };
    invoke_signed_with_bounds::<MAX_FORWARD>(
        &ix,
        infos.get(..n).ok_or(ProgramError::InvalidArgument)?,
        &[],
    )
}
