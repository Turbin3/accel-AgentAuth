//! Relay instruction builders mirroring `relay-idl.json` (accounts in order, data layout), plus
//! `IxExt`, a toolbox for corrupting ONE field or account of an otherwise valid instruction.
//!
//! Two styles, use whichever reads better in the test:
//!
//! * struct style: `let mut t = ctx.transfer_accounts(); t.destination = x; t.ix(amount)`
//! * index style:  `ctx.transfer_ix(amount).with_account(transfer_idx::DESTINATION, x)`

use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use super::ids::{AGENT_AUTH_ID, RELAY_ID, SYSTEM_ID};

pub const TAG_INIT_POLICY: u8 = 0;
pub const TAG_SET_PAUSED: u8 = 1;
pub const TAG_CLOSE_POLICY: u8 = 2;
pub const TAG_TRANSFER: u8 = 3;
pub const TAG_SWAP: u8 = 4;

/// Exact account counts (FE-09).
pub const INIT_POLICY_ACCOUNTS: usize = 4;
pub const SET_PAUSED_ACCOUNTS: usize = 2;
pub const CLOSE_POLICY_ACCOUNTS: usize = 2;
pub const TRANSFER_ACCOUNTS: usize = 10;
pub const SWAP_ACCOUNTS: usize = 19;

pub const TRANSFER_DATA_LEN: usize = 9;
pub const SWAP_DATA_LEN: usize = 25;

/// Account positions of `init_policy`.
pub mod init_idx {
    pub const OWNER: usize = 0;
    pub const MANDATE: usize = 1;
    pub const POLICY: usize = 2;
    pub const SYSTEM_PROGRAM: usize = 3;
}

/// Account positions of `transfer`.
pub mod transfer_idx {
    pub const AGENT: usize = 0;
    pub const MANDATE: usize = 1;
    pub const OWNER: usize = 2;
    pub const POLICY: usize = 3;
    pub const AUTHORITY: usize = 4;
    pub const SOURCE: usize = 5;
    pub const DESTINATION: usize = 6;
    pub const MINT: usize = 7;
    pub const TOKEN_PROGRAM: usize = 8;
    pub const AGENTAUTH_PROGRAM: usize = 9;
}

/// Account positions of `swap`.
pub mod swap_idx {
    pub const AGENT: usize = 0;
    pub const MANDATE: usize = 1;
    pub const OWNER: usize = 2;
    pub const POLICY: usize = 3;
    pub const AUTHORITY: usize = 4;
    pub const IN_ACCOUNT: usize = 5;
    pub const OUT_ACCOUNT: usize = 6;
    pub const AMM_PROGRAM: usize = 7;
    pub const AMM_AUTHORITY: usize = 8;
    pub const AMM_CONFIG: usize = 9;
    pub const POOL_STATE: usize = 10;
    pub const INPUT_VAULT: usize = 11;
    pub const OUTPUT_VAULT: usize = 12;
    pub const IN_TOKEN_PROGRAM: usize = 13;
    pub const OUT_TOKEN_PROGRAM: usize = 14;
    pub const IN_MINT: usize = 15;
    pub const OUT_MINT: usize = 16;
    pub const OBSERVATION_STATE: usize = 17;
    pub const AGENTAUTH_PROGRAM: usize = 18;
}

/// The 12 swap pins the SW-03 table replaces one at a time (names for failure messages).
pub const SWAP_PIN_TABLE: [(&str, usize); 12] = [
    ("amm_authority", swap_idx::AMM_AUTHORITY),
    ("amm_config", swap_idx::AMM_CONFIG),
    ("pool_state", swap_idx::POOL_STATE),
    ("input_vault", swap_idx::INPUT_VAULT),
    ("output_vault", swap_idx::OUTPUT_VAULT),
    ("observation_state", swap_idx::OBSERVATION_STATE),
    ("in_mint", swap_idx::IN_MINT),
    ("out_mint", swap_idx::OUT_MINT),
    ("in_token_program", swap_idx::IN_TOKEN_PROGRAM),
    ("out_token_program", swap_idx::OUT_TOKEN_PROGRAM),
    ("in_account", swap_idx::IN_ACCOUNT),
    ("out_account", swap_idx::OUT_ACCOUNT),
];

