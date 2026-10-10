//! `4 swap` - RELAY-SPEC section 7.5.
//!
//! One exact-in swap on the single pool pinned in the policy, through the
//! Raydium CP-Swap `swap_base_input` ABI. The output is forced into the owner's
//! own pinned account and the owner-set floor price is enforced regardless of
//! the agent's `min_out`. Every post-condition (balances, owner program, owner
//! field, delegate, close authority of both accounts) is checked on fresh
//! reads after the AMM returns.
//!
//! Data `[4] + amount_in u64 + min_out u64 + deadline_slot u64` (25 bytes);
//! accounts (exactly 19) in the order of [`SwapAccounts`].

use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke_signed_with_bounds,
    instruction::{AccountMeta, Instruction, Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::bytes::{same_key, u64_at};
use crate::checks::{check_actors, Actors};
use crate::cpi;
use crate::error::RelayError;
use crate::events;
use crate::ids::{amm_allowed, is_token_program, AUTHORITY_SEED, SWAP_DISC};
use crate::math::effective_min_out;
use crate::state::Config;
use crate::token::{check_mint, token_acct_ok, Snapshot, TokenAcct};

/// Total `swap` data length: tag + amount_in + min_out + deadline_slot.
pub const SWAP_DATA_LEN: usize = 25;
/// Number of accounts `swap` takes.
pub const SWAP_ACCOUNTS: usize = 19;

/// The 19 accounts of `swap`, in instruction order (RELAY-SPEC 7.5).
pub struct SwapAccounts<'a> {
    /// 0: agent (signer).
    pub agent: &'a AccountInfo,
    /// 1: AgentAuth mandate (writable).
    pub mandate: &'a AccountInfo,
    /// 2: owner.
    pub owner: &'a AccountInfo,
    /// 3: relay policy PDA.
    pub policy: &'a AccountInfo,
    /// 4: authority PDA (passed to the AMM as `payer`).
    pub authority: &'a AccountInfo,
    /// 5: owner's input token account (writable).
    pub in_account: &'a AccountInfo,
    /// 6: owner's output token account (writable).
    pub out_account: &'a AccountInfo,
    /// 7: AMM program.
    pub amm_program: &'a AccountInfo,
    /// 8: AMM pool authority.
    pub amm_authority: &'a AccountInfo,
    /// 9: AMM config.
    pub amm_config: &'a AccountInfo,
    /// 10: pool state (writable).
    pub pool_state: &'a AccountInfo,
    /// 11: input vault (writable).
    pub input_vault: &'a AccountInfo,
    /// 12: output vault (writable).
    pub output_vault: &'a AccountInfo,
    /// 13: input token program.
    pub in_token_program: &'a AccountInfo,
    /// 14: output token program.
    pub out_token_program: &'a AccountInfo,
    /// 15: input mint.
    pub in_mint: &'a AccountInfo,
    /// 16: output mint.
    pub out_mint: &'a AccountInfo,
    /// 17: observation state (writable).
    pub observation_state: &'a AccountInfo,
    /// 18: AgentAuth program.
    pub agentauth_program: &'a AccountInfo,
}

impl<'a> SwapAccounts<'a> {
    /// Destructure exactly 19 accounts; any other count is `NotEnoughAccountKeys`.
    pub fn parse(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        let [agent, mandate, owner, policy, authority, in_account, out_account, amm_program, amm_authority, amm_config, pool_state, input_vault, output_vault, in_token_program, out_token_program, in_mint, out_mint, observation_state, agentauth_program] =
            accounts
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        Ok(Self {
            agent,
            mandate,
            owner,
            policy,
            authority,
            in_account,
            out_account,
            amm_program,
            amm_authority,
            amm_config,
            pool_state,
            input_vault,
            output_vault,
            in_token_program,
            out_token_program,
            in_mint,
            out_mint,
            observation_state,
            agentauth_program,
        })
    }

    fn actors(&self) -> Actors<'a> {
        Actors {
            agent: self.agent,
            mandate: self.mandate,
            owner: self.owner,
            policy: self.policy,
            authority: self.authority,
            agentauth_program: self.agentauth_program,
        }
    }
}

