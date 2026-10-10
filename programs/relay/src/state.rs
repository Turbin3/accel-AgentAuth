//! Byte layouts the relay reads and writes: the 944-byte `RelayPolicy`
//! (RELAY-SPEC section 5.2) and the handful of AgentAuth mandate offsets
//! (section 4). Offsets are `const`s; CORE-12 / FE-06 host tests pin them
//! against the core crate and `golden/policy_example.bin`.
//!
//! The 800-byte config region (`policy[144..944]`) is exactly bytes
//! `[2..802)` of the `init_policy` instruction data, so one parser
//! ([`Config`]) serves both the instruction data and the stored policy.

use pinocchio::pubkey::Pubkey;

use crate::bytes::{byte_at, key_at, same_key, slice_at, u32_at, u64_at};
use crate::error::RelayError;
use crate::ids::{is_token_program, NATIVE_MINT};

// ---- AgentAuth mandate offsets (core layout, locked) ------------------------

/// Mandate discriminator offset (value must be 1).
pub const MANDATE_OFF_DISC: usize = 0;
/// Mandate owner key offset.
pub const MANDATE_OFF_OWNER: usize = 1;
/// Mandate agent key offset.
pub const MANDATE_OFF_AGENT: usize = 33;
/// Mandate expiry (i64 LE) offset.
pub const MANDATE_OFF_EXPIRY: usize = 65;
/// Mandate `active` byte offset.
pub const MANDATE_OFF_ACTIVE: usize = 73;
/// Mandate account length.
pub const MANDATE_LEN: usize = 2136;
/// Value of the mandate discriminator byte.
pub const MANDATE_DISC: u8 = 1;

// ---- RelayPolicy identity header [0, 144) -----------------------------------

/// Policy account length.
pub const POLICY_LEN: usize = 944;
/// Policy discriminator value.
pub const POLICY_DISC: u8 = 0xA7;
/// Policy layout version.
pub const POLICY_VERSION: u8 = 1;
/// Offset of the discriminator byte.
pub const OFF_DISC: usize = 0;
/// Offset of the version byte.
pub const OFF_VERSION: usize = 1;
/// Offset of the stored policy PDA bump.
pub const OFF_POLICY_BUMP: usize = 2;
/// Offset of the stored authority PDA bump.
pub const OFF_AUTHORITY_BUMP: usize = 3;
/// Offset of the flags byte.
pub const OFF_FLAGS: usize = 4;
/// Offset of the mandate key.
pub const OFF_MANDATE: usize = 8;
/// Offset of the owner key.
pub const OFF_OWNER: usize = 40;
/// Offset of the agent key.
pub const OFF_AGENT: usize = 72;
/// Offset of the authority PDA key.
pub const OFF_AUTHORITY: usize = 104;
/// Offset of the copied mandate expiry (i64 LE).
pub const OFF_MANDATE_EXPIRY: usize = 136;

/// Flag bit 0: the policy is paused (owner kill switch, reversible).
pub const FLAG_PAUSED: u8 = 0b01;
/// Flag bit 1: refuse to run unless the relay is a top-level instruction.
pub const FLAG_STRICT_TOP_LEVEL: u8 = 0b10;
/// Flag bits that must be zero.
pub const FLAGS_RESERVED_MASK: u8 = 0xFC;

// ---- Config region [144, 944) ----------------------------------------------

/// Offset of the config region inside the policy.
pub const CONFIG_OFF: usize = 144;
/// Length of the config region (and of the `init_policy` config payload).
pub const CONFIG_LEN: usize = 800;
/// Maximum number of recipients.
pub const MAX_RECIPIENTS: usize = 8;
/// Largest accepted `max_deadline_slots`.
pub const MAX_DEADLINE_SLOTS_CAP: u32 = 9000;

// Config-relative offsets (policy offset = CONFIG_OFF + value).
const C_TOKEN_PROGRAM: usize = 0;
const C_BUDGET_MINT: usize = 32;
const C_SOURCE: usize = 64;
const C_RECIPIENTS_LEN: usize = 96;
const C_SWAP_ENABLED: usize = 97;
const C_RESERVED1: usize = 98;
const C_RECIPIENTS: usize = 104;
const C_AMM_PROGRAM: usize = 360;
const C_AMM_AUTHORITY: usize = 392;
const C_AMM_CONFIG: usize = 424;
const C_POOL_STATE: usize = 456;
const C_INPUT_VAULT: usize = 488;
const C_OUTPUT_VAULT: usize = 520;
const C_OBSERVATION_STATE: usize = 552;
const C_IN_MINT: usize = 584;
const C_OUT_MINT: usize = 616;
const C_IN_TOKEN_PROGRAM: usize = 648;
const C_OUT_TOKEN_PROGRAM: usize = 680;
const C_IN_ACCOUNT: usize = 712;
const C_OUT_ACCOUNT: usize = 744;
const C_FLOOR_OUT: usize = 776;
const C_FLOOR_IN: usize = 784;
const C_MAX_DEADLINE: usize = 792;
const C_RESERVED2: usize = 796;

