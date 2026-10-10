//! AgentAuth core instruction builders (mirroring `idl/core-idl.json`) and a decoded view of
//! the 2136-byte mandate account.
//!
//! Offsets come from the `agent_auth` crate constants, so layout drift breaks the build.

use agent_auth::{
    ACCOUNT_SIZE, HEADER_SIZE, OFF_ACTIVE, OFF_AGENT, OFF_EXPIRY, OFF_OWNER, OFF_PERM_LEN,
    PERMISSION_SIZE, P_CALL_COUNT, P_DISCRIMINATORS, P_DISC_LEN, P_PER_TX_LIMIT, P_PROGRAM_ID,
    P_SPEND_LIMIT, P_SPEND_TOTAL,
};
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use super::ids::{mandate_pda, AGENT_AUTH_ID, SYSTEM_ID};

pub const MANDATE_LEN: usize = ACCOUNT_SIZE;

/// Tag 0. Accounts `[owner S W, agent R, mandate W, system R]`, data `[0] + expiry i64`.
pub fn create_mandate_ix(owner: &Pubkey, agent: &Pubkey, expiry: i64) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![0u8];
    data.extend_from_slice(&expiry.to_le_bytes());
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &data,
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*agent, false),
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(SYSTEM_ID, false),
        ],
    )
}

/// Tag 1. Accounts `[owner S, mandate W]`. A non-empty `discs` list is required by the hardened
/// core (an empty list is `EmptyDiscriminators (22)`); the builder does not check.
pub fn add_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
    discs: &[[u8; 8]],
) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![1u8];
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(&spend_limit.to_le_bytes());
    data.extend_from_slice(&per_tx_limit.to_le_bytes());
    data.push(discs.len() as u8);
    for d in discs {
        data.extend_from_slice(d);
    }
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate, false),
        ],
    )
}

/// Tag 2. Removes the WHOLE slot for `target_program` (all discriminators).
pub fn remove_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![2u8];
    data.extend_from_slice(target_program.as_ref());
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate, false),
        ],
    )
}

/// Tag 3 (locked ABI): `[mandate W, owner R, agent R+S]`, data `[3] + target[32] + disc[8] + amount`.
pub fn verify_ix(
    mandate: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    disc: &[u8; 8],
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(disc);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &data,
        vec![
            AccountMeta::new(*mandate, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*agent, true),
        ],
    )
}

/// Tag 4. Accounts `[owner S W, mandate W, system R]`; the hardened core closes the account.
pub fn revoke_mandate_ix(owner: &Pubkey, agent: &Pubkey) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &[4u8],
        vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(SYSTEM_ID, false),
        ],
    )
}

/// Tag 5 (appended by the hardening work). Accounts `[owner S, mandate W]`, data `[5, active]`.
pub fn set_active_ix(owner: &Pubkey, agent: &Pubkey, active: bool) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &[5u8, active as u8],
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate, false),
        ],
    )
}

/// Tag 6 (appended by the hardening work). Updates limits in place WITHOUT resetting counters.
pub fn update_permission_ix(
    owner: &Pubkey,
    agent: &Pubkey,
    target_program: &Pubkey,
    spend_limit: u64,
    per_tx_limit: u64,
) -> Instruction {
    let (mandate, _) = mandate_pda(owner, agent);
    let mut data = vec![6u8];
    data.extend_from_slice(target_program.as_ref());
    data.extend_from_slice(&spend_limit.to_le_bytes());
    data.extend_from_slice(&per_tx_limit.to_le_bytes());
    Instruction::new_with_bytes(
        AGENT_AUTH_ID,
        &data,
        vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(mandate, false),
        ],
    )
}

// ------------------------------------------------------------------ view

/// One decoded permission slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermView {
    pub program: Pubkey,
    pub spend_limit: u64,
    pub per_tx_limit: u64,
    pub spend_total: u64,
    pub call_count: u32,
    pub discriminators: Vec<[u8; 8]>,
}

/// Decoded mandate account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MandateView {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub expiry: i64,
    pub active: bool,
    pub permissions: Vec<PermView>,
}