/// Parsed instruction data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapArgs {
    /// Exact input amount.
    pub amount_in: u64,
    /// Agent-chosen minimum output (can only raise the owner's floor).
    pub min_out: u64,
    /// Last slot at which the swap may land.
    pub deadline_slot: u64,
}

/// Step 1: exact length, non-zero `amount_in` (100).
pub fn parse_args(data: &[u8]) -> Result<SwapArgs, ProgramError> {
    if data.len() != SWAP_DATA_LEN {
        return Err(RelayError::InvalidInstructionData.into());
    }
    let args = SwapArgs {
        amount_in: u64_at(data, 1),
        min_out: u64_at(data, 9),
        deadline_slot: u64_at(data, 17),
    };
    if args.amount_in == 0 {
        return Err(RelayError::InvalidInstructionData.into());
    }
    Ok(args)
}

/// Step 11: `slot <= deadline` and `deadline - slot <= max_deadline_slots` (111).
pub fn check_deadline(slot: u64, deadline: u64, max_slots: u32) -> Result<(), RelayError> {
    match deadline.checked_sub(slot) {
        Some(left) if left <= u64::from(max_slots) => Ok(()),
        _ => Err(RelayError::DeadlineExpired),
    }
}

/// Values produced by the pre-flight and consumed after the CPIs.
struct Pre {
    authority_bump: u8,
    eff_min: u64,
    in_before: Snapshot,
    out_before: Snapshot,
}

/// Handler for `swap`. `data` is the full instruction data (tag included).
pub fn swap(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let args = parse_args(data)?;
    let a = SwapAccounts::parse(accounts)?;

    // Every borrow taken in `preflight` is dropped when it returns.
    let pre = preflight(program_id, &a, &args)?;

    cpi::verify(
        a.mandate,
        a.owner,
        a.agent,
        a.amm_program.key(),
        &SWAP_DISC,
        args.amount_in,
    )?;
    swap_cpi(&a, pre.authority_bump, args.amount_in, pre.eff_min)?;

    let (in_delta, out_delta) = postcheck(&a, &pre, args.amount_in)?;
    events::emit_swap(
        a.mandate.key(),
        a.pool_state.key(),
        args.amount_in,
        in_delta,
        out_delta,
    );
    Ok(())
}

/// Steps 3 to 16: every check that precedes the first CPI.
#[inline(never)]
fn preflight(program_id: &Pubkey, a: &SwapAccounts, args: &SwapArgs) -> Result<Pre, ProgramError> {
    let policy_data = a.policy.try_borrow_data()?;
    let mandate_data = a.mandate.try_borrow_data()?;
    let p = check_actors(program_id, &a.actors(), &policy_data, &mandate_data)?;
    let cfg = p.config();

    // Step 10: swap enabled.
    if cfg.swap_enabled() != 1 {
        return Err(RelayError::SwapDisabled.into());
    }

    // Step 11: deadline window.
    let slot = Clock::get()?.slot;
    check_deadline(slot, args.deadline_slot, cfg.max_deadline_slots())?;

    // Step 12: every pinned key, then the AMM and token programs.
    check_pins(a, &cfg)?;
    if !a.amm_program.executable() || !amm_allowed(a.amm_program.key()) {
        return Err(RelayError::WrongProgram.into());
    }
    if !is_token_program(a.in_token_program.key()) || !is_token_program(a.out_token_program.key()) {
        return Err(RelayError::WrongProgram.into());
    }

    // Step 13: mints.
    check_mint(a.in_mint, a.in_token_program.key())?;
    check_mint(a.out_mint, a.out_token_program.key())?;

    // Step 14: input account, delegated to the authority PDA.
    let in_before = {
        let d = token_acct_ok(a.in_account, a.in_token_program.key())?;
        let t = TokenAcct(&d);
        if t.mint() != cfg.in_mint()
            || t.owner() != p.owner()
            || !t.delegate_is(a.authority.key())
            || t.delegated_amount() < args.amount_in
            || t.amount() < args.amount_in
        {
            return Err(RelayError::TokenAccountState.into());
        }
        Snapshot::take(a.in_account.owner(), a.in_account.data_len(), &d)
    };

    // Step 15: output account must be the owner's own.
    let out_before = {
        let d = token_acct_ok(a.out_account, a.out_token_program.key())?;
        let t = TokenAcct(&d);
        if t.mint() != cfg.out_mint() || t.owner() != p.owner() {
            return Err(RelayError::TokenAccountState.into());
        }
        Snapshot::take(a.out_account.owner(), a.out_account.data_len(), &d)
    };

    // Step 16: owner floor, in u128; the agent can only raise it.
    let eff_min = effective_min_out(
        args.amount_in,
        args.min_out,
        cfg.floor_out(),
        cfg.floor_in(),
    )?;

    Ok(Pre {
        authority_bump: p.authority_bump(),
        eff_min,
        in_before,
        out_before,
    })
}

