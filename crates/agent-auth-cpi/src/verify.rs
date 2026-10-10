//! The typed, checked `verify` CPI.

use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke_signed,
    instruction::{AccountMeta, Instruction, Signer},
    pubkey::Pubkey,
    ProgramResult,
};

use crate::{CpiError, MandateHeader, AGENT_AUTH_ID, VERIFY_DATA_LEN, VERIFY_TAG};

/// Build the 49-byte `verify` instruction data:
/// `3 | target_program[32] | disc8[8] | amount u64 LE`.
pub fn verify_instruction_data(
    target_program: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> [u8; VERIFY_DATA_LEN] {
    let mut data = [0u8; VERIFY_DATA_LEN];
    data[0] = VERIFY_TAG;
    data[1..33].copy_from_slice(target_program);
    data[33..41].copy_from_slice(disc);
    data[41..49].copy_from_slice(&amount.to_le_bytes());
    data
}

/// A checked call to AgentAuth `verify`.
///
/// Every field is mandatory (there is no `Default`), including
/// [`expected_owner`](Self::expected_owner): you cannot build this value without
/// saying whose authority the mandate must come from.
///
/// ```no_run
/// # use agent_auth_cpi::{disc8, VerifyCpi};
/// # use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
/// # fn f(auth: &AccountInfo, mandate: &AccountInfo, owner: &AccountInfo, agent: &AccountInfo,
/// #      vault_owner: &Pubkey, system: &Pubkey, lamports: u64) -> Result<(), ProgramError> {
/// VerifyCpi { agent_auth_program: auth, mandate, owner, agent, expected_owner: vault_owner,
///             target_program: system, disc: disc8::SYSTEM_TRANSFER, amount: lamports }.invoke()?;
/// // ... only now move `lamports` out of the vault that `vault_owner` controls ...
/// # Ok(()) }
/// ```
///
/// [`invoke`](Self::invoke) / [`invoke_signed`](Self::invoke_signed) perform, in
/// this order and BEFORE the CPI:
///
/// 1. `agent_auth_program.key() == AGENT_AUTH_ID`
/// 2. `mandate` is owned by `AGENT_AUTH_ID`, is 2136 bytes, discriminator 1
/// 3. `mandate` is writable and its data is not already borrowed
/// 4. `mandate.owner == expected_owner` and `owner.key() == expected_owner`
/// 5. `mandate.agent == agent.key()`
/// 6. `agent` signed the transaction (or signer seeds are supplied)
///
/// then invokes `verify`. Everything else (active, expiry, program and
/// instruction allow-list, per-transaction and lifetime limits) is enforced by
/// AgentAuth itself and its error code propagates unchanged.
pub struct VerifyCpi<'a> {
    /// The AgentAuth program account from the transaction. Checked against
    /// [`AGENT_AUTH_ID`]; it only has to be present in your instruction's
    /// account list because the runtime requires the callee program there.
    pub agent_auth_program: &'a AccountInfo,
    /// The mandate account (must be writable: `verify` bumps its counters).
    pub mandate: &'a AccountInfo,
    /// The mandate owner's account (read only). Must equal `expected_owner`.
    pub owner: &'a AccountInfo,
    /// The agent acting under the mandate. Must sign.
    pub agent: &'a AccountInfo,
    /// The owner this mandate MUST name. Take it from YOUR program's state or a
    /// PDA derivation, never from a value the caller of your instruction chooses
    /// freely; it is the key that controls the funds or authority you are about
    /// to move. See "Security checklist" in the crate docs.
    pub expected_owner: &'a Pubkey,
    /// The program the agent is about to call, as reported to AgentAuth.
    pub target_program: &'a Pubkey,
    /// The `disc8` of the action (see [`crate::disc8`]).
    pub disc: [u8; 8],
    /// The real amount that the action moves, in the unit of the mandate's limits.
    /// AgentAuth can only enforce what you report here.
    pub amount: u64,
}

impl VerifyCpi<'_> {
    /// Run every pre-CPI check assuming the agent must be a transaction signer.
    /// Useful on its own when you want to fail early.
    pub fn preflight(&self) -> Result<(), CpiError> {
        self.check(false)
    }

    fn check(&self, has_signer_seeds: bool) -> Result<(), CpiError> {
        // 1. Never trust the transaction for the AgentAuth program id.
        if self.agent_auth_program.key() != &AGENT_AUTH_ID {
            return Err(CpiError::WrongAgentAuthProgram);
        }
        // 2. The mandate must be a real AgentAuth account.
        if self.mandate.owner() != &AGENT_AUTH_ID {
            return Err(CpiError::MandateNotOwnedByAgentAuth);
        }
        // 3. Writable (verify mutates it) and not borrowed by us.
        if !self.mandate.is_writable() {
            return Err(CpiError::MandateNotWritable);
        }
        {
            let data = self
                .mandate
                .try_borrow_data()
                .map_err(|_| CpiError::MandateBorrowed)?;
            let header = MandateHeader::parse_unowned_checked(&data)?;
            // 4. Bind the mandate to the authority being protected.
            if header.owner() != self.expected_owner {
                return Err(CpiError::OwnerMismatch);
            }
            // 5. The mandate must name the agent that is acting.
            if header.agent() != self.agent.key() {
                return Err(CpiError::AgentMismatch);
            }
        } // the Ref is dropped here: no borrow is held across the CPI
        if self.owner.key() != self.expected_owner {
            return Err(CpiError::OwnerAccountMismatch);
        }
        // 6. A signer in the outer transaction, or (PDA agent) seeds to sign with.
        if !self.agent.is_signer() && !has_signer_seeds {
            return Err(CpiError::AgentNotSigner);
        }
        Ok(())
    }

    /// Check, then CPI `verify`. The agent must have signed the transaction.
    #[inline]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    /// Check, then CPI `verify` with PDA signer seeds (for a program-derived
    /// agent). The runtime rejects seeds that do not derive the agent's key.
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        self.check(!signers.is_empty())?;

        let data = verify_instruction_data(self.target_program, &self.disc, self.amount);
        let metas = [
            AccountMeta::writable(self.mandate.key()),
            AccountMeta::readonly(self.owner.key()),
            AccountMeta::readonly_signer(self.agent.key()),
        ];
        let ix = Instruction {
            program_id: &AGENT_AUTH_ID,
            accounts: &metas,
            data: &data,
        };
        invoke_signed::<3>(&ix, &[self.mandate, self.owner, self.agent], signers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_layout_is_49_bytes() {
        let d = verify_instruction_data(
            &[0xAB; 32],
            &[1, 2, 3, 4, 5, 6, 7, 8],
            0x0102_0304_0506_0708,
        );
        assert_eq!(d.len(), 49);
        assert_eq!(d[0], 3);
        assert_eq!(&d[1..33], &[0xAB; 32]);
        assert_eq!(&d[33..41], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&d[41..49], &[8, 7, 6, 5, 4, 3, 2, 1]);
    }
}
