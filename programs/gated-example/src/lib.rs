//! # gated-example: a second integrator of AgentAuth (test/demo only)
//!
//! A small program (the gate is `gated_action` below, about 25 lines) that gates its own instruction with an AgentAuth mandate, with no relay
//! involved. The program is its own gate: `gated_action` cannot succeed unless AgentAuth `verify`
//! approves `(target = this program, disc8 = GATED_ACTION_DISC, amount)` for the agent.
//!
//! * `[0]` `init`: `[authority S+W, config W, system]`. Creates the config PDA `["config"]` holding the
//!   32-byte key of the owner whose mandates this deployment honours. Callable once.
//! * `[1] + amount u64 LE` `gated_action`: `[agent S, mandate W, owner R, agentauth_program R, config R]`.
//!
//! Why `expected_owner` comes from the config account: anyone can mint a mandate that names any
//! agent with themselves as owner, so the owner a mandate must carry has to come from this
//! program's own state, never from the transaction. Only this program can write the config PDA
//! (it is program-owned and sits at a fixed address), so the caller cannot choose it.
//!
//! Honest limits: first `init` wins (call it right after deploying); the action only logs, it moves
//! nothing, so the gate is advisory beyond "this action cannot run without a valid mandate".
#![cfg_attr(target_os = "solana", no_std)]

mod config;

use agent_auth_cpi::{disc8, VerifyCpi};
use pinocchio::{
    account_info::AccountInfo, log::sol_log_data, program_error::ProgramError, pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_pubkey::pubkey;

#[cfg(target_os = "solana")]
mod entry {
    pinocchio::program_entrypoint!(crate::process_instruction);
    pinocchio::default_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// Program id (throwaway demo key).
pub const GATED_EXAMPLE_ID: Pubkey = pubkey!("CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ");
/// `disc8` of `gated_action`: tag byte 1, then 7 zero bytes.
pub const GATED_ACTION_DISC: [u8; 8] = disc8::from_u8_tag(1);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data {
        [0] => config::init(program_id, accounts),
        [1, amount @ ..] => gated_action(program_id, accounts, amount),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn gated_action(program_id: &Pubkey, accounts: &[AccountInfo], amount: &[u8]) -> ProgramResult {
    let [agent, mandate, owner, agent_auth_program, config] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = u64::from_le_bytes(
        amount
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    // 1. who may grant mandates here: from OUR state, not from the transaction
    let expected_owner = config::expected_owner(program_id, config)?;
    // 2. ask AgentAuth (the crate pins the real program id and binds the mandate owner)
    VerifyCpi {
        agent_auth_program,
        mandate,
        owner,
        agent,
        expected_owner: &expected_owner,
        target_program: program_id,
        disc: GATED_ACTION_DISC,
        amount,
    }
    .invoke()?;
    // 3. act: exactly the verified amount (this example only logs it)
    sol_log_data(&[b"gated_action", &amount.to_le_bytes()]);
    Ok(())
}