/// Step 12 (first half): every pinned account key equals the policy field (102).
fn check_pins(a: &SwapAccounts, cfg: &Config) -> Result<(), RelayError> {
    let pinned = [
        (a.in_account.key(), cfg.in_account()),
        (a.out_account.key(), cfg.out_account()),
        (a.amm_program.key(), cfg.amm_program()),
        (a.amm_authority.key(), cfg.amm_authority()),
        (a.amm_config.key(), cfg.amm_config()),
        (a.pool_state.key(), cfg.pool_state()),
        (a.input_vault.key(), cfg.input_vault()),
        (a.output_vault.key(), cfg.output_vault()),
        (a.in_token_program.key(), cfg.in_token_program()),
        (a.out_token_program.key(), cfg.out_token_program()),
        (a.in_mint.key(), cfg.in_mint()),
        (a.out_mint.key(), cfg.out_mint()),
        (a.observation_state.key(), cfg.observation_state()),
    ];
    if pinned.iter().all(|(passed, pin)| same_key(passed, pin)) {
        Ok(())
    } else {
        Err(RelayError::AccountMismatch)
    }
}

/// Raydium CP-Swap `swap_base_input` instruction data:
/// `SWAP_DISC + amount_in + minimum_amount_out`.
pub fn swap_data(amount_in: u64, min_out: u64) -> [u8; 24] {
    let mut d = [0u8; 24];
    d[0..8].copy_from_slice(&SWAP_DISC);
    d[8..16].copy_from_slice(&amount_in.to_le_bytes());
    d[16..24].copy_from_slice(&min_out.to_le_bytes());
    d
}

/// Step 18: the AMM CPI in the Raydium CP-Swap account order; the authority
/// PDA is the `payer` signer.
#[inline(never)]
fn swap_cpi(a: &SwapAccounts, authority_bump: u8, amount_in: u64, eff_min: u64) -> ProgramResult {
    let data = swap_data(amount_in, eff_min);
    let metas = [
        AccountMeta::readonly_signer(a.authority.key()),
        AccountMeta::readonly(a.amm_authority.key()),
        AccountMeta::readonly(a.amm_config.key()),
        AccountMeta::writable(a.pool_state.key()),
        AccountMeta::writable(a.in_account.key()),
        AccountMeta::writable(a.out_account.key()),
        AccountMeta::writable(a.input_vault.key()),
        AccountMeta::writable(a.output_vault.key()),
        AccountMeta::readonly(a.in_token_program.key()),
        AccountMeta::readonly(a.out_token_program.key()),
        AccountMeta::readonly(a.in_mint.key()),
        AccountMeta::readonly(a.out_mint.key()),
        AccountMeta::writable(a.observation_state.key()),
    ];
    let ix = Instruction {
        program_id: a.amm_program.key(),
        accounts: &metas,
        data: &data,
    };
    let bump = [authority_bump];
    let seeds = [
        Seed::from(AUTHORITY_SEED),
        Seed::from(a.mandate.key()),
        Seed::from(&bump),
    ];
    let signer = Signer::from(&seeds);
    invoke_signed_with_bounds::<13>(
        &ix,
        &[
            a.authority,
            a.amm_authority,
            a.amm_config,
            a.pool_state,
            a.in_account,
            a.out_account,
            a.input_vault,
            a.output_vault,
            a.in_token_program,
            a.out_token_program,
            a.in_mint,
            a.out_mint,
            a.observation_state,
        ],
        &[signer],
    )
}