/// Policy offset of `token_program`.
pub const OFF_TOKEN_PROGRAM: usize = CONFIG_OFF + C_TOKEN_PROGRAM;
/// Policy offset of `budget_mint`.
pub const OFF_BUDGET_MINT: usize = CONFIG_OFF + C_BUDGET_MINT;
/// Policy offset of `source_account`.
pub const OFF_SOURCE: usize = CONFIG_OFF + C_SOURCE;
/// Policy offset of `recipients_len`.
pub const OFF_RECIPIENTS_LEN: usize = CONFIG_OFF + C_RECIPIENTS_LEN;
/// Policy offset of `swap_enabled`.
pub const OFF_SWAP_ENABLED: usize = CONFIG_OFF + C_SWAP_ENABLED;
/// Policy offset of `recipients`.
pub const OFF_RECIPIENTS: usize = CONFIG_OFF + C_RECIPIENTS;
/// Policy offset of `amm_program`.
pub const OFF_AMM_PROGRAM: usize = CONFIG_OFF + C_AMM_PROGRAM;
/// Policy offset of `amm_authority`.
pub const OFF_AMM_AUTHORITY: usize = CONFIG_OFF + C_AMM_AUTHORITY;
/// Policy offset of `amm_config`.
pub const OFF_AMM_CONFIG: usize = CONFIG_OFF + C_AMM_CONFIG;
/// Policy offset of `pool_state`.
pub const OFF_POOL_STATE: usize = CONFIG_OFF + C_POOL_STATE;
/// Policy offset of `input_vault`.
pub const OFF_INPUT_VAULT: usize = CONFIG_OFF + C_INPUT_VAULT;
/// Policy offset of `output_vault`.
pub const OFF_OUTPUT_VAULT: usize = CONFIG_OFF + C_OUTPUT_VAULT;
/// Policy offset of `observation_state`.
pub const OFF_OBSERVATION_STATE: usize = CONFIG_OFF + C_OBSERVATION_STATE;
/// Policy offset of `in_mint`.
pub const OFF_IN_MINT: usize = CONFIG_OFF + C_IN_MINT;
/// Policy offset of `out_mint`.
pub const OFF_OUT_MINT: usize = CONFIG_OFF + C_OUT_MINT;
/// Policy offset of `in_token_program`.
pub const OFF_IN_TOKEN_PROGRAM: usize = CONFIG_OFF + C_IN_TOKEN_PROGRAM;
/// Policy offset of `out_token_program`.
pub const OFF_OUT_TOKEN_PROGRAM: usize = CONFIG_OFF + C_OUT_TOKEN_PROGRAM;
/// Policy offset of `in_account`.
pub const OFF_IN_ACCOUNT: usize = CONFIG_OFF + C_IN_ACCOUNT;
/// Policy offset of `out_account`.
pub const OFF_OUT_ACCOUNT: usize = CONFIG_OFF + C_OUT_ACCOUNT;
/// Policy offset of `floor_out`.
pub const OFF_FLOOR_OUT: usize = CONFIG_OFF + C_FLOOR_OUT;
/// Policy offset of `floor_in`.
pub const OFF_FLOOR_IN: usize = CONFIG_OFF + C_FLOOR_IN;
/// Policy offset of `max_deadline_slots`.
pub const OFF_MAX_DEADLINE_SLOTS: usize = CONFIG_OFF + C_MAX_DEADLINE;
/// Policy offset of `reserved2`.
pub const OFF_RESERVED2: usize = CONFIG_OFF + C_RESERVED2;

/// Identity keys `init_policy` binds the config to (all must be pairwise
/// distinct from the config keys, RELAY-SPEC section 5.2).
pub struct IdentityKeys<'a> {
    /// AgentAuth mandate key.
    pub mandate: &'a Pubkey,
    /// Policy PDA key.
    pub policy: &'a Pubkey,
    /// Authority PDA key.
    pub authority: &'a Pubkey,
    /// Owner key (from the mandate).
    pub owner: &'a Pubkey,
    /// Agent key (from the mandate).
    pub agent: &'a Pubkey,
}

/// Read-only view over the 800-byte config region.
#[derive(Clone, Copy)]
pub struct Config<'a>(&'a [u8]);

impl<'a> Config<'a> {
    /// Wrap `bytes`; `None` unless exactly [`CONFIG_LEN`] bytes.
    pub fn new(bytes: &'a [u8]) -> Option<Self> {
        (bytes.len() == CONFIG_LEN).then_some(Self(bytes))
    }

