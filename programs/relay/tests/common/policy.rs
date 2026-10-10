//! `RelayPolicy` (944 bytes) encoder and decoder: header (region A) and the 800-byte config
//! (region B = bytes `[2..802)` of the `init_policy` instruction data). RELAY-SPEC section 5.2.
//!
//! The encoder is deliberately dumb: it writes whatever the struct says, canonical or not, so a
//! test can build every invalid row of PL-05 by mutating one field of an otherwise valid config.

use solana_pubkey::Pubkey;

use super::ids::{NATIVE_MINT, TOKEN22_ID, TOKEN_ID};

// ---- layout constants (RELAY-SPEC 5.2, relay-idl.json constants.policy) ----
pub const POLICY_LEN: usize = 944;
pub const POLICY_DISC: u8 = 0xA7;
pub const POLICY_VERSION: u8 = 1;
pub const CONFIG_OFFSET: usize = 144;
pub const CONFIG_LEN: usize = 800;
pub const INIT_DATA_LEN: usize = 802;
pub const MAX_RECIPIENTS: usize = 8;
pub const MAX_DEADLINE_SLOTS_CAP: u32 = 9000;

pub const FLAG_PAUSED: u8 = 0x01;
pub const FLAG_STRICT_TOP_LEVEL: u8 = 0x02;

/// Absolute offsets inside the 944-byte policy account.
pub mod off {
    pub const DISC: usize = 0;
    pub const VERSION: usize = 1;
    pub const POLICY_BUMP: usize = 2;
    pub const AUTHORITY_BUMP: usize = 3;
    pub const FLAGS: usize = 4;
    pub const RESERVED0: usize = 5;
    pub const MANDATE: usize = 8;
    pub const OWNER: usize = 40;
    pub const AGENT: usize = 72;
    pub const AUTHORITY: usize = 104;
    pub const MANDATE_EXPIRY: usize = 136;
    pub const TOKEN_PROGRAM: usize = 144;
    pub const BUDGET_MINT: usize = 176;
    pub const SOURCE_ACCOUNT: usize = 208;
    pub const RECIPIENTS_LEN: usize = 240;
    pub const SWAP_ENABLED: usize = 241;
    pub const RESERVED1: usize = 242;
    pub const RECIPIENTS: usize = 248;
    pub const AMM_PROGRAM: usize = 504;
    pub const AMM_AUTHORITY: usize = 536;
    pub const AMM_CONFIG: usize = 568;
    pub const POOL_STATE: usize = 600;
    pub const INPUT_VAULT: usize = 632;
    pub const OUTPUT_VAULT: usize = 664;
    pub const OBSERVATION_STATE: usize = 696;
    pub const IN_MINT: usize = 728;
    pub const OUT_MINT: usize = 760;
    pub const IN_TOKEN_PROGRAM: usize = 792;
    pub const OUT_TOKEN_PROGRAM: usize = 824;
    pub const IN_ACCOUNT: usize = 856;
    pub const OUT_ACCOUNT: usize = 888;
    pub const FLOOR_OUT: usize = 920;
    pub const FLOOR_IN: usize = 928;
    pub const MAX_DEADLINE_SLOTS: usize = 936;
    pub const RESERVED2: usize = 940;
}

const Z: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// The 800-byte config region, field by field. All fields are public and raw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyCfg {
    pub token_program: Pubkey,
    pub budget_mint: Pubkey,
    pub source_account: Pubkey,
    pub recipients_len: u8,
    pub swap_enabled: u8,
    pub reserved1: [u8; 6],
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub amm_program: Pubkey,
    pub amm_authority: Pubkey,
    pub amm_config: Pubkey,
    pub pool_state: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub observation_state: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub in_token_program: Pubkey,
    pub out_token_program: Pubkey,
    pub in_account: Pubkey,
    pub out_account: Pubkey,
    pub floor_out: u64,
    pub floor_in: u64,
    pub max_deadline_slots: u32,
    pub reserved2: [u8; 4],
}