/// Fresh snapshot of a token account after the CPI.
fn snapshot_now(acct: &AccountInfo) -> Result<Snapshot, ProgramError> {
    let d = acct.try_borrow_data()?;
    Ok(Snapshot::take(acct.owner(), acct.data_len(), &d))
}

/// Pure post-condition check (RELAY-SPEC 7.5 step 19), in the specified order:
/// input fell by at most `amount_in` (106); output rose by at least `eff_min`
/// (112); both accounts keep their owner-side invariants and the input
/// delegation fell by at most `amount_in` (119). Returns `(in_delta, out_delta)`.
pub fn check_post(
    pre_in: &Snapshot,
    pre_out: &Snapshot,
    post_in: &Snapshot,
    post_out: &Snapshot,
    amount_in: u64,
    eff_min: u64,
) -> Result<(u64, u64), RelayError> {
    let in_delta = pre_in
        .amount
        .checked_sub(post_in.amount)
        .filter(|d| *d <= amount_in)
        .ok_or(RelayError::BalanceDeltaViolation)?;
    let out_delta = post_out
        .amount
        .checked_sub(pre_out.amount)
        .filter(|d| *d >= eff_min)
        .ok_or(RelayError::SlippageFloorViolated)?;
    let delegated_ok = pre_in
        .delegated
        .checked_sub(post_in.delegated)
        .is_some_and(|d| d <= amount_in);
    if !pre_in.invariants_hold(post_in, true)
        || !pre_out.invariants_hold(post_out, false)
        || !delegated_ok
    {
        return Err(RelayError::AccountInvariantViolated);
    }
    Ok((in_delta, out_delta))
}

