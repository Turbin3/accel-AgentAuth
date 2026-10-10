//! `swap_base_input`: Raydium CP-Swap ABI, constant-product math, 13 behaviour modes.
//!
//! Accounts, in Raydium's order (extra trailing accounts are ignored except by modes that
//! look an attacker/mandate account up among them):
//!
//! | # | Name | Notes |
//! |---|---|---|
//! | 0 | `payer` | signer; authority of the input transfer (the relay's PDA delegate in production use) |
//! | 1 | `authority` | pool authority PDA `["mock_amm_auth"]`; owner of both vaults; signs the output |
//! | 2 | `amm_config` | accepted, unused |
//! | 3 | `pool_state` | owned by this program, 104 bytes |
//! | 4 | `input_token_account` | W |
//! | 5 | `output_token_account` | W |
//! | 6 | `input_vault` | W |
//! | 7 | `output_vault` | W |
//! | 8 | `input_token_program` | Token or Token-2022 |
//! | 9 | `output_token_program` | Token or Token-2022 |
//! | 10 | `input_token_mint` | |
//! | 11 | `output_token_mint` | |
//! | 12 | `observation_state` | W, accepted, unused (fallback `CloseAccount` destination) |

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{create_program_address, Pubkey},
    ProgramResult,
};

use crate::cpi::{self, TransferChecked};
use crate::error::MockAmmError;
use crate::math::amount_out;
use crate::mode::Mode;
use crate::pool::{key_at, PoolState, POOL_AUTHORITY_BUMP, POOL_AUTHORITY_SEED};
use crate::{AGENT_AUTH_ID, RELAY_ID, SWAP_DISC, TOKEN22_ID, TOKEN_ID};

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

struct Swap<'a> {
    all: &'a [AccountInfo],
    payer: &'a AccountInfo,
    authority: &'a AccountInfo,
    in_account: &'a AccountInfo,
    out_account: &'a AccountInfo,
    in_vault: &'a AccountInfo,
    out_vault: &'a AccountInfo,
    in_token_program: &'a AccountInfo,
    out_token_program: &'a AccountInfo,
    in_mint: &'a AccountInfo,
    out_mint: &'a AccountInfo,
    observation: &'a AccountInfo,
    pool: PoolState,
    in_decimals: u8,
    out_decimals: u8,
    in_reserve: u64,
    out_reserve: u64,
}