/// Swap pins for [`PolicyCfg::with_swap`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapPins {
    pub amm_program: Pubkey,
    pub amm_authority: Pubkey,
    pub amm_config: Pubkey,
    pub pool_state: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub observation_state: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub in_token_program: Pubkey,
    pub out_token_program: Pubkey,
    pub in_account: Pubkey,
    pub out_account: Pubkey,
    pub floor_out: u64,
    pub floor_in: u64,
    pub max_deadline_slots: u32,
}

impl PolicyCfg {
    /// Canonical valid transfer-only config (`swap_enabled = 0`, all swap fields zero).
    pub fn transfer_only(
        token_program: Pubkey,
        budget_mint: Pubkey,
        source_account: Pubkey,
        recipients: &[Pubkey],
    ) -> Self {
        assert!(recipients.len() <= MAX_RECIPIENTS, "at most 8 recipients");
        let mut r = [Z; MAX_RECIPIENTS];
        r[..recipients.len()].copy_from_slice(recipients);
        Self {
            token_program,
            budget_mint,
            source_account,
            recipients_len: recipients.len() as u8,
            swap_enabled: 0,
            reserved1: [0; 6],
            recipients: r,
            amm_program: Z,
            amm_authority: Z,
            amm_config: Z,
            pool_state: Z,
            input_vault: Z,
            output_vault: Z,
            observation_state: Z,
            in_mint: Z,
            out_mint: Z,
            in_token_program: Z,
            out_token_program: Z,
            in_account: Z,
            out_account: Z,
            floor_out: 0,
            floor_in: 0,
            max_deadline_slots: 0,
            reserved2: [0; 4],
        }
    }

    /// Enable the swap section with the given pins.
    pub fn with_swap(mut self, s: &SwapPins) -> Self {
        self.swap_enabled = 1;
        self.amm_program = s.amm_program;
        self.amm_authority = s.amm_authority;
        self.amm_config = s.amm_config;
        self.pool_state = s.pool_state;
        self.input_vault = s.input_vault;
        self.output_vault = s.output_vault;
        self.observation_state = s.observation_state;
        self.in_mint = s.in_mint;
        self.out_mint = s.out_mint;
        self.in_token_program = s.in_token_program;
        self.out_token_program = s.out_token_program;
        self.in_account = s.in_account;
        self.out_account = s.out_account;
        self.floor_out = s.floor_out;
        self.floor_in = s.floor_in;
        self.max_deadline_slots = s.max_deadline_slots;
        self
    }

    /// The recipients that are in use (`recipients_len` clamped to 8).
    pub fn active_recipients(&self) -> &[Pubkey] {
        &self.recipients[..(self.recipients_len as usize).min(MAX_RECIPIENTS)]
    }

    /// Exactly 800 bytes, offsets as in RELAY-SPEC 5.2 minus 144.
    pub fn encode(&self) -> [u8; CONFIG_LEN] {
        let mut b = [0u8; CONFIG_LEN];
        let mut put = |abs: usize, bytes: &[u8]| {
            let o = abs - CONFIG_OFFSET;
            b[o..o + bytes.len()].copy_from_slice(bytes);
        };
        put(off::TOKEN_PROGRAM, self.token_program.as_ref());
        put(off::BUDGET_MINT, self.budget_mint.as_ref());
        put(off::SOURCE_ACCOUNT, self.source_account.as_ref());
        put(off::RECIPIENTS_LEN, &[self.recipients_len]);
        put(off::SWAP_ENABLED, &[self.swap_enabled]);
        put(off::RESERVED1, &self.reserved1);
        for (i, r) in self.recipients.iter().enumerate() {
            put(off::RECIPIENTS + 32 * i, r.as_ref());
        }
        put(off::AMM_PROGRAM, self.amm_program.as_ref());
        put(off::AMM_AUTHORITY, self.amm_authority.as_ref());
        put(off::AMM_CONFIG, self.amm_config.as_ref());
        put(off::POOL_STATE, self.pool_state.as_ref());
        put(off::INPUT_VAULT, self.input_vault.as_ref());
        put(off::OUTPUT_VAULT, self.output_vault.as_ref());
        put(off::OBSERVATION_STATE, self.observation_state.as_ref());
        put(off::IN_MINT, self.in_mint.as_ref());
        put(off::OUT_MINT, self.out_mint.as_ref());
        put(off::IN_TOKEN_PROGRAM, self.in_token_program.as_ref());
        put(off::OUT_TOKEN_PROGRAM, self.out_token_program.as_ref());
        put(off::IN_ACCOUNT, self.in_account.as_ref());
        put(off::OUT_ACCOUNT, self.out_account.as_ref());
        put(off::FLOOR_OUT, &self.floor_out.to_le_bytes());
        put(off::FLOOR_IN, &self.floor_in.to_le_bytes());
        put(
            off::MAX_DEADLINE_SLOTS,
            &self.max_deadline_slots.to_le_bytes(),
        );
        put(off::RESERVED2, &self.reserved2);
        b
    }