/// Step 19: reload both accounts and apply [`check_post`].
#[inline(never)]
fn postcheck(a: &SwapAccounts, pre: &Pre, amount_in: u64) -> Result<(u64, u64), ProgramError> {
    let post_in = snapshot_now(a.in_account)?;
    let post_out = snapshot_now(a.out_account)?;
    check_post(
        &pre.in_before,
        &pre.out_before,
        &post_in,
        &post_out,
        amount_in,
        pre.eff_min,
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::TOKEN_ID;

    #[test]
    fn args_match_golden_swap_vector() {
        // golden/swap_ix_data.hex: 04 404b4c0000000000 0000000000000000 15cd5b0700000000
        let data = [
            0x04, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x15, 0xcd, 0x5b, 0x07,
            0, 0, 0, 0,
        ];
        assert_eq!(
            parse_args(&data).ok(),
            Some(SwapArgs {
                amount_in: 5_000_000,
                min_out: 0,
                deadline_slot: 123_456_789,
            })
        );
    }

    #[test]
    fn args_reject_bad_length_and_zero_amount() {
        let ok = [
            4u8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert!(parse_args(&ok).is_ok());
        assert!(parse_args(&ok[..24]).is_err());
        let mut zero = ok;
        zero[1] = 0;
        assert_eq!(parse_args(&zero).err(), Some(ProgramError::Custom(100)));
    }

    /// SW-08: both boundaries are inclusive; one past either is 111.
    #[test]
    fn deadline_window() {
        assert_eq!(check_deadline(100, 100, 150), Ok(()));
        assert_eq!(check_deadline(100, 250, 150), Ok(()));
        assert_eq!(
            check_deadline(100, 251, 150),
            Err(RelayError::DeadlineExpired)
        );
        assert_eq!(
            check_deadline(100, 99, 150),
            Err(RelayError::DeadlineExpired)
        );
        assert_eq!(
            check_deadline(0, u64::MAX, 9000),
            Err(RelayError::DeadlineExpired)
        );
    }

    #[test]
    fn swap_data_layout() {
        let d = swap_data(5, 7);
        assert_eq!(&d[..8], &SWAP_DISC);
        assert_eq!(&d[8..16], &5u64.to_le_bytes());
        assert_eq!(&d[16..], &7u64.to_le_bytes());
    }

    fn snap(amount: u64, delegated: u64) -> Snapshot {
        Snapshot {
            owner_program: TOKEN_ID,
            data_len: 165,
            owner_field: [2; 32],
            state: 1,
            delegate_raw: {
                let mut r = [0u8; 36];
                r[0] = 1;
                r[4..].copy_from_slice(&[3; 32]);
                r
            },
            close_raw: [0; 36],
            amount,
            delegated,
        }
    }

    #[test]
    fn post_happy_path() {
        let r = check_post(
            &snap(1000, 1000),
            &snap(0, 0),
            &snap(900, 900),
            &snap(95, 0),
            100,
            95,
        );
        assert_eq!(r, Ok((100, 95)));
    }

    /// PULL_LESS style: pulling less than requested is allowed.
    #[test]
    fn post_allows_pulling_less() {
        let r = check_post(
            &snap(1000, 1000),
            &snap(0, 0),
            &snap(950, 950),
            &snap(95, 0),
            100,
            95,
        );
        assert_eq!(r, Ok((50, 95)));
    }

    #[test]
    fn post_error_codes_and_order() {
        let (i0, o0) = (snap(1000, 1000), snap(0, 0));
        // RE-01 / RE-02: pulled more than amount_in.
        assert_eq!(
            check_post(&i0, &o0, &snap(899, 899), &snap(95, 0), 100, 95),
            Err(RelayError::BalanceDeltaViolation)
        );
        // Input balance rose (checked subtraction fails).
        assert_eq!(
            check_post(&i0, &o0, &snap(1001, 1000), &snap(95, 0), 100, 95),
            Err(RelayError::BalanceDeltaViolation)
        );
        // RE-07 / RE-08: under-delivery.
        assert_eq!(
            check_post(&i0, &o0, &snap(900, 900), &snap(94, 0), 100, 95),
            Err(RelayError::SlippageFloorViolated)
        );
        // Output balance fell.
        assert_eq!(
            check_post(&i0, &snap(10, 0), &snap(900, 900), &snap(9, 0), 100, 0),
            Err(RelayError::SlippageFloorViolated)
        );
        // Delegation fell by more than amount_in while the balance did not.
        assert_eq!(
            check_post(&i0, &o0, &snap(900, 800), &snap(95, 0), 100, 95),
            Err(RelayError::AccountInvariantViolated)
        );
        // Delegation increased.
        assert_eq!(
            check_post(&i0, &o0, &snap(900, 1001), &snap(95, 0), 100, 95),
            Err(RelayError::AccountInvariantViolated)
        );
        // RE-13: close authority rewritten on the output account.
        let mut bad_out = snap(95, 0);
        bad_out.close_raw[0] = 1;
        assert_eq!(
            check_post(&i0, &o0, &snap(900, 900), &bad_out, 100, 95),
            Err(RelayError::AccountInvariantViolated)
        );
        // Delegate set on the output account.
        let mut bad_out = snap(95, 0);
        bad_out.delegate_raw[4] ^= 1;
        assert_eq!(
            check_post(&i0, &o0, &snap(900, 900), &bad_out, 100, 95),
            Err(RelayError::AccountInvariantViolated)
        );
    }

    #[test]
    fn post_allows_delegate_clear_on_input_at_zero() {
        let mut cleared = snap(900, 0);
        cleared.delegate_raw = [0; 36];
        assert_eq!(
            check_post(
                &snap(1000, 100),
                &snap(0, 0),
                &cleared,
                &snap(95, 0),
                100,
                95
            ),
            Ok((100, 95))
        );
        // Not allowed while delegated_amount is still positive.
        let mut cleared = snap(900, 5);
        cleared.delegate_raw = [0; 36];
        assert_eq!(
            check_post(
                &snap(1000, 105),
                &snap(0, 0),
                &cleared,
                &snap(95, 0),
                100,
                95
            ),
            Err(RelayError::AccountInvariantViolated)
        );
    }
}