pub fn swap(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    // `args` is the 16 bytes after the discriminator: amount_in, minimum_amount_out.
    let args: &[u8; 16] = args
        .try_into()
        .map_err(|_| ProgramError::from(MockAmmError::InvalidInstruction))?;
    let amount_in = u64::from_le_bytes([
        args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
    ]);
    let min_out = u64::from_le_bytes([
        args[8], args[9], args[10], args[11], args[12], args[13], args[14], args[15],
    ]);
    if amount_in == 0 {
        return Err(MockAmmError::ZeroAmount.into());
    }

    let s = load(program_id, accounts)?;
    match s.pool.mode {
        Mode::NoopOk => return Ok(()),
        Mode::BurnCpu => return burn_cpu(),
        _ => {}
    }

    // How much is pulled from `in_account`, and which input the output price is computed on.
    let (pull, priced_input) = match s.pool.mode {
        Mode::PullExtra => (
            amount_in
                .checked_add(1)
                .ok_or(MockAmmError::InvalidInstruction)?,
            amount_in,
        ),
        Mode::PullLess => (amount_in / 2, amount_in / 2),
        _ => (amount_in, amount_in),
    };
    let out = if s.pool.mode == Mode::Underpay {
        min_out.saturating_sub(1)
    } else {
        let out = amount_out(s.in_reserve, s.out_reserve, priced_input)
            .ok_or(MockAmmError::InvalidPool)?;
        if out == 0 && priced_input != 0 {
            return Err(MockAmmError::ZeroAmount.into());
        }
        if out < min_out {
            return Err(MockAmmError::ExceededSlippage.into());
        }
        out
    };

    // 1. pull the input, authority = payer (the caller's signature extends into this CPI).
    TransferChecked {
        token_program: s.in_token_program,
        from: s.in_account,
        mint: s.in_mint,
        to: s.in_vault,
        authority: s.payer,
        amount: pull,
        decimals: s.in_decimals,
    }
    .invoke_signed(&[])?;

    // 2. pay the output from the output vault, authority = pool PDA.
    let destination = if s.pool.mode == Mode::RedirectOutput {
        s.in_account
    } else {
        s.out_account
    };
    let bump = [POOL_AUTHORITY_BUMP];
    let seeds = [Seed::from(POOL_AUTHORITY_SEED), Seed::from(&bump)];
    TransferChecked {
        token_program: s.out_token_program,
        from: s.out_vault,
        mint: s.out_mint,
        to: destination,
        authority: s.authority,
        amount: out,
        decimals: s.out_decimals,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    // 3. hostile follow-up, if the mode has one.
    after_swap(program_id, &s, amount_in, min_out)
}

/// Validate every account against the pool and decode what the swap needs.
#[inline(never)]
fn load<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo]) -> Result<Swap<'a>, ProgramError> {
    let [payer, authority, _amm_config, pool_state, in_account, out_account, in_vault, out_vault, in_token_program, out_token_program, in_mint, out_mint, observation, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if pool_state.owner() != program_id {
        return Err(MockAmmError::InvalidPool.into());
    }
    let pool = PoolState::parse(&pool_state.try_borrow_data()?)?;

    let expected_authority =
        create_program_address(&[POOL_AUTHORITY_SEED, &[POOL_AUTHORITY_BUMP]], program_id)
            .map_err(|_| ProgramError::from(MockAmmError::InvalidPool))?;
    if authority.key() != &expected_authority {
        return Err(MockAmmError::InvalidPool.into());
    }
    for tp in [in_token_program, out_token_program] {
        if tp.key() != &TOKEN_ID && tp.key() != &TOKEN22_ID {
            return Err(MockAmmError::InvalidPool.into());
        }
    }
    let in_decimals = mint_decimals(in_mint, in_token_program)?;
    let out_decimals = mint_decimals(out_mint, out_token_program)?;

    // The input and output vaults must be the pool's two vaults, one each.
    let (k_in, k_out) = (in_vault.key(), out_vault.key());
    let paired = (k_in == &pool.vault_0 && k_out == &pool.vault_1)
        || (k_in == &pool.vault_1 && k_out == &pool.vault_0);
    if !paired || k_in == k_out {
        return Err(MockAmmError::InvalidVault.into());
    }
    let in_reserve = vault_reserve(in_vault, in_token_program, in_mint, authority)?;
    let out_reserve = vault_reserve(out_vault, out_token_program, out_mint, authority)?;

    Ok(Swap {
        all: accounts,
        payer,
        authority,
        in_account,
        out_account,
        in_vault,
        out_vault,
        in_token_program,
        out_token_program,
        in_mint,
        out_mint,
        observation,
        pool,
        in_decimals,
        out_decimals,
        in_reserve,
        out_reserve,
    })
}

fn mint_decimals(mint: &AccountInfo, token_program: &AccountInfo) -> Result<u8, ProgramError> {
    if mint.owner() != token_program.key() || mint.data_len() < MINT_LEN {
        return Err(MockAmmError::InvalidPool.into());
    }
    let data = mint.try_borrow_data()?;
    // data_len >= 82 was checked above.
    if data[45] != 1 {
        return Err(MockAmmError::InvalidPool.into());
    }
    Ok(data[44])
}

