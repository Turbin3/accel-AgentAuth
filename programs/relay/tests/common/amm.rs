//! Mock-AMM fixtures: pool-state layout, mode numbers, instruction builders (`swap_base_input`,
//! `proxy`, `init_pool`) and a constant-product reference. Layouts come from RELAY-SPEC 14.1 and
//! were checked against `programs/mock-amm/src/{pool,swap,mode}.rs`.
//!
//! The mock only validates: pool_state (owner, 104 bytes), the pool-authority PDA, the two
//! vaults (token accounts of the right mint whose token-level owner is the pool authority), and
//! the mints/token programs. `amm_config` and `observation_state` are accepted and unused.

use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use super::ids::{mock_amm_authority, MOCK_AMM_ID, PROXY_DISC, SWAP_DISC};

pub const POOL_STATE_LEN: usize = 104;
pub const INIT_POOL_DISC: [u8; 8] = [0xFF, 0x69, 0x6E, 0x69, 0x74, 0x00, 0x00, 0x00];

/// Pool behaviour (byte 0 of `pool_state`).
pub mod mode {
    pub const NORMAL: u8 = 0;
    pub const PULL_EXTRA: u8 = 1;
    pub const BURN_IN: u8 = 2;
    pub const APPROVE_ATTACKER: u8 = 3;
    pub const SET_AUTH: u8 = 4;
    pub const CLOSE_ACCOUNT: u8 = 5;
    pub const REDIRECT_OUTPUT: u8 = 6;
    pub const REENTER_RELAY: u8 = 7;
    pub const CPI_VERIFY: u8 = 8;
    pub const NOOP_OK: u8 = 9;
    pub const UNDERPAY: u8 = 10;
    pub const PULL_LESS: u8 = 11;
    pub const BURN_CPU: u8 = 12;
    pub const COUNT: u8 = 13;
}

/// `pool_state` account contents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub mode: u8,
    pub vault_0: Pubkey,
    pub vault_1: Pubkey,
    pub aux_key: Pubkey,
}

impl PoolState {
    pub fn normal(vault_0: Pubkey, vault_1: Pubkey) -> Self {
        Self {
            mode: mode::NORMAL,
            vault_0,
            vault_1,
            aux_key: Pubkey::default(),
        }
    }

    pub fn mode(mut self, mode: u8) -> Self {
        self.mode = mode;
        self
    }

    pub fn aux(mut self, aux_key: Pubkey) -> Self {
        self.aux_key = aux_key;
        self
    }

    /// Exact 104 bytes.
    pub fn encode(&self) -> [u8; POOL_STATE_LEN] {
        let mut b = [0u8; POOL_STATE_LEN];
        b[0] = self.mode;
        b[8..40].copy_from_slice(self.vault_0.as_ref());
        b[40..72].copy_from_slice(self.vault_1.as_ref());
        b[72..104].copy_from_slice(self.aux_key.as_ref());
        b
    }

    pub fn decode(data: &[u8]) -> Self {
        assert_eq!(data.len(), POOL_STATE_LEN, "pool_state must be 104 bytes");
        Self {
            mode: data[0],
            vault_0: Pubkey::try_from(&data[8..40]).expect("32"),
            vault_1: Pubkey::try_from(&data[40..72]).expect("32"),
            aux_key: Pubkey::try_from(&data[72..104]).expect("32"),
        }
    }

    /// Account owned by the mock AMM program.
    pub fn account(&self, lamports: u64) -> Account {
        Account {
            lamports,
            data: self.encode().to_vec(),
            owner: MOCK_AMM_ID,
            executable: false,
            rent_epoch: 0,
        }
    }
}

/// `floor(amount_in * out_reserve / (in_reserve + amount_in))` in u128 (the mock's NORMAL math).
pub fn amount_out(in_reserve: u64, out_reserve: u64, amount_in: u64) -> Option<u64> {
    let den = (in_reserve as u128).checked_add(amount_in as u128)?;
    if den == 0 {
        return None;
    }
    let num = (amount_in as u128).checked_mul(out_reserve as u128)?;
    u64::try_from(num / den).ok()
}

/// The pool-authority PDA key (owner of both vaults).
pub fn pool_authority() -> Pubkey {
    mock_amm_authority().0
}

/// Direct `swap_base_input` call on the mock (13 Raydium accounts, 24-byte data).
/// `payer` signs and is the authority of the input transfer.
#[allow(clippy::too_many_arguments)]
pub fn mock_swap_ix(
    payer: &Pubkey,
    pool_state: &Pubkey,
    amm_config: &Pubkey,
    in_account: &Pubkey,
    out_account: &Pubkey,
    input_vault: &Pubkey,
    output_vault: &Pubkey,
    in_token_program: &Pubkey,
    out_token_program: &Pubkey,
    in_mint: &Pubkey,
    out_mint: &Pubkey,
    observation: &Pubkey,
    amount_in: u64,
    min_out: u64,
) -> Instruction {
    let mut data = SWAP_DISC.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction::new_with_bytes(
        MOCK_AMM_ID,
        &data,
        vec![
            AccountMeta::new_readonly(*payer, true),
            AccountMeta::new_readonly(pool_authority(), false),
            AccountMeta::new_readonly(*amm_config, false),
            AccountMeta::new(*pool_state, false),
            AccountMeta::new(*in_account, false),
            AccountMeta::new(*out_account, false),
            AccountMeta::new(*input_vault, false),
            AccountMeta::new(*output_vault, false),
            AccountMeta::new_readonly(*in_token_program, false),
            AccountMeta::new_readonly(*out_token_program, false),
            AccountMeta::new_readonly(*in_mint, false),
            AccountMeta::new_readonly(*out_mint, false),
            AccountMeta::new(*observation, false),
        ],
    )
}

/// Wrap `inner` in the mock's `proxy` instruction: the inner program runs at stack height 2 with
/// the same account flags. Used for STRICT_TOP_LEVEL (115) and depth tests (TR-34, TR-35, FE-03).
pub fn proxy_ix(inner: &Instruction) -> Instruction {
    let mut data = PROXY_DISC.to_vec();
    data.extend_from_slice(&inner.data);
    let mut accounts = vec![AccountMeta::new_readonly(inner.program_id, false)];
    accounts.extend(inner.accounts.iter().cloned());
    Instruction::new_with_bytes(MOCK_AMM_ID, &data, accounts)
}

/// `init_pool` (cluster-side pool creation): `[pool_state W, vault_0, vault_1]`.
pub fn init_pool_ix(
    pool_state: &Pubkey,
    vault_0: &Pubkey,
    vault_1: &Pubkey,
    mode: u8,
    aux: &Pubkey,
) -> Instruction {
    let mut data = INIT_POOL_DISC.to_vec();
    data.push(mode);
    data.extend_from_slice(aux.as_ref());
    Instruction::new_with_bytes(
        MOCK_AMM_ID,
        &data,
        vec![
            AccountMeta::new(*pool_state, false),
            AccountMeta::new_readonly(*vault_0, false),
            AccountMeta::new_readonly(*vault_1, false),
        ],
    )
}