// ------------------------------------------------------------------ init_policy

/// `0 init_policy`: `[owner S W, mandate R, policy W, system R]`, data 802 bytes.
#[derive(Clone, Debug)]
pub struct InitPolicyIx {
    pub program: Pubkey,
    pub owner: Pubkey,
    pub mandate: Pubkey,
    pub policy: Pubkey,
    pub system_program: Pubkey,
}

impl InitPolicyIx {
    pub fn new(owner: Pubkey, mandate: Pubkey, policy: Pubkey) -> Self {
        Self {
            program: RELAY_ID,
            owner,
            mandate,
            policy,
            system_program: SYSTEM_ID,
        }
    }

    /// `data` is the complete instruction data (use `PolicyCfg::init_data(flags)`).
    pub fn ix(&self, data: &[u8]) -> Instruction {
        Instruction::new_with_bytes(
            self.program,
            data,
            vec![
                AccountMeta::new(self.owner, true),
                AccountMeta::new_readonly(self.mandate, false),
                AccountMeta::new(self.policy, false),
                AccountMeta::new_readonly(self.system_program, false),
            ],
        )
    }
}

// ------------------------------------------------------------------ set_paused / close_policy

/// `1 set_paused`: `[owner S, policy W]`, data `[1, paused]`.
pub fn set_paused_ix(owner: &Pubkey, policy: &Pubkey, paused: u8) -> Instruction {
    Instruction::new_with_bytes(
        RELAY_ID,
        &[TAG_SET_PAUSED, paused],
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*policy, false),
        ],
    )
}

/// `2 close_policy`: `[owner S W, policy W]`, data `[2]`.
pub fn close_policy_ix(owner: &Pubkey, policy: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        RELAY_ID,
        &[TAG_CLOSE_POLICY],
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(*policy, false),
        ],
    )
}

// ------------------------------------------------------------------ transfer

/// `3 transfer`: 10 accounts, data `[3] + amount u64`.
#[derive(Clone, Debug)]
pub struct TransferIx {
    pub program: Pubkey,
    pub agent: Pubkey,
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub policy: Pubkey,
    pub authority: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub agentauth_program: Pubkey,
}

impl TransferIx {
    pub fn ix(&self, amount: u64) -> Instruction {
        let mut data = vec![TAG_TRANSFER];
        data.extend_from_slice(&amount.to_le_bytes());
        self.ix_with_data(&data)
    }

    /// Same accounts, arbitrary instruction data (length / tag corruption).
    pub fn ix_with_data(&self, data: &[u8]) -> Instruction {
        Instruction::new_with_bytes(
            self.program,
            data,
            vec![
                AccountMeta::new_readonly(self.agent, true),
                AccountMeta::new(self.mandate, false),
                AccountMeta::new_readonly(self.owner, false),
                AccountMeta::new_readonly(self.policy, false),
                AccountMeta::new_readonly(self.authority, false),
                AccountMeta::new(self.source, false),
                AccountMeta::new(self.destination, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(self.token_program, false),
                AccountMeta::new_readonly(self.agentauth_program, false),
            ],
        )
    }
}

// ------------------------------------------------------------------ swap

/// `4 swap`: 19 accounts, data `[4] + amount_in + min_out + deadline_slot` (25 bytes).
#[derive(Clone, Debug)]
pub struct SwapIx {
    pub program: Pubkey,
    pub agent: Pubkey,
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub policy: Pubkey,
    pub authority: Pubkey,
    pub in_account: Pubkey,
    pub out_account: Pubkey,
    pub amm_program: Pubkey,
    pub amm_authority: Pubkey,
    pub amm_config: Pubkey,
    pub pool_state: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub in_token_program: Pubkey,
    pub out_token_program: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub observation_state: Pubkey,
    pub agentauth_program: Pubkey,
}

impl SwapIx {
    pub fn ix(&self, amount_in: u64, min_out: u64, deadline_slot: u64) -> Instruction {
        self.ix_with_data(&swap_data(amount_in, min_out, deadline_slot))
    }