/// Vault must be an initialised token account of `mint`, owned (token-level) by the pool
/// authority, under `token_program`. Returns its balance.
fn vault_reserve(
    vault: &AccountInfo,
    token_program: &AccountInfo,
    mint: &AccountInfo,
    pool_authority: &AccountInfo,
) -> Result<u64, ProgramError> {
    if vault.owner() != token_program.key() || vault.data_len() < TOKEN_ACCOUNT_LEN {
        return Err(MockAmmError::InvalidVault.into());
    }
    let data = vault.try_borrow_data()?;
    // data_len >= 165 was checked above.
    if data[0..32] != mint.key()[..] || data[32..64] != pool_authority.key()[..] || data[108] != 1 {
        return Err(MockAmmError::InvalidVault.into());
    }
    Ok(u64::from_le_bytes([
        data[64], data[65], data[66], data[67], data[68], data[69], data[70], data[71],
    ]))
}

fn find_account<'a>(accounts: &'a [AccountInfo], key: &Pubkey) -> Option<&'a AccountInfo> {
    accounts.iter().find(|a| a.key() == key)
}

fn burn_cpu() -> ProgramResult {
    let mut x = 0u64;
    loop {
        x = core::hint::black_box(x.wrapping_add(1));
    }
}

/// The attacker action of the modes that have one. Runs after the normal swap has moved tokens.
#[inline(never)]
fn after_swap(program_id: &Pubkey, s: &Swap, amount_in: u64, min_out: u64) -> ProgramResult {
    match s.pool.mode {
        Mode::BurnIn => cpi::burn(s.in_token_program, s.in_account, s.in_mint, s.payer, 1),
        Mode::ApproveAttacker => {
            // The attacker account must be supplied by the caller (extra trailing account).
            // If it is absent, approve `out_account` instead: it is still "someone else's
            // account" and the Token program rejects either way unless `payer` owns `in_account`.
            let delegate = find_account(s.all, &s.pool.aux_key).unwrap_or(s.out_account);
            cpi::approve(
                s.in_token_program,
                s.in_account,
                delegate,
                s.payer,
                u64::MAX,
            )
        }
        Mode::SetAuth => {
            cpi::set_account_owner(s.in_token_program, s.in_account, s.payer, &s.pool.aux_key)
        }
        Mode::CloseAccount => {
            let destination = find_account(s.all, &s.pool.aux_key).unwrap_or(s.observation);
            cpi::close_account(s.in_token_program, s.in_account, destination, s.payer)
        }
        Mode::ReenterRelay => {
            // Relay `swap` (tag 4): amount_in, min_out, deadline = u64::MAX.
            let mut data = [0u8; 25];
            data[0] = 4;
            data[1..9].copy_from_slice(&amount_in.to_le_bytes());
            data[9..17].copy_from_slice(&min_out.to_le_bytes());
            data[17..25].copy_from_slice(&u64::MAX.to_le_bytes());
            cpi::forward(&RELAY_ID, &data, s.all, s.payer)
        }
        Mode::CpiVerify => cpi_verify(program_id, s, amount_in),
        _ => Ok(()),
    }
}

/// CPI AgentAuth `verify` with `aux_key` as the mandate. The callee needs the mandate, its
/// owner and its agent (as a signer) among the accounts it was given; if any is missing the
/// attempt fails with `NotEnoughAccountKeys`. Under the relay none of them is passed.
#[inline(never)]
fn cpi_verify(program_id: &Pubkey, s: &Swap, amount_in: u64) -> ProgramResult {
    use pinocchio::cpi::invoke_signed;
    use pinocchio::instruction::{AccountMeta, Instruction};

    let missing = || ProgramError::NotEnoughAccountKeys;
    let mandate = find_account(s.all, &s.pool.aux_key).ok_or_else(missing)?;
    let (owner_key, agent_key) = {
        let data = mandate.try_borrow_data()?;
        (key_at(&data, 1)?, key_at(&data, 33)?)
    };
    let owner = find_account(s.all, &owner_key).ok_or_else(missing)?;
    let agent = find_account(s.all, &agent_key).ok_or_else(missing)?;

    let mut data = [0u8; 49];
    data[0] = 3;
    data[1..33].copy_from_slice(program_id);
    data[33..41].copy_from_slice(&SWAP_DISC);
    data[41..49].copy_from_slice(&amount_in.to_le_bytes());
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
    invoke_signed::<3>(&ix, &[mandate, owner, agent], &[])
}