    /// Raw config bytes.
    pub fn as_bytes(&self) -> &'a [u8] {
        self.0
    }

    /// SPL program that owns the budget accounts.
    pub fn token_program(&self) -> &'a Pubkey {
        key_at(self.0, C_TOKEN_PROGRAM)
    }
    /// Mint of the transfer budget.
    pub fn budget_mint(&self) -> &'a Pubkey {
        key_at(self.0, C_BUDGET_MINT)
    }
    /// The owner's token account the agent may spend from.
    pub fn source_account(&self) -> &'a Pubkey {
        key_at(self.0, C_SOURCE)
    }
    /// Number of used recipient slots.
    pub fn recipients_len(&self) -> usize {
        usize::from(byte_at(self.0, C_RECIPIENTS_LEN))
    }
    /// Whether `swap` is enabled (0 or 1).
    pub fn swap_enabled(&self) -> u8 {
        byte_at(self.0, C_SWAP_ENABLED)
    }
    /// Recipient slot `i` (zero key if out of range).
    pub fn recipient(&self, i: usize) -> &'a Pubkey {
        key_at(self.0, C_RECIPIENTS.saturating_add(i.saturating_mul(32)))
    }
    /// Is `key` one of the first `recipients_len` recipients?
    pub fn is_recipient(&self, key: &Pubkey) -> bool {
        let n = self.recipients_len().min(MAX_RECIPIENTS);
        (0..n).any(|i| self.recipient(i) == key)
    }
    /// Pinned AMM program.
    pub fn amm_program(&self) -> &'a Pubkey {
        key_at(self.0, C_AMM_PROGRAM)
    }
    /// Pinned AMM pool authority.
    pub fn amm_authority(&self) -> &'a Pubkey {
        key_at(self.0, C_AMM_AUTHORITY)
    }
    /// Pinned AMM config.
    pub fn amm_config(&self) -> &'a Pubkey {
        key_at(self.0, C_AMM_CONFIG)
    }
    /// Pinned pool state.
    pub fn pool_state(&self) -> &'a Pubkey {
        key_at(self.0, C_POOL_STATE)
    }
    /// Pinned input vault.
    pub fn input_vault(&self) -> &'a Pubkey {
        key_at(self.0, C_INPUT_VAULT)
    }
    /// Pinned output vault.
    pub fn output_vault(&self) -> &'a Pubkey {
        key_at(self.0, C_OUTPUT_VAULT)
    }
    /// Pinned observation state.
    pub fn observation_state(&self) -> &'a Pubkey {
        key_at(self.0, C_OBSERVATION_STATE)
    }
    /// Swap input mint.
    pub fn in_mint(&self) -> &'a Pubkey {
        key_at(self.0, C_IN_MINT)
    }
    /// Swap output mint.
    pub fn out_mint(&self) -> &'a Pubkey {
        key_at(self.0, C_OUT_MINT)
    }
    /// Token program of the input mint.
    pub fn in_token_program(&self) -> &'a Pubkey {
        key_at(self.0, C_IN_TOKEN_PROGRAM)
    }
    /// Token program of the output mint.
    pub fn out_token_program(&self) -> &'a Pubkey {
        key_at(self.0, C_OUT_TOKEN_PROGRAM)
    }
    /// The owner's swap input token account.
    pub fn in_account(&self) -> &'a Pubkey {
        key_at(self.0, C_IN_ACCOUNT)
    }
    /// The owner's swap output token account.
    pub fn out_account(&self) -> &'a Pubkey {
        key_at(self.0, C_OUT_ACCOUNT)
    }
    /// Floor price numerator (output units).
    pub fn floor_out(&self) -> u64 {
        u64_at(self.0, C_FLOOR_OUT)
    }
    /// Floor price denominator (input units).
    pub fn floor_in(&self) -> u64 {
        u64_at(self.0, C_FLOOR_IN)
    }
    /// Maximum allowed distance between the current slot and the deadline.
    pub fn max_deadline_slots(&self) -> u32 {
        u32_at(self.0, C_MAX_DEADLINE)
    }

    /// Validate the config per RELAY-SPEC section 5.2 (every failure is
    /// `InvalidConfig`). `amm_ok` decides whether an AMM program id is on the
    /// compiled allowlist; it is a parameter so host tests can exercise the
    /// golden vector whose AMM id is a fake key.
    pub fn validate(
        &self,
        id: &IdentityKeys,
        amm_ok: fn(&Pubkey) -> bool,
    ) -> Result<(), RelayError> {
        let bad = RelayError::InvalidConfig;
        let zero = [0u8; 32];

        if !is_token_program(self.token_program()) {
            return Err(bad);
        }
        if self.budget_mint() == &zero || self.budget_mint() == &NATIVE_MINT {
            return Err(bad);
        }
        if self.source_account() == &zero {
            return Err(bad);
        }
        let n = self.recipients_len();
        if n > MAX_RECIPIENTS || self.swap_enabled() > 1 {
            return Err(bad);
        }
        if !all_zero(slice_at(self.0, C_RESERVED1, C_RECIPIENTS - C_RESERVED1)) {
            return Err(bad);
        }
        for i in 0..MAX_RECIPIENTS {
            let is_zero = self.recipient(i) == &zero;
            // The first `n` slots are non-zero, the rest are zero.
            if (i < n) == is_zero {
                return Err(bad);
            }
        }

        if self.swap_enabled() == 0 {
            // Canonical form: every swap field, the floor, the deadline and
            // reserved2 are zero.
            if !all_zero(slice_at(self.0, C_AMM_PROGRAM, CONFIG_LEN - C_AMM_PROGRAM)) {
                return Err(bad);
            }
        } else {
            self.validate_swap(amm_ok)?;
        }
        self.validate_distinct(id)
    }

    fn validate_swap(&self, amm_ok: fn(&Pubkey) -> bool) -> Result<(), RelayError> {
        let bad = RelayError::InvalidConfig;
        let zero = [0u8; 32];
        if !amm_ok(self.amm_program()) {
            return Err(bad);
        }
        for k in [
            self.amm_authority(),
            self.amm_config(),
            self.pool_state(),
            self.input_vault(),
            self.output_vault(),
            self.observation_state(),
            self.in_mint(),
            self.out_mint(),
            self.in_account(),
            self.out_account(),
        ] {
            if k == &zero {
                return Err(bad);
            }
        }
        if self.in_mint() == &NATIVE_MINT || self.in_mint() == self.out_mint() {
            return Err(bad);
        }
        if !is_token_program(self.in_token_program()) || !is_token_program(self.out_token_program())
        {
            return Err(bad);
        }
        if self.in_account() == self.out_account() || self.out_account() == self.source_account() {
            return Err(bad);
        }
        if self.in_account() == self.source_account()
            && (self.in_mint() != self.budget_mint()
                || self.in_token_program() != self.token_program())
        {
            return Err(bad);
        }
        if self.floor_out() == 0 || self.floor_in() == 0 {
            return Err(bad);
        }
        let d = self.max_deadline_slots();
        if d == 0 || d > MAX_DEADLINE_SLOTS_CAP {
            return Err(bad);
        }
        if !all_zero(slice_at(self.0, C_RESERVED2, 4)) {
            return Err(bad);
        }
        Ok(())
    }

    /// Pairwise distinctness over identity keys, source, recipients and (when
    /// swap is enabled) the swap accounts. The single permitted exception is
    /// `in_account == source_account`.
    fn validate_distinct(&self, id: &IdentityKeys) -> Result<(), RelayError> {
        let mut set = KeySet::new();
        set.push(id.mandate)?;
        set.push(id.policy)?;
        set.push(id.authority)?;
        set.push(id.owner)?;
        set.push(id.agent)?;
        set.push(self.source_account())?;
        for i in 0..self.recipients_len().min(MAX_RECIPIENTS) {
            set.push(self.recipient(i))?;
        }
        if self.swap_enabled() == 1 {
            for k in [
                self.amm_program(),
                self.amm_authority(),
                self.amm_config(),
                self.pool_state(),
                self.input_vault(),
                self.output_vault(),
                self.observation_state(),
                self.out_account(),
            ] {
                set.push(k)?;
            }
            if self.in_account() != self.source_account() {
                set.push(self.in_account())?;
            }
        }
        if set.all_distinct() {
            Ok(())
        } else {
            Err(RelayError::InvalidConfig)
        }
    }
}