    /// Parse an 800-byte config region (inverse of [`PolicyCfg::encode`]).
    pub fn decode(config: &[u8]) -> Self {
        assert_eq!(config.len(), CONFIG_LEN, "config must be 800 bytes");
        let key = |abs: usize| -> Pubkey {
            let o = abs - CONFIG_OFFSET;
            Pubkey::try_from(&config[o..o + 32]).expect("32 bytes")
        };
        let u64_at = |abs: usize| -> u64 {
            let o = abs - CONFIG_OFFSET;
            u64::from_le_bytes(config[o..o + 8].try_into().expect("8 bytes"))
        };
        let mut recipients = [Z; MAX_RECIPIENTS];
        for (i, r) in recipients.iter_mut().enumerate() {
            *r = key(off::RECIPIENTS + 32 * i);
        }
        Self {
            token_program: key(off::TOKEN_PROGRAM),
            budget_mint: key(off::BUDGET_MINT),
            source_account: key(off::SOURCE_ACCOUNT),
            recipients_len: config[off::RECIPIENTS_LEN - CONFIG_OFFSET],
            swap_enabled: config[off::SWAP_ENABLED - CONFIG_OFFSET],
            reserved1: config[off::RESERVED1 - CONFIG_OFFSET..off::RESERVED1 - CONFIG_OFFSET + 6]
                .try_into()
                .expect("6 bytes"),
            recipients,
            amm_program: key(off::AMM_PROGRAM),
            amm_authority: key(off::AMM_AUTHORITY),
            amm_config: key(off::AMM_CONFIG),
            pool_state: key(off::POOL_STATE),
            input_vault: key(off::INPUT_VAULT),
            output_vault: key(off::OUTPUT_VAULT),
            observation_state: key(off::OBSERVATION_STATE),
            in_mint: key(off::IN_MINT),
            out_mint: key(off::OUT_MINT),
            in_token_program: key(off::IN_TOKEN_PROGRAM),
            out_token_program: key(off::OUT_TOKEN_PROGRAM),
            in_account: key(off::IN_ACCOUNT),
            out_account: key(off::OUT_ACCOUNT),
            floor_out: u64_at(off::FLOOR_OUT),
            floor_in: u64_at(off::FLOOR_IN),
            max_deadline_slots: u32::from_le_bytes(
                config[off::MAX_DEADLINE_SLOTS - CONFIG_OFFSET
                    ..off::MAX_DEADLINE_SLOTS - CONFIG_OFFSET + 4]
                    .try_into()
                    .expect("4 bytes"),
            ),
            reserved2: config[off::RESERVED2 - CONFIG_OFFSET..off::RESERVED2 - CONFIG_OFFSET + 4]
                .try_into()
                .expect("4 bytes"),
        }
    }

