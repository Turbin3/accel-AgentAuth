//! # evil-token: TEST-ONLY Token program stub that misbehaves
//!
//! **NEVER DEPLOY.** It is installed by LiteSVM tests at the SPL Token program id so that the
//! AgentAuth Relay's post-CPI checks (exact balance deltas, owner-side invariants) can be proven
//! against a Token program that lies. On a cluster the Token program id belongs to the real
//! Token program, so this binary can never take its place.
//!
//! It implements exactly one instruction, `TransferChecked` (tag 12, 10 bytes of data,
//! accounts `[source W, mint R, destination W, authority S]`), by editing token-account bytes
//! directly. The behaviour is selected by `mint.data[81]` (the last byte of the freeze-authority
//! key, unused by the real layout when the mint has no freeze authority):
//!
//! | `mint.data[81]` | Name | Effect |
//! |---|---|---|
//! | 0 | HONEST | like the real Token program for the cases the relay uses (owner or delegate authority, delegate allowance decremented, delegate tag cleared at 0) |
//! | 1 | MOVE_PLUS_ONE | source debited `amount + 1`, destination credited `amount` |
//! | 2 | CREDIT_MINUS_ONE | source debited `amount`, destination credited `amount - 1` |
//! | 3 | RAISE_SOURCE | source first credited `amount + 1`, then debited `amount` (net +1) |
//! | 4 | REWRITE_CLOSE_AUTH | honest transfer, then `close_authority` of the source is set to the signing authority |
//!
//! Every other instruction fails with `InvalidInstructionData`. There is no mint or account
//! initialisation: tests place accounts with `set_account`.
//!
//! ## `proxy` (wrapper, not a Token feature)
//!
//! Data `FF 70 72 6F 78 79 00 00` + inner instruction data; accounts `[program, ...rest]`; the
//! program invokes `program` with every account of `rest`, keeping their signer/writable flags.
//! It exists so tests can wrap the relay in a program that is NOT the pinned AMM (the mock AMM's
//! own `proxy` cannot wrap a `swap` because the relay would then call the mock AMM again, an
//! A -> B -> A re-entry that the runtime rejects). Load a second copy of `evil_token.so` at any
//! unrelated program id to use it; at the Token id the stub keeps behaving as a Token program.
#![cfg_attr(target_os = "solana", no_std)]