/// Bounded set of key references used by the distinctness rule.
struct KeySet<'k> {
    keys: [&'k Pubkey; KeySet::CAP],
    count: usize,
}

impl<'k> KeySet<'k> {
    /// 5 identity keys + source + 8 recipients + 9 swap accounts.
    const CAP: usize = 5 + 1 + MAX_RECIPIENTS + 9;

    fn new() -> Self {
        Self {
            keys: [&[0u8; 32]; Self::CAP],
            count: 0,
        }
    }

    fn push(&mut self, k: &'k Pubkey) -> Result<(), RelayError> {
        let slot = self
            .keys
            .get_mut(self.count)
            .ok_or(RelayError::InvalidConfig)?;
        *slot = k;
        self.count = self.count.saturating_add(1);
        Ok(())
    }

    fn all_distinct(&self) -> bool {
        let used = self.keys.get(..self.count).unwrap_or(&[]);
        used.iter().enumerate().all(|(i, a)| {
            used.iter()
                .skip(i.saturating_add(1))
                .all(|b| !same_key(a, b))
        })
    }
}

fn all_zero(b: &[u8]) -> bool {
    b.iter().all(|x| *x == 0)
}

/// Read-only view over a 944-byte policy account.
#[derive(Clone, Copy)]
pub struct Policy<'a> {
    data: &'a [u8],
    cfg: Config<'a>,
}

impl<'a> Policy<'a> {
    /// Wrap `data`; `None` unless exactly [`POLICY_LEN`] bytes. Does not check
    /// the discriminator (see `checks::check_policy`).
    pub fn new(data: &'a [u8]) -> Option<Self> {
        if data.len() != POLICY_LEN {
            return None;
        }
        let cfg = Config::new(data.get(CONFIG_OFF..)?)?;
        Some(Self { data, cfg })
    }

    /// The config region.
    pub fn config(&self) -> Config<'a> {
        self.cfg
    }
    /// Discriminator byte.
    pub fn disc(&self) -> u8 {
        byte_at(self.data, OFF_DISC)
    }
    /// Layout version byte.
    pub fn version(&self) -> u8 {
        byte_at(self.data, OFF_VERSION)
    }
    /// Stored authority PDA bump.
    pub fn authority_bump(&self) -> u8 {
        byte_at(self.data, OFF_AUTHORITY_BUMP)
    }
    /// Flags byte.
    pub fn flags(&self) -> u8 {
        byte_at(self.data, OFF_FLAGS)
    }
    /// Bound mandate key.
    pub fn mandate(&self) -> &'a Pubkey {
        key_at(self.data, OFF_MANDATE)
    }
    /// Bound owner key.
    pub fn owner(&self) -> &'a Pubkey {
        key_at(self.data, OFF_OWNER)
    }
    /// Bound agent key.
    pub fn agent(&self) -> &'a Pubkey {
        key_at(self.data, OFF_AGENT)
    }
    /// Authority PDA key.
    pub fn authority(&self) -> &'a Pubkey {
        key_at(self.data, OFF_AUTHORITY)
    }
    /// Mandate expiry (raw i64 LE bytes) copied at init.
    pub fn mandate_expiry_bytes(&self) -> &'a [u8] {
        slice_at(self.data, OFF_MANDATE_EXPIRY, 8)
    }
}

