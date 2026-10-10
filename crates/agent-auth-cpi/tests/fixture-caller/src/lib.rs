//! fixture-caller: the smallest realistic third-party program that uses `agent-auth-cpi`.
//!
//! It guards a System `Transfer` out of an owner-bound treasury PDA behind AgentAuth `verify`.
//! The "expected mandate owner" comes from PROGRAM STATE (the `config` account, owned by this
//! program), never from anything the transaction chooses. The treasury is the PDA
//! `["treasury", expected_owner]`, so the money follows the same owner the mandate is bound to.
//!
//! Accounts (all modes):
//!   0 agent_auth_program  readonly   whatever the tx supplies (the helper pins the real id)
//!   1 mandate             writable
//!   2 owner               readonly   mandate owner
//!   3 agent               signer (or PDA ["agent"] of this program in mode 3)
//!   4 treasury            writable   system-owned PDA ["treasury", expected_owner]
//!   5 recipient           writable
//!   6 system program      readonly
//!   7 config              readonly   owned by this program; data[0..32] = expected mandate owner
//!
//! Instruction data: [mode u8][amount u64 LE][treasury_bump u8][agent_bump u8]
//!   mode 0  HELPER      agent-auth-cpi `VerifyCpi::invoke`, then transfer
//!   mode 1  RAW         hand-rolled verify CPI against the hard-coded id with NO other checks (CU baseline)
//!   mode 2  NO_VERIFY   transfer only (CU baseline)
//!   mode 3  HELPER_PDA  `VerifyCpi::invoke_signed` with the PDA agent ["agent"], then transfer
//!   mode 4  HELD_BORROW holds a mutable borrow of the mandate across the helper call
//!   mode 5  PREFLIGHT   only `VerifyCpi::preflight` (no CPI, no transfer)
//!   mode 6  NAIVE_ID    NEGATIVE CONTROL: raw verify CPI to whatever program is in slot 0 (confused deputy #1)
//!   (mode 1 doubles as the NEGATIVE CONTROL for confused deputy #2: no owner binding at all)
#![no_std]

use agent_auth_cpi::{disc8, VerifyCpi, AGENT_AUTH_ID};
use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke,
    instruction::{AccountMeta, Instruction, Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

/// The System program id.
const SYSTEM: Pubkey = [0u8; 32];

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [auth, mandate, owner, agent, treasury, recipient, _system, config] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 11 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mode = data[0];
    let amount = u64::from_le_bytes(
        data[1..9]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let treasury_bump = [data[9]];
    let agent_bump = [data[10]];

    // expected owner = program state
    if config.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_owner: Pubkey = {
        let d = config.try_borrow_data()?;
        d.get(..32)
            .and_then(|s| <[u8; 32]>::try_from(s).ok())
            .ok_or(ProgramError::InvalidAccountData)?
    };

    let verify = VerifyCpi {
        agent_auth_program: auth,
        mandate,
        owner,
        agent,
        expected_owner: &expected_owner,
        target_program: &SYSTEM,
        disc: disc8::SYSTEM_TRANSFER,
        amount,
    };

    match mode {
        0 => verify.invoke()?,
        1 => raw_verify(&AGENT_AUTH_ID, mandate, owner, agent, amount)?,
        2 => {}
        3 => {
            let seeds = [Seed::from(b"agent".as_ref()), Seed::from(&agent_bump)];
            verify.invoke_signed(&[Signer::from(&seeds)])?
        }
        4 => {
            let _held = mandate.try_borrow_mut_data()?;
            verify.invoke()?
        }
        5 => return Ok(verify.preflight()?),
        6 => raw_verify(auth.key(), mandate, owner, agent, amount)?,
        _ => return Err(ProgramError::InvalidInstructionData),
    }

    // act: move exactly the amount that was verified, out of the treasury of the verified owner
    let seeds = [
        Seed::from(b"treasury".as_ref()),
        Seed::from(&expected_owner),
        Seed::from(&treasury_bump),
    ];
    Transfer {
        from: treasury,
        to: recipient,
        lamports: amount,
    }
    .invoke_signed(&[Signer::from(&seeds)])
}

/// What an integrator writes by hand without the crate: a bare verify CPI with no checks at all
/// (CU baseline, and the negative control for both confused-deputy bugs).
fn raw_verify(
    verify_program: &Pubkey,
    mandate: &AccountInfo,
    owner: &AccountInfo,
    agent: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 49];
    data[0] = 3;
    data[1..33].copy_from_slice(&SYSTEM);
    data[33..41].copy_from_slice(&disc8::SYSTEM_TRANSFER);
    data[41..49].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        AccountMeta::writable(mandate.key()),
        AccountMeta::readonly(owner.key()),
        AccountMeta::readonly_signer(agent.key()),
    ];
    let ix = Instruction {
        program_id: verify_program,
        accounts: &metas,
        data: &data,
    };
    invoke::<3>(&ix, &[mandate, owner, agent])
}