    /// `init_policy` instruction data: `[0] + flags + config[800]` (802 bytes).
    pub fn init_data(&self, flags: u8) -> Vec<u8> {
        let mut d = Vec::with_capacity(INIT_DATA_LEN);
        d.push(0u8);
        d.push(flags);
        d.extend_from_slice(&self.encode());
        d
    }
}

/// Identity header (region A) as `init_policy` writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyHeader {
    pub policy_bump: u8,
    pub authority_bump: u8,
    pub flags: u8,
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub mandate_expiry: i64,
}

impl PolicyHeader {
    /// The full expected 944-byte account contents for `header + cfg`.
    pub fn encode_with(&self, cfg: &PolicyCfg) -> Vec<u8> {
        let mut b = vec![0u8; POLICY_LEN];
        b[off::DISC] = POLICY_DISC;
        b[off::VERSION] = POLICY_VERSION;
        b[off::POLICY_BUMP] = self.policy_bump;
        b[off::AUTHORITY_BUMP] = self.authority_bump;
        b[off::FLAGS] = self.flags;
        b[off::MANDATE..off::MANDATE + 32].copy_from_slice(self.mandate.as_ref());
        b[off::OWNER..off::OWNER + 32].copy_from_slice(self.owner.as_ref());
        b[off::AGENT..off::AGENT + 32].copy_from_slice(self.agent.as_ref());
        b[off::AUTHORITY..off::AUTHORITY + 32].copy_from_slice(self.authority.as_ref());
        b[off::MANDATE_EXPIRY..off::MANDATE_EXPIRY + 8]
            .copy_from_slice(&self.mandate_expiry.to_le_bytes());
        b[CONFIG_OFFSET..].copy_from_slice(&cfg.encode());
        b
    }
}

/// Decoded policy account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyView {
    pub disc: u8,
    pub version: u8,
    pub header: PolicyHeader,
    pub cfg: PolicyCfg,
    pub len: usize,
}

impl PolicyView {
    pub fn decode(data: &[u8]) -> Self {
        assert_eq!(data.len(), POLICY_LEN, "policy must be {POLICY_LEN} bytes");
        let key = |o: usize| Pubkey::try_from(&data[o..o + 32]).expect("32 bytes");
        Self {
            disc: data[off::DISC],
            version: data[off::VERSION],
            header: PolicyHeader {
                policy_bump: data[off::POLICY_BUMP],
                authority_bump: data[off::AUTHORITY_BUMP],
                flags: data[off::FLAGS],
                mandate: key(off::MANDATE),
                owner: key(off::OWNER),
                agent: key(off::AGENT),
                authority: key(off::AUTHORITY),
                mandate_expiry: i64::from_le_bytes(
                    data[off::MANDATE_EXPIRY..off::MANDATE_EXPIRY + 8]
                        .try_into()
                        .expect("8 bytes"),
                ),
            },
            cfg: PolicyCfg::decode(&data[CONFIG_OFFSET..]),
            len: data.len(),
        }
    }

    pub fn paused(&self) -> bool {
        self.header.flags & FLAG_PAUSED != 0
    }
}

/// `ceil(amount_in * floor_out / floor_in)` in u128; `None` when it does not fit in u64
/// (the relay returns 114). Independent reference for SW-12.
pub fn required_min_out(amount_in: u64, floor_out: u64, floor_in: u64) -> Option<u64> {
    assert!(floor_in > 0, "floor_in must be > 0");
    let num = (amount_in as u128) * (floor_out as u128);
    let q = num.div_ceil(floor_in as u128);
    u64::try_from(q).ok()
}

// =====================================================================================
// Invalid-config tables (PL-05, PL-04, distinctness rule)
// =====================================================================================

/// One invalid `init_policy` input: a single mutation of a valid base config.
#[derive(Clone, Debug)]
pub struct InvalidRow {
    pub name: &'static str,
    pub cfg: PolicyCfg,
    pub flags: u8,
}