use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke_signed_with_bounds,
    instruction::{AccountMeta, Instruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

#[cfg(target_os = "solana")]
mod entry {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// SPL Token `TransferChecked` instruction tag.
pub const TRANSFER_CHECKED_TAG: u8 = 12;

/// `proxy` discriminator (same bytes as the mock AMM's `proxy`).
pub const PROXY_DISC: [u8; 8] = [0xFF, 0x70, 0x72, 0x6F, 0x78, 0x79, 0x00, 0x00];
/// Most accounts `proxy` forwards (the relay `swap` uses 19).
const MAX_FORWARD: usize = 24;

/// Misbehaviour selectors (`mint.data[81]`).
pub mod mode {
    pub const HONEST: u8 = 0;
    pub const MOVE_PLUS_ONE: u8 = 1;
    pub const CREDIT_MINUS_ONE: u8 = 2;
    pub const RAISE_SOURCE: u8 = 3;
    pub const REWRITE_CLOSE_AUTH: u8 = 4;
}

/// Index of the mode byte inside the mint account data.
pub const MODE_OFFSET: usize = 81;

// SPL Token account layout (165 bytes).
const OFF_MINT: usize = 0;
const OFF_OWNER: usize = 32;
const OFF_AMOUNT: usize = 64;
const OFF_DELEGATE_TAG: usize = 72;
const OFF_DELEGATE: usize = 76;
const OFF_STATE: usize = 108;
const OFF_DELEGATED: usize = 121;
const OFF_CLOSE_TAG: usize = 129;
const OFF_CLOSE: usize = 133;
const ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

// SPL Token error numbers reused so tests can tell this stub apart from the relay: the
// numbers are the real Token ones (InsufficientFunds 1, MintMismatch 3, OwnerMismatch 4).
const ERR_INSUFFICIENT_FUNDS: u32 = 1;
const ERR_MINT_MISMATCH: u32 = 3;
const ERR_OWNER_MISMATCH: u32 = 4;

fn u64_at(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() >= 8 && data[..8] == PROXY_DISC {
        return proxy(accounts, &data[8..]);
    }
    if data.len() != 10 || data[0] != TRANSFER_CHECKED_TAG {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64_at(data, 1);
    let [source, mint, destination, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    for a in [source, mint, destination] {
        if a.owner() != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
    }
    if source.key() == destination.key() {
        return Err(ProgramError::InvalidArgument);
    }
    let evil = {
        let m = mint.try_borrow_data()?;
        if m.len() < MINT_LEN || m[45] != 1 {
            return Err(ProgramError::UninitializedAccount);
        }
        if m[44] != data[9] {
            return Err(ProgramError::InvalidInstructionData);
        }
        m[MODE_OFFSET]
    };

    let mut src = source.try_borrow_mut_data()?;
    let mut dst = destination.try_borrow_mut_data()?;
    if src.len() < ACCOUNT_LEN || dst.len() < ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if src[OFF_MINT..OFF_MINT + 32] != mint.key()[..]
        || dst[OFF_MINT..OFF_MINT + 32] != mint.key()[..]
    {
        return Err(ProgramError::Custom(ERR_MINT_MISMATCH));
    }
    if src[OFF_STATE] != 1 || dst[OFF_STATE] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Authority: the account owner, or the delegate within delegated_amount.
    if src[OFF_OWNER..OFF_OWNER + 32] != authority.key()[..] {
        let is_delegate = src[OFF_DELEGATE_TAG] == 1
            && src[OFF_DELEGATE..OFF_DELEGATE + 32] == authority.key()[..];
        let delegated = u64_at(&src, OFF_DELEGATED);
        if !is_delegate || delegated < amount {
            return Err(ProgramError::Custom(ERR_OWNER_MISMATCH));
        }
        let left = delegated - amount;
        src[OFF_DELEGATED..OFF_DELEGATED + 8].copy_from_slice(&left.to_le_bytes());
        if left == 0 {
            // Like the real program: only the COption tag is cleared.
            src[OFF_DELEGATE_TAG..OFF_DELEGATE_TAG + 4].copy_from_slice(&0u32.to_le_bytes());
        }
    }

    let debit = if evil == mode::MOVE_PLUS_ONE {
        amount.checked_add(1).ok_or(ProgramError::InvalidArgument)?
    } else {
        amount
    };
    let credit = if evil == mode::CREDIT_MINUS_ONE {
        amount.saturating_sub(1)
    } else {
        amount
    };

    let mut balance = u64_at(&src, OFF_AMOUNT);
    if evil == mode::RAISE_SOURCE {
        balance = balance
            .checked_add(amount.saturating_add(1))
            .ok_or(ProgramError::InvalidArgument)?;
    }
    let balance = balance
        .checked_sub(debit)
        .ok_or(ProgramError::Custom(ERR_INSUFFICIENT_FUNDS))?;
    src[OFF_AMOUNT..OFF_AMOUNT + 8].copy_from_slice(&balance.to_le_bytes());
    let dest_balance = u64_at(&dst, OFF_AMOUNT)
        .checked_add(credit)
        .ok_or(ProgramError::InvalidArgument)?;
    dst[OFF_AMOUNT..OFF_AMOUNT + 8].copy_from_slice(&dest_balance.to_le_bytes());

    if evil == mode::REWRITE_CLOSE_AUTH {
        src[OFF_CLOSE_TAG..OFF_CLOSE_TAG + 4].copy_from_slice(&1u32.to_le_bytes());
        src[OFF_CLOSE..OFF_CLOSE + 32].copy_from_slice(authority.key());
    }
    Ok(())
}

#[inline(never)]
fn proxy(accounts: &[AccountInfo], inner_data: &[u8]) -> ProgramResult {
    let (program, rest) = accounts
        .split_first()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let n = rest.len();
    if n > MAX_FORWARD {
        return Err(ProgramError::InvalidArgument);
    }
    let metas: [AccountMeta; MAX_FORWARD] = core::array::from_fn(|i| {
        rest.get(i)
            .map(AccountMeta::from)
            .unwrap_or_else(|| AccountMeta::readonly(program.key()))
    });
    let infos: [&AccountInfo; MAX_FORWARD] =
        core::array::from_fn(|i| rest.get(i).unwrap_or(program));
    let ix = Instruction {
        program_id: program.key(),
        accounts: metas.get(..n).ok_or(ProgramError::InvalidArgument)?,
        data: inner_data,
    };
    invoke_signed_with_bounds::<MAX_FORWARD>(
        &ix,
        infos.get(..n).ok_or(ProgramError::InvalidArgument)?,
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_bytes_match_the_spec() {
        assert_eq!(MODE_OFFSET, 81);
        assert_eq!(
            [
                mode::HONEST,
                mode::MOVE_PLUS_ONE,
                mode::CREDIT_MINUS_ONE,
                mode::RAISE_SOURCE,
                mode::REWRITE_CLOSE_AUTH
            ],
            [0, 1, 2, 3, 4]
        );
    }
}