    pub fn ix_with_data(&self, data: &[u8]) -> Instruction {
        let w = |k: Pubkey| AccountMeta::new(k, false);
        let r = |k: Pubkey| AccountMeta::new_readonly(k, false);
        Instruction::new_with_bytes(
            self.program,
            data,
            vec![
                AccountMeta::new_readonly(self.agent, true),
                w(self.mandate),
                r(self.owner),
                r(self.policy),
                r(self.authority),
                w(self.in_account),
                w(self.out_account),
                r(self.amm_program),
                r(self.amm_authority),
                r(self.amm_config),
                w(self.pool_state),
                w(self.input_vault),
                w(self.output_vault),
                r(self.in_token_program),
                r(self.out_token_program),
                r(self.in_mint),
                r(self.out_mint),
                w(self.observation_state),
                r(self.agentauth_program),
            ],
        )
    }
}

/// `swap` instruction data.
pub fn swap_data(amount_in: u64, min_out: u64, deadline_slot: u64) -> Vec<u8> {
    let mut d = vec![TAG_SWAP];
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    d.extend_from_slice(&deadline_slot.to_le_bytes());
    d
}

/// `transfer` instruction data.
pub fn transfer_data(amount: u64) -> Vec<u8> {
    let mut d = vec![TAG_TRANSFER];
    d.extend_from_slice(&amount.to_le_bytes());
    d
}

/// Default AgentAuth id for the `agentauth_program` slot.
pub fn agentauth_program() -> Pubkey {
    AGENT_AUTH_ID
}

// ------------------------------------------------------------------ corruption toolbox

/// Mutators for ONE-field-at-a-time corruption. All return `self` for chaining.
pub trait IxExt: Sized {
    /// Replace the pubkey of account `idx`, keeping its signer/writable flags.
    fn with_account(self, idx: usize, key: Pubkey) -> Self;
    /// Set the signer flag of account `idx`.
    fn with_signer(self, idx: usize, is_signer: bool) -> Self;
    /// Set the writable flag of account `idx`.
    fn with_writable(self, idx: usize, is_writable: bool) -> Self;
    /// Remove account `idx`.
    fn without_account(self, idx: usize) -> Self;
    /// Truncate the account list to `n` entries.
    fn truncate_accounts(self, n: usize) -> Self;
    /// Append an extra read-only, non-signer account.
    fn with_extra_account(self, key: Pubkey) -> Self;
    /// Replace the whole instruction data.
    fn with_data(self, data: &[u8]) -> Self;
    /// Overwrite `bytes` at `offset` of the data (extends with zeros if needed).
    fn patch_data(self, offset: usize, bytes: &[u8]) -> Self;
    /// Cut the data to `n` bytes.
    fn truncate_data(self, n: usize) -> Self;
    /// Append bytes to the data.
    fn append_data(self, bytes: &[u8]) -> Self;
    /// Change the target program id.
    fn with_program(self, program: Pubkey) -> Self;
}

impl IxExt for Instruction {
    fn with_account(mut self, idx: usize, key: Pubkey) -> Self {
        self.accounts[idx].pubkey = key;
        self
    }

    fn with_signer(mut self, idx: usize, is_signer: bool) -> Self {
        self.accounts[idx].is_signer = is_signer;
        self
    }

    fn with_writable(mut self, idx: usize, is_writable: bool) -> Self {
        self.accounts[idx].is_writable = is_writable;
        self
    }

    fn without_account(mut self, idx: usize) -> Self {
        self.accounts.remove(idx);
        self
    }

    fn truncate_accounts(mut self, n: usize) -> Self {
        self.accounts.truncate(n);
        self
    }

    fn with_extra_account(mut self, key: Pubkey) -> Self {
        self.accounts.push(AccountMeta::new_readonly(key, false));
        self
    }

    fn with_data(mut self, data: &[u8]) -> Self {
        self.data = data.to_vec();
        self
    }

    fn patch_data(mut self, offset: usize, bytes: &[u8]) -> Self {
        if self.data.len() < offset + bytes.len() {
            self.data.resize(offset + bytes.len(), 0);
        }
        self.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        self
    }

    fn truncate_data(mut self, n: usize) -> Self {
        self.data.truncate(n);
        self
    }

    fn append_data(mut self, bytes: &[u8]) -> Self {
        self.data.extend_from_slice(bytes);
        self
    }

    fn with_program(mut self, program: Pubkey) -> Self {
        self.program_id = program;
        self
    }
}