/// Every invalid-config row of TEST-MATRIX PL-05 plus PL-04 (AMM not in the allowlist), each one
/// a single mutation of `base`. `init_policy` must reject each with relay error 113 and create
/// no account.
///
/// `base` must be a VALID swap-enabled config with at least 2 recipients (fewer than 8) and
/// `in_account != source_account`, as produced by `Ctx::builder(..).with_swap()`.
pub fn invalid_config_rows(base: &PolicyCfg) -> Vec<InvalidRow> {
    assert_eq!(base.swap_enabled, 1, "base config must have swap enabled");
    assert!(
        (2..MAX_RECIPIENTS).contains(&(base.recipients_len as usize)),
        "base config needs 2..=7 recipients"
    );
    assert_ne!(
        base.in_account, base.source_account,
        "base in_account must differ from source"
    );
    let fresh = Pubkey::new_unique;
    let mut rows = Vec::new();
    let mut row = |name: &'static str, flags: u8, f: &dyn Fn(&mut PolicyCfg)| {
        let mut cfg = base.clone();
        f(&mut cfg);
        rows.push(InvalidRow { name, cfg, flags });
    };
    let n = base.recipients_len as usize;

    row("recipients_len 9", 0, &|c| c.recipients_len = 9);
    row("recipients_len 255", 0, &|c| c.recipients_len = 255);
    row("duplicate recipient", 0, &|c| {
        c.recipients[1] = c.recipients[0]
    });
    row("recipient == source", 0, &|c| {
        c.recipients[0] = c.source_account
    });
    row("zero source", 0, &|c| c.source_account = Pubkey::default());
    row("zero recipient inside len", 0, &|c| {
        c.recipients[0] = Pubkey::default()
    });
    row("non-zero recipient beyond len", 0, &move |c| {
        c.recipients[n] = Pubkey::new_unique()
    });
    row("floor_in 0", 0, &|c| c.floor_in = 0);
    row("floor_out 0", 0, &|c| c.floor_out = 0);
    row("in_mint == out_mint", 0, &|c| c.out_mint = c.in_mint);
    row("input_vault == output_vault", 0, &|c| {
        c.output_vault = c.input_vault
    });
    row("non-zero reserved1", 0, &|c| c.reserved1[0] = 1);
    row("non-zero reserved1 (last byte)", 0, &|c| {
        c.reserved1[5] = 0x80
    });
    row("non-zero reserved2", 0, &|c| c.reserved2[0] = 1);
    row("non-zero reserved2 (last byte)", 0, &|c| {
        c.reserved2[3] = 0x80
    });
    row("swap_enabled 2", 0, &|c| c.swap_enabled = 2);
    row("token_program not Token/Token-2022", 0, &move |c| {
        c.token_program = fresh()
    });
    row("token_program zero", 0, &|c| {
        c.token_program = Pubkey::default()
    });
    row("budget_mint == native mint", 0, &|c| {
        c.budget_mint = NATIVE_MINT
    });
    row("budget_mint zero", 0, &|c| {
        c.budget_mint = Pubkey::default()
    });
    row("in_mint == native mint", 0, &|c| c.in_mint = NATIVE_MINT);
    row("max_deadline_slots 0", 0, &|c| c.max_deadline_slots = 0);
    row("max_deadline_slots 9001", 0, &|c| {
        c.max_deadline_slots = MAX_DEADLINE_SLOTS_CAP + 1
    });
    row("max_deadline_slots u32::MAX", 0, &|c| {
        c.max_deadline_slots = u32::MAX
    });
    row("flags bit2 set", 0x04, &|_| {});
    row("flags 0xFC", 0xFC, &|_| {});
    row("flags 0x80 (top bit)", 0x80, &|_| {});
    row("swap fields non-zero while swap_enabled 0", 0, &|c| {
        c.swap_enabled = 0
    });
    row("in_account == out_account", 0, &|c| {
        c.out_account = c.in_account
    });
    row("out_account == source", 0, &|c| {
        c.out_account = c.source_account
    });
    row(
        "in_account == source with in_mint != budget_mint",
        0,
        &move |c| {
            c.in_account = c.source_account;
            c.in_mint = fresh();
        },
    );
    row(
        "in_account == source with in_token_program != token_program",
        0,
        &|c| {
            c.in_account = c.source_account;
            c.in_token_program = TOKEN22_ID;
            c.token_program = TOKEN_ID;
        },
    );
    row("pool_state == in_account", 0, &|c| {
        c.pool_state = c.in_account
    });
    row("amm_program not in the allowlist", 0, &move |c| {
        c.amm_program = fresh()
    });
    row("amm_program zero (swap enabled)", 0, &|c| {
        c.amm_program = Pubkey::default()
    });
    row("amm_authority zero (swap enabled)", 0, &|c| {
        c.amm_authority = Pubkey::default()
    });
    row("amm_config zero (swap enabled)", 0, &|c| {
        c.amm_config = Pubkey::default()
    });
    row("pool_state zero (swap enabled)", 0, &|c| {
        c.pool_state = Pubkey::default()
    });
    row("input_vault zero (swap enabled)", 0, &|c| {
        c.input_vault = Pubkey::default()
    });
    row("output_vault zero (swap enabled)", 0, &|c| {
        c.output_vault = Pubkey::default()
    });
    row("observation_state zero (swap enabled)", 0, &|c| {
        c.observation_state = Pubkey::default()
    });
    row("in_mint zero (swap enabled)", 0, &|c| {
        c.in_mint = Pubkey::default()
    });
    row("out_mint zero (swap enabled)", 0, &|c| {
        c.out_mint = Pubkey::default()
    });
    row("in_account zero (swap enabled)", 0, &|c| {
        c.in_account = Pubkey::default()
    });
    row("out_account zero (swap enabled)", 0, &|c| {
        c.out_account = Pubkey::default()
    });
    row("in_token_program invalid", 0, &move |c| {
        c.in_token_program = fresh()
    });
    row("out_token_program invalid", 0, &move |c| {
        c.out_token_program = fresh()
    });
    row("amm_program == pool_state (alias)", 0, &|c| {
        c.pool_state = c.amm_program
    });
    row("amm_authority == amm_config (alias)", 0, &|c| {
        c.amm_config = c.amm_authority
    });
    rows
}