impl MandateView {
    pub fn parse(data: &[u8]) -> Self {
        assert_eq!(
            data.len(),
            MANDATE_LEN,
            "mandate must be {MANDATE_LEN} bytes"
        );
        let n = u16::from_le_bytes(
            data[OFF_PERM_LEN..OFF_PERM_LEN + 2]
                .try_into()
                .expect("2 bytes"),
        ) as usize;
        let permissions = (0..n)
            .map(|i| {
                let b = HEADER_SIZE + i * PERMISSION_SIZE;
                let disc_len = data[b + P_DISC_LEN] as usize;
                PermView {
                    program: Pubkey::try_from(&data[b + P_PROGRAM_ID..b + P_PROGRAM_ID + 32])
                        .expect("32 bytes"),
                    spend_limit: u64::from_le_bytes(
                        data[b + P_SPEND_LIMIT..b + P_SPEND_LIMIT + 8]
                            .try_into()
                            .expect("8 bytes"),
                    ),
                    per_tx_limit: u64::from_le_bytes(
                        data[b + P_PER_TX_LIMIT..b + P_PER_TX_LIMIT + 8]
                            .try_into()
                            .expect("8 bytes"),
                    ),
                    spend_total: u64::from_le_bytes(
                        data[b + P_SPEND_TOTAL..b + P_SPEND_TOTAL + 8]
                            .try_into()
                            .expect("8 bytes"),
                    ),
                    call_count: u32::from_le_bytes(
                        data[b + P_CALL_COUNT..b + P_CALL_COUNT + 4]
                            .try_into()
                            .expect("4 bytes"),
                    ),
                    discriminators: (0..disc_len)
                        .map(|j| {
                            let o = b + P_DISCRIMINATORS + j * 8;
                            data[o..o + 8].try_into().expect("8 bytes")
                        })
                        .collect(),
                }
            })
            .collect();
        Self {
            owner: Pubkey::try_from(&data[OFF_OWNER..OFF_OWNER + 32]).expect("32 bytes"),
            agent: Pubkey::try_from(&data[OFF_AGENT..OFF_AGENT + 32]).expect("32 bytes"),
            expiry: i64::from_le_bytes(
                data[OFF_EXPIRY..OFF_EXPIRY + 8]
                    .try_into()
                    .expect("8 bytes"),
            ),
            active: data[OFF_ACTIVE] == 1,
            permissions,
        }
    }

    /// The slot for `program`, if any.
    pub fn perm(&self, program: &Pubkey) -> Option<&PermView> {
        self.permissions.iter().find(|p| &p.program == program)
    }
}

/// Write a mandate straight into account data (a "seeded" mandate, as in
/// `tests/common/integration.rs::seed_mandate`) for negative tests that need layouts the real
/// instructions refuse to produce (inactive, expired, wrong length ...).
pub fn seeded_mandate_bytes(
    owner: &Pubkey,
    agent: &Pubkey,
    expiry: i64,
    active: bool,
    perms: &[(Pubkey, u64, u64, Vec<[u8; 8]>)],
) -> Vec<u8> {
    let mut d = vec![0u8; MANDATE_LEN];
    d[agent_auth::OFF_DISC] = agent_auth::MANDATE_DISCRIMINATOR;
    d[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(owner.as_ref());
    d[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(agent.as_ref());
    d[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&expiry.to_le_bytes());
    d[OFF_ACTIVE] = active as u8;
    d[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&(perms.len() as u16).to_le_bytes());
    for (i, (program, spend, per_tx, discs)) in perms.iter().enumerate() {
        let b = HEADER_SIZE + i * PERMISSION_SIZE;
        d[b + P_PROGRAM_ID..b + P_PROGRAM_ID + 32].copy_from_slice(program.as_ref());
        d[b + P_SPEND_LIMIT..b + P_SPEND_LIMIT + 8].copy_from_slice(&spend.to_le_bytes());
        d[b + P_PER_TX_LIMIT..b + P_PER_TX_LIMIT + 8].copy_from_slice(&per_tx.to_le_bytes());
        d[b + P_DISC_LEN] = discs.len() as u8;
        for (j, disc) in discs.iter().enumerate() {
            let o = b + P_DISCRIMINATORS + j * 8;
            d[o..o + 8].copy_from_slice(disc);
        }
    }
    d
}
