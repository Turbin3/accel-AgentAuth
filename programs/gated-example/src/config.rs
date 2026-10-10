//! The gate's only state: PDA `["config"]`, 33 bytes = `expected_owner[32] | bump`.
use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{create_program_address, find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, Transfer};

const SEED: &[u8] = b"config";
const LEN: usize = 33;

/// Hot path: the owner this deployment honours. Fails closed unless `config` is the real PDA, owned by us.
pub fn expected_owner(program_id: &Pubkey, config: &AccountInfo) -> Result<Pubkey, ProgramError> {
    if config.owner() != program_id || config.data_len() != LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = config.try_borrow_data()?;
    let pda = create_program_address(&[SEED, &data[32..]], program_id);
    if pda != Ok(*config.key()) {
        return Err(ProgramError::InvalidSeeds);
    }
    data[..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)
}

/// `init`: the signing `authority` becomes the expected owner. Allocate fails on a second call, and
/// the Transfer top-up makes it immune to someone pre-funding the PDA with lamports.
pub fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [authority, config, _system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (pda, bump) = find_program_address(&[SEED], program_id);
    if !authority.is_signer() || *config.key() != pda {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let missing = Rent::get()?
        .minimum_balance(LEN)
        .saturating_sub(config.lamports());
    if missing > 0 {
        Transfer {
            from: authority,
            to: config,
            lamports: missing,
        }
        .invoke()?;
    }
    let bump = [bump];
    let seeds = [Seed::from(SEED), Seed::from(&bump)];
    Allocate {
        account: config,
        space: LEN as u64,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;
    Assign {
        account: config,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;
    let mut data = config.try_borrow_mut_data()?;
    data[..32].copy_from_slice(authority.key());
    data[32] = bump[0];
    Ok(())
}