/// Rows of the distinctness rule involving the identity header keys: a config key equal to one of
/// {mandate, policy, authority, owner, agent} must be rejected with 113.
pub fn header_alias_rows(
    base: &PolicyCfg,
    mandate: &Pubkey,
    policy: &Pubkey,
    authority: &Pubkey,
    owner: &Pubkey,
    agent: &Pubkey,
) -> Vec<InvalidRow> {
    let mut rows = Vec::new();
    for (label, k) in [
        ("mandate", mandate),
        ("policy", policy),
        ("authority", authority),
        ("owner", owner),
        ("agent", agent),
    ] {
        let mk = |name: &'static str, f: &dyn Fn(&mut PolicyCfg, Pubkey)| {
            let mut cfg = base.clone();
            f(&mut cfg, *k);
            InvalidRow {
                name,
                cfg,
                flags: 0,
            }
        };
        let (n_source, n_recipient, n_pool) = match label {
            "mandate" => (
                "source == mandate",
                "recipient == mandate",
                "pool_state == mandate",
            ),
            "policy" => (
                "source == policy",
                "recipient == policy",
                "pool_state == policy",
            ),
            "authority" => (
                "source == authority",
                "recipient == authority",
                "pool_state == authority",
            ),
            "owner" => (
                "source == owner",
                "recipient == owner",
                "pool_state == owner",
            ),
            _ => (
                "source == agent",
                "recipient == agent",
                "pool_state == agent",
            ),
        };
        rows.push(mk(n_source, &|c, k| c.source_account = k));
        rows.push(mk(n_recipient, &|c, k| c.recipients[1] = k));
        rows.push(mk(n_pool, &|c, k| c.pool_state = k));
    }
    rows
}