/// Fields of the identity header written by `init_policy`.
pub struct Header<'a> {
    /// Stored policy PDA bump.
    pub policy_bump: u8,
    /// Stored authority PDA bump.
    pub authority_bump: u8,
    /// Initial flags (bit0, bit1 only).
    pub flags: u8,
    /// Mandate key.
    pub mandate: &'a Pubkey,
    /// Owner key.
    pub owner: &'a Pubkey,
    /// Agent key.
    pub agent: &'a Pubkey,
    /// Authority PDA key.
    pub authority: &'a Pubkey,
    /// Mandate expiry, raw i64 LE bytes (mandate `[65..73]`).
    pub mandate_expiry: &'a [u8],
}

/// Write the full policy (header + config) into `buf`, which must be the
/// freshly allocated all-zero 944 bytes. Returns `None` on any size mismatch.
pub fn write_policy(buf: &mut [u8], h: &Header, config: &[u8]) -> Option<()> {
    if buf.len() != POLICY_LEN || config.len() != CONFIG_LEN || h.mandate_expiry.len() != 8 {
        return None;
    }
    *buf.get_mut(OFF_DISC)? = POLICY_DISC;
    *buf.get_mut(OFF_VERSION)? = POLICY_VERSION;
    *buf.get_mut(OFF_POLICY_BUMP)? = h.policy_bump;
    *buf.get_mut(OFF_AUTHORITY_BUMP)? = h.authority_bump;
    *buf.get_mut(OFF_FLAGS)? = h.flags;
    buf.get_mut(OFF_MANDATE..OFF_MANDATE + 32)?
        .copy_from_slice(h.mandate);
    buf.get_mut(OFF_OWNER..OFF_OWNER + 32)?
        .copy_from_slice(h.owner);
    buf.get_mut(OFF_AGENT..OFF_AGENT + 32)?
        .copy_from_slice(h.agent);
    buf.get_mut(OFF_AUTHORITY..OFF_AUTHORITY + 32)?
        .copy_from_slice(h.authority);
    buf.get_mut(OFF_MANDATE_EXPIRY..OFF_MANDATE_EXPIRY + 8)?
        .copy_from_slice(h.mandate_expiry);
    buf.get_mut(CONFIG_OFF..)?.copy_from_slice(config);
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{NATIVE_MINT, TOKEN22_ID, TOKEN_ID};

    const AMM: Pubkey = [0x71; 32];
    const ID: IdentityKeys<'static> = IdentityKeys {
        mandate: &[0x11; 32],
        policy: &[0x12; 32],
        authority: &[0x44; 32],
        owner: &[0x22; 32],
        agent: &[0x33; 32],
    };

    fn allow_amm(k: &Pubkey) -> bool {
        k == &AMM
    }

    fn put(c: &mut [u8], off: usize, v: &[u8]) {
        let o = off - CONFIG_OFF;
        c[o..o + v.len()].copy_from_slice(v);
    }

    /// A valid swap-enabled config; `in_account != source_account`.
    fn valid_swap() -> Vec<u8> {
        let mut c = vec![0u8; CONFIG_LEN];
        put(&mut c, OFF_TOKEN_PROGRAM, &TOKEN_ID);
        put(&mut c, OFF_BUDGET_MINT, &[0x55; 32]);
        put(&mut c, OFF_SOURCE, &[0x66; 32]);
        put(&mut c, OFF_RECIPIENTS_LEN, &[2]);
        put(&mut c, OFF_RECIPIENTS, &[0x61; 32]);
        put(&mut c, OFF_RECIPIENTS + 32, &[0x62; 32]);
        put(&mut c, OFF_SWAP_ENABLED, &[1]);
        put(&mut c, OFF_AMM_PROGRAM, &AMM);
        put(&mut c, OFF_AMM_AUTHORITY, &[0x72; 32]);
        put(&mut c, OFF_AMM_CONFIG, &[0x73; 32]);
        put(&mut c, OFF_POOL_STATE, &[0x74; 32]);
        put(&mut c, OFF_INPUT_VAULT, &[0x75; 32]);
        put(&mut c, OFF_OUTPUT_VAULT, &[0x76; 32]);
        put(&mut c, OFF_OBSERVATION_STATE, &[0x77; 32]);
        put(&mut c, OFF_IN_MINT, &[0x78; 32]);
        put(&mut c, OFF_OUT_MINT, &[0x79; 32]);
        put(&mut c, OFF_IN_TOKEN_PROGRAM, &TOKEN_ID);
        put(&mut c, OFF_OUT_TOKEN_PROGRAM, &TOKEN22_ID);
        put(&mut c, OFF_IN_ACCOUNT, &[0x7b; 32]);
        put(&mut c, OFF_OUT_ACCOUNT, &[0x7a; 32]);
        put(&mut c, OFF_FLOOR_OUT, &95u64.to_le_bytes());
        put(&mut c, OFF_FLOOR_IN, &100u64.to_le_bytes());
        put(&mut c, OFF_MAX_DEADLINE_SLOTS, &150u32.to_le_bytes());
        c
    }

    /// A valid swap-disabled config in canonical form.
    fn valid_transfer_only() -> Vec<u8> {
        let mut c = vec![0u8; CONFIG_LEN];
        put(&mut c, OFF_TOKEN_PROGRAM, &TOKEN_ID);
        put(&mut c, OFF_BUDGET_MINT, &[0x55; 32]);
        put(&mut c, OFF_SOURCE, &[0x66; 32]);
        put(&mut c, OFF_RECIPIENTS_LEN, &[1]);
        put(&mut c, OFF_RECIPIENTS, &[0x61; 32]);
        c
    }

    fn validate(c: &[u8]) -> Result<(), RelayError> {
        Config::new(c)
            .ok_or(RelayError::InvalidInstructionData)?
            .validate(&ID, allow_amm)
    }

    #[test]
    fn valid_configs_pass() {
        assert_eq!(validate(&valid_swap()), Ok(()));
        assert_eq!(validate(&valid_transfer_only()), Ok(()));

        // Zero recipients is allowed (swap-only policy).
        let mut c = valid_swap();
        put(&mut c, OFF_RECIPIENTS_LEN, &[0]);
        put(&mut c, OFF_RECIPIENTS, &[0u8; 64]);
        assert_eq!(validate(&c), Ok(()));

        // Eight distinct recipients.
        let mut c = valid_transfer_only();
        put(&mut c, OFF_RECIPIENTS_LEN, &[8]);
        for i in 0..8u8 {
            put(
                &mut c,
                OFF_RECIPIENTS + usize::from(i) * 32,
                &[0xA0 + i; 32],
            );
        }
        assert_eq!(validate(&c), Ok(()));

        // Native mint is allowed as the swap OUTPUT mint.
        let mut c = valid_swap();
        put(&mut c, OFF_OUT_MINT, &NATIVE_MINT);
        assert_eq!(validate(&c), Ok(()));

        // Token-2022 budget.
        let mut c = valid_transfer_only();
        put(&mut c, OFF_TOKEN_PROGRAM, &TOKEN22_ID);
        assert_eq!(validate(&c), Ok(()));

        // in_account == source_account is the one permitted alias, when the
        // mint and token program match the budget.
        let mut c = valid_swap();
        put(&mut c, OFF_IN_ACCOUNT, &[0x66; 32]);
        put(&mut c, OFF_IN_MINT, &[0x55; 32]);
        assert_eq!(validate(&c), Ok(()));

        // Boundary deadlines.
        for d in [1u32, 9000] {
            let mut c = valid_swap();
            put(&mut c, OFF_MAX_DEADLINE_SLOTS, &d.to_le_bytes());
            assert_eq!(validate(&c), Ok(()), "deadline {d}");
        }
    }

    /// PL-05: each row alone makes an otherwise valid config invalid.
    #[test]
    fn invalid_config_table() {
        type Mutate = Box<dyn Fn(&mut Vec<u8>)>;
        let rows: Vec<(&str, Mutate)> = vec![
            (
                "recipients_len 9",
                Box::new(|c| put(c, OFF_RECIPIENTS_LEN, &[9])),
            ),
            (
                "recipients_len 255",
                Box::new(|c| put(c, OFF_RECIPIENTS_LEN, &[255])),
            ),
            (
                "duplicate recipient",
                Box::new(|c| put(c, OFF_RECIPIENTS + 32, &[0x61; 32])),
            ),
            (
                "recipient == source",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x66; 32])),
            ),
            (
                "recipient == mandate",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x11; 32])),
            ),
            (
                "recipient == policy",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x12; 32])),
            ),
            (
                "recipient == authority",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x44; 32])),
            ),
            (
                "recipient == owner",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x22; 32])),
            ),
            (
                "recipient == agent",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0x33; 32])),
            ),
            ("zero source", Box::new(|c| put(c, OFF_SOURCE, &[0u8; 32]))),
            (
                "source == owner",
                Box::new(|c| put(c, OFF_SOURCE, &[0x22; 32])),
            ),
            (
                "zero recipient inside len",
                Box::new(|c| put(c, OFF_RECIPIENTS, &[0u8; 32])),
            ),
            (
                "non-zero recipient beyond len",
                Box::new(|c| put(c, OFF_RECIPIENTS + 64, &[0x63; 32])),
            ),
            (
                "floor_in 0",
                Box::new(|c| put(c, OFF_FLOOR_IN, &0u64.to_le_bytes())),
            ),
            (
                "floor_out 0",
                Box::new(|c| put(c, OFF_FLOOR_OUT, &0u64.to_le_bytes())),
            ),
            (
                "in_mint == out_mint",
                Box::new(|c| put(c, OFF_OUT_MINT, &[0x78; 32])),
            ),
            (
                "input_vault == output_vault",
                Box::new(|c| put(c, OFF_OUTPUT_VAULT, &[0x75; 32])),
            ),
            (
                "non-zero reserved1",
                Box::new(|c| put(c, CONFIG_OFF + 98, &[1])),
            ),
            (
                "non-zero reserved2",
                Box::new(|c| put(c, OFF_RESERVED2, &[1])),
            ),
            (
                "swap_enabled 2",
                Box::new(|c| put(c, OFF_SWAP_ENABLED, &[2])),
            ),
            (
                "token_program not Token",
                Box::new(|c| put(c, OFF_TOKEN_PROGRAM, &[9u8; 32])),
            ),
            (
                "zero token_program",
                Box::new(|c| put(c, OFF_TOKEN_PROGRAM, &[0u8; 32])),
            ),
            (
                "budget_mint native",
                Box::new(|c| put(c, OFF_BUDGET_MINT, &NATIVE_MINT)),
            ),
            (
                "zero budget_mint",
                Box::new(|c| put(c, OFF_BUDGET_MINT, &[0u8; 32])),
            ),
            (
                "in_mint native",
                Box::new(|c| put(c, OFF_IN_MINT, &NATIVE_MINT)),
            ),
            (
                "max_deadline_slots 0",
                Box::new(|c| put(c, OFF_MAX_DEADLINE_SLOTS, &0u32.to_le_bytes())),
            ),
            (
                "max_deadline_slots 9001",
                Box::new(|c| put(c, OFF_MAX_DEADLINE_SLOTS, &9001u32.to_le_bytes())),
            ),
            (
                "amm not on allowlist",
                Box::new(|c| put(c, OFF_AMM_PROGRAM, &[0x99; 32])),
            ),
            (
                "zero amm_program",
                Box::new(|c| put(c, OFF_AMM_PROGRAM, &[0u8; 32])),
            ),
            (
                "zero pool_state",
                Box::new(|c| put(c, OFF_POOL_STATE, &[0u8; 32])),
            ),
            (
                "zero observation_state",
                Box::new(|c| put(c, OFF_OBSERVATION_STATE, &[0u8; 32])),
            ),
            (
                "zero amm_authority",
                Box::new(|c| put(c, OFF_AMM_AUTHORITY, &[0u8; 32])),
            ),
            (
                "zero amm_config",
                Box::new(|c| put(c, OFF_AMM_CONFIG, &[0u8; 32])),
            ),
            (
                "zero in_mint",
                Box::new(|c| put(c, OFF_IN_MINT, &[0u8; 32])),
            ),
            (
                "zero out_mint",
                Box::new(|c| put(c, OFF_OUT_MINT, &[0u8; 32])),
            ),
            (
                "zero in_account",
                Box::new(|c| put(c, OFF_IN_ACCOUNT, &[0u8; 32])),
            ),
            (
                "zero out_account",
                Box::new(|c| put(c, OFF_OUT_ACCOUNT, &[0u8; 32])),
            ),
            (
                "in_token_program invalid",
                Box::new(|c| put(c, OFF_IN_TOKEN_PROGRAM, &[9u8; 32])),
            ),
            (
                "out_token_program invalid",
                Box::new(|c| put(c, OFF_OUT_TOKEN_PROGRAM, &[0u8; 32])),
            ),
            (
                "in_account == out_account",
                Box::new(|c| put(c, OFF_IN_ACCOUNT, &[0x7a; 32])),
            ),
            (
                "out_account == source",
                Box::new(|c| put(c, OFF_OUT_ACCOUNT, &[0x66; 32])),
            ),
            (
                "in_account == source, in_mint != budget_mint",
                Box::new(|c| put(c, OFF_IN_ACCOUNT, &[0x66; 32])),
            ),
            (
                "in_account == source, in_token_program != token_program",
                Box::new(|c| {
                    put(c, OFF_IN_ACCOUNT, &[0x66; 32]);
                    put(c, OFF_IN_MINT, &[0x55; 32]);
                    put(c, OFF_IN_TOKEN_PROGRAM, &TOKEN22_ID);
                }),
            ),
            (
                "pool_state == in_account",
                Box::new(|c| put(c, OFF_POOL_STATE, &[0x7b; 32])),
            ),
            (
                "pool_state == recipient",
                Box::new(|c| put(c, OFF_POOL_STATE, &[0x61; 32])),
            ),
            (
                "amm_authority == owner",
                Box::new(|c| put(c, OFF_AMM_AUTHORITY, &[0x22; 32])),
            ),
            (
                "observation == mandate",
                Box::new(|c| put(c, OFF_OBSERVATION_STATE, &[0x11; 32])),
            ),
            (
                "amm_config == authority",
                Box::new(|c| put(c, OFF_AMM_CONFIG, &[0x44; 32])),
            ),
            (
                "in_account == agent",
                Box::new(|c| put(c, OFF_IN_ACCOUNT, &[0x33; 32])),
            ),
        ];
        for (name, mutate) in &rows {
            let mut c = valid_swap();
            mutate(&mut c);
            assert_eq!(validate(&c), Err(RelayError::InvalidConfig), "row: {name}");
        }
    }

    /// Canonical form: with swap disabled, any non-zero byte in 504..944 is rejected.
    #[test]
    fn swap_disabled_requires_canonical_zero_tail() {
        for off in (OFF_AMM_PROGRAM..POLICY_LEN)
            .step_by(7)
            .chain([POLICY_LEN - 1])
        {
            let mut c = valid_transfer_only();
            put(&mut c, off, &[1]);
            assert_eq!(validate(&c), Err(RelayError::InvalidConfig), "offset {off}");
        }
        // And a stray swap field with swap_enabled == 0, by name.
        let mut c = valid_transfer_only();
        put(&mut c, OFF_AMM_PROGRAM, &AMM);
        assert_eq!(validate(&c), Err(RelayError::InvalidConfig));
    }

    /// Every byte of the reserved ranges is rejected when set (INV-03, partial).
    #[test]
    fn reserved_bytes_are_rejected() {
        for off in CONFIG_OFF + 98..CONFIG_OFF + 104 {
            let mut c = valid_swap();
            put(&mut c, off, &[1]);
            assert_eq!(validate(&c), Err(RelayError::InvalidConfig), "offset {off}");
        }
        for off in OFF_RESERVED2..OFF_RESERVED2 + 4 {
            let mut c = valid_swap();
            put(&mut c, off, &[1]);
            assert_eq!(validate(&c), Err(RelayError::InvalidConfig), "offset {off}");
        }
    }

    #[test]
    fn config_new_requires_exact_length() {
        assert!(Config::new(&[0u8; CONFIG_LEN]).is_some());
        assert!(Config::new(&[0u8; CONFIG_LEN - 1]).is_none());
        assert!(Config::new(&[0u8; CONFIG_LEN + 1]).is_none());
        assert!(Policy::new(&[0u8; POLICY_LEN]).is_some());
        assert!(Policy::new(&[0u8; POLICY_LEN - 1]).is_none());
    }

    #[test]
    fn is_recipient_respects_len() {
        let mut c = valid_transfer_only();
        // Slot 1 is beyond recipients_len == 1: never matches, even if set.
        put(&mut c, OFF_RECIPIENTS + 32, &[0x62; 32]);
        let cfg = Config::new(&c).unwrap();
        assert!(cfg.is_recipient(&[0x61; 32]));
        assert!(!cfg.is_recipient(&[0x62; 32]));
        assert!(!cfg.is_recipient(&[0u8; 32]));
    }

    #[test]
    fn write_policy_places_every_header_field() {
        let cfg = valid_swap();
        let mut buf = vec![0u8; POLICY_LEN];
        let expiry = 1_800_000_000i64.to_le_bytes();
        write_policy(
            &mut buf,
            &Header {
                policy_bump: 254,
                authority_bump: 253,
                flags: FLAG_PAUSED | FLAG_STRICT_TOP_LEVEL,
                mandate: &[0x11; 32],
                owner: &[0x22; 32],
                agent: &[0x33; 32],
                authority: &[0x44; 32],
                mandate_expiry: &expiry,
            },
            &cfg,
        )
        .unwrap();
        let p = Policy::new(&buf).unwrap();
        assert_eq!((p.disc(), p.version(), p.flags()), (0xA7, 1, 3));
        assert_eq!(buf[OFF_POLICY_BUMP], 254);
        assert_eq!(p.authority_bump(), 253);
        assert_eq!(p.mandate(), &[0x11; 32]);
        assert_eq!(p.owner(), &[0x22; 32]);
        assert_eq!(p.agent(), &[0x33; 32]);
        assert_eq!(p.authority(), &[0x44; 32]);
        assert_eq!(p.mandate_expiry_bytes(), &expiry);
        assert_eq!(p.config().as_bytes(), &cfg[..]);
        // Reserved header bytes stay zero.
        assert!(buf[5..8].iter().all(|b| *b == 0));
    }

    /// Untrusted bytes never panic any parser: random and mutated buffers of
    /// every length around the fixed sizes.
    #[test]
    fn arbitrary_bytes_never_panic() {
        let mut s = 0xDEAD_BEEF_CAFE_F00Du64;
        let mut next = || {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            s.wrapping_mul(0x2545_F491_4F6C_DD1D)
        };
        let base = valid_swap();
        for round in 0..3_000u32 {
            let len = match round % 4 {
                0 => CONFIG_LEN,
                1 => (next() % 1024) as usize,
                2 => POLICY_LEN,
                _ => CONFIG_LEN + (next() % 3) as usize - 1,
            };
            let mut buf: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            if round % 3 == 0 {
                // Mostly-valid config with a few flipped bytes.
                buf = base.clone();
                for _ in 0..(next() % 4) {
                    let i = (next() as usize) % buf.len();
                    buf[i] = next() as u8;
                }
            }
            if let Some(c) = Config::new(&buf) {
                let _ = c.validate(&ID, allow_amm);
                let _ = (c.recipients_len(), c.is_recipient(&[1; 32]), c.floor_out());
            }
            if let Some(p) = Policy::new(&buf) {
                let _ = (p.disc(), p.flags(), p.mandate(), p.mandate_expiry_bytes());
            }
            let _ = crate::token::token_layout_ok(&buf, &TOKEN22_ID);
            let _ = crate::token::Snapshot::take(&TOKEN_ID, buf.len(), &buf);
        }
    }

    #[test]
    fn write_policy_rejects_bad_sizes() {
        let h = Header {
            policy_bump: 0,
            authority_bump: 0,
            flags: 0,
            mandate: &[0; 32],
            owner: &[0; 32],
            agent: &[0; 32],
            authority: &[0; 32],
            mandate_expiry: &[0; 8],
        };
        assert!(write_policy(&mut [0u8; 943], &h, &[0u8; CONFIG_LEN]).is_none());
        assert!(write_policy(&mut [0u8; POLICY_LEN], &h, &[0u8; 799]).is_none());
    }
}
