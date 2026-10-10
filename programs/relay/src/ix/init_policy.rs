//! `0 init_policy` - RELAY-SPEC section 7.1.
//!
//! Owner-only. Validates the immutable 800-byte config, derives and stores
//! both PDA bumps (the only place `find_program_address` runs) and creates the
//! 944-byte policy account. Robust to a pre-funded policy PDA: if anyone sent
//! lamports to the address, `CreateAccount` would fail with "account already
//! in use" and grief the owner forever, so the handler falls back to
//! `Transfer` (top-up) + `Allocate` + `Assign`, all signed with the policy
//! seeds.
//!
//! Data `[0] + flags + config[800]` (802 bytes); accounts (exactly 4):
//! `owner` (signer, writable), `mandate`, `policy` (writable), `system_program`.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{try_find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use crate::bytes::{byte_at, key_at, slice_at};
use crate::error::RelayError;
use crate::events;
use crate::ids::AGENT_AUTH_ID;
use crate::ids::{amm_allowed, AUTHORITY_SEED, POLICY_SEED, SYSTEM_ID};
use crate::state::{
    write_policy, Config, Header, IdentityKeys, CONFIG_LEN, FLAGS_RESERVED_MASK, MANDATE_DISC,
    MANDATE_LEN, MANDATE_OFF_ACTIVE, MANDATE_OFF_AGENT, MANDATE_OFF_DISC, MANDATE_OFF_EXPIRY,
    MANDATE_OFF_OWNER, POLICY_LEN,
};

/// Total `init_policy` data length: tag + flags + config.
pub const INIT_DATA_LEN: usize = 2 + CONFIG_LEN;

/// Handler for `init_policy`. `data` is the full instruction data (tag included).
pub fn init_policy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != INIT_DATA_LEN {
        return Err(RelayError::InvalidInstructionData.into());
    }
    let [owner, mandate, policy, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !owner.is_signer() {
        return Err(RelayError::OwnerNotSigner.into());
    }
    if system_program.key() != &SYSTEM_ID {
        return Err(RelayError::WrongProgram.into());
    }

    let live = read_mandate(mandate, owner)?;
    if live.agent == *owner.key() {
        return Err(RelayError::InvalidConfig.into());
    }

    let (policy_pda, policy_bump) =
        try_find_program_address(&[POLICY_SEED, mandate.key()], program_id)
            .ok_or(ProgramError::InvalidSeeds)?;
    if policy.key() != &policy_pda {
        return Err(RelayError::AccountMismatch.into());
    }
    let (authority, authority_bump) =
        try_find_program_address(&[AUTHORITY_SEED, mandate.key()], program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    if policy.owner() != &SYSTEM_ID || policy.data_len() != 0 {
        return Err(RelayError::InvalidConfig.into());
    }

    let flags = byte_at(data, 1);
    let config_bytes = slice_at(data, 2, CONFIG_LEN);
    if flags & FLAGS_RESERVED_MASK != 0 {
        return Err(RelayError::InvalidConfig.into());
    }
    let config = Config::new(config_bytes).ok_or(RelayError::InvalidInstructionData)?;
    config.validate(
        &IdentityKeys {
            mandate: mandate.key(),
            policy: policy.key(),
            authority: &authority,
            owner: owner.key(),
            agent: &live.agent,
        },
        amm_allowed,
    )?;

    create_policy_account(program_id, owner, mandate.key(), policy, policy_bump)?;

    {
        let mut buf = policy.try_borrow_mut_data()?;
        write_policy(
            &mut buf,
            &Header {
                policy_bump,
                authority_bump,
                flags,
                mandate: mandate.key(),
                owner: owner.key(),
                agent: &live.agent,
                authority: &authority,
                mandate_expiry: &live.expiry,
            },
            config_bytes,
        )
        .ok_or(RelayError::InvalidConfig)?;
    }
    events::emit_policy_initialized(mandate.key(), policy.key(), flags);
    Ok(())
}

/// Fields copied out of the live mandate.
struct LiveMandate {
    agent: Pubkey,
    expiry: [u8; 8],
}

/// Step 4 of 7.1: a live AgentAuth mandate of this owner (117 / 109).
#[inline(never)]
fn read_mandate(mandate: &AccountInfo, owner: &AccountInfo) -> Result<LiveMandate, ProgramError> {
    if mandate.owner() != &AGENT_AUTH_ID || mandate.data_len() != MANDATE_LEN {
        return Err(RelayError::InvalidMandate.into());
    }
    let d = mandate.try_borrow_data()?;
    if byte_at(&d, MANDATE_OFF_DISC) != MANDATE_DISC || byte_at(&d, MANDATE_OFF_ACTIVE) != 1 {
        return Err(RelayError::InvalidMandate.into());
    }
    if key_at(&d, MANDATE_OFF_OWNER) != owner.key() {
        return Err(RelayError::NotPolicyOwner.into());
    }
    let mut expiry = [0u8; 8];
    expiry.copy_from_slice(slice_at(&d, MANDATE_OFF_EXPIRY, 8));
    Ok(LiveMandate {
        agent: *key_at(&d, MANDATE_OFF_AGENT),
        expiry,
    })
}

/// Step 9 of 7.1: create the 944-byte relay-owned policy account, robust to
/// pre-funding.
#[inline(never)]
fn create_policy_account(
    program_id: &Pubkey,
    owner: &AccountInfo,
    mandate: &Pubkey,
    policy: &AccountInfo,
    policy_bump: u8,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(POLICY_LEN);
    let bump = [policy_bump];
    let seeds = [
        Seed::from(POLICY_SEED),
        Seed::from(mandate),
        Seed::from(&bump),
    ];
    let existing = policy.lamports();

    if existing == 0 {
        CreateAccount {
            from: owner,
            to: policy,
            lamports: rent,
            space: POLICY_LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&seeds)])
    } else {
        if existing < rent {
            Transfer {
                from: owner,
                to: policy,
                lamports: rent.saturating_sub(existing),
            }
            .invoke()?;
        }
        Allocate {
            account: policy,
            space: POLICY_LEN as u64,
        }
        .invoke_signed(&[Signer::from(&seeds)])?;
        Assign {
            account: policy,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&seeds)])
    }
}
