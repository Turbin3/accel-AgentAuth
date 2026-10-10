//! Program ids, discriminators, seeds, error-code tables and PDA helpers.
//!
//! Everything here is copied from RELAY-SPEC.md sections 4, 6.5 and 9 or from
//! the core source; none of it is derived at run time except PDAs.

use solana_pubkey::Pubkey;

pub const AGENT_AUTH_ID: Pubkey =
    Pubkey::from_str_const("AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if");
pub const RELAY_ID: Pubkey = Pubkey::from_str_const("33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6");
pub const MOCK_AMM_ID: Pubkey =
    Pubkey::from_str_const("6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw");
pub const GATED_EXAMPLE_ID: Pubkey =
    Pubkey::from_str_const("CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ");
pub const TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN22_ID: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SYSTEM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
pub const NATIVE_MINT: Pubkey =
    Pubkey::from_str_const("So11111111111111111111111111111111111111112");
/// Token-2022 has its own native mint address; the spec's native-mint rule names only the
/// classic one above.
pub const NATIVE_MINT_2022: Pubkey =
    Pubkey::from_str_const("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
pub const ATA_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const COMPUTE_BUDGET_ID: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");
pub const CPMM_MAINNET: Pubkey =
    Pubkey::from_str_const("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const CPMM_DEVNET: Pubkey =
    Pubkey::from_str_const("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
/// Feature gate `replace_spl_token_with_p_token` (RELAY-SPEC section 11).
pub const P_TOKEN_FEATURE: Pubkey =
    Pubkey::from_str_const("ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP");

/// SPL `TransferChecked` as the relay reports it to `verify`: tag 12 + 7 zero bytes.
pub const TRANSFER_CHECKED_DISC: [u8; 8] = [12, 0, 0, 0, 0, 0, 0, 0];
/// First 8 bytes of sha256("global:swap_base_input").
pub const SWAP_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];
/// `gated-example` action discriminator.
pub const GATED_ACTION_DISC: [u8; 8] = [1, 0, 0, 0, 0, 0, 0, 0];
/// Mock-AMM `proxy` instruction discriminator (RELAY-SPEC 14.1).
pub const PROXY_DISC: [u8; 8] = [0xFF, 0x70, 0x72, 0x6F, 0x78, 0x79, 0x00, 0x00];

pub const POLICY_SEED: &[u8] = b"policy";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const MOCK_AMM_AUTH_SEED: &[u8] = b"mock_amm_auth";

/// Default mandate expiry used by `Ctx` (unix seconds, far in the future of the LiteSVM clock).
pub const DEFAULT_EXPIRY: i64 = 1_900_000_000;

/// Relay error codes, RELAY-SPEC section 9 (`ProgramError::Custom(n)`).
pub mod relay_err {
    pub const INVALID_INSTRUCTION_DATA: u32 = 100;
    pub const INVALID_POLICY: u32 = 101;
    pub const ACCOUNT_MISMATCH: u32 = 102;
    pub const WRONG_PROGRAM: u32 = 103;
    pub const RECIPIENT_NOT_ALLOWED: u32 = 104;
    pub const TOKEN_ACCOUNT_STATE: u32 = 105;
    pub const BALANCE_DELTA_VIOLATION: u32 = 106;
    pub const AGENT_NOT_SIGNER: u32 = 107;
    pub const OWNER_NOT_SIGNER: u32 = 108;
    pub const NOT_POLICY_OWNER: u32 = 109;
    pub const SWAP_DISABLED: u32 = 110;
    pub const DEADLINE_EXPIRED: u32 = 111;
    pub const SLIPPAGE_FLOOR_VIOLATED: u32 = 112;
    pub const INVALID_CONFIG: u32 = 113;
    pub const ARITHMETIC_OVERFLOW: u32 = 114;
    pub const NOT_TOP_LEVEL: u32 = 115;
    pub const PAUSED: u32 = 116;
    pub const INVALID_MANDATE: u32 = 117;
    pub const STALE_POLICY: u32 = 118;
    pub const ACCOUNT_INVARIANT_VIOLATED: u32 = 119;

    /// Name table, index = code - 100 (used in failure messages).
    pub const NAMES: [&str; 20] = [
        "InvalidInstructionData",
        "InvalidPolicy",
        "AccountMismatch",
        "WrongProgram",
        "RecipientNotAllowed",
        "TokenAccountState",
        "BalanceDeltaViolation",
        "AgentNotSigner",
        "OwnerNotSigner",
        "NotPolicyOwner",
        "SwapDisabled",
        "DeadlineExpired",
        "SlippageFloorViolated",
        "InvalidConfig",
        "ArithmeticOverflow",
        "NotTopLevel",
        "Paused",
        "InvalidMandate",
        "StalePolicy",
        "AccountInvariantViolated",
    ];
}

/// AgentAuth core error codes (1..18 locked, 19..22 appended by the hardening work).
pub mod aa_err {
    pub const INVALID_DISCRIMINATOR: u32 = 1;
    pub const NOT_OWNER: u32 = 2;
    pub const ALREADY_INITIALIZED: u32 = 3;
    pub const NOT_ACTIVE: u32 = 4;
    pub const EXPIRED: u32 = 5;
    pub const PROGRAM_NOT_ALLOWED: u32 = 6;
    pub const DISCRIMINATOR_NOT_ALLOWED: u32 = 7;
    pub const PER_TX_EXCEEDED: u32 = 8;
    pub const SPEND_LIMIT_EXCEEDED: u32 = 9;
    pub const PERMISSIONS_FULL: u32 = 10;
    pub const TOO_MANY_DISCRIMINATORS: u32 = 11;
    pub const PERMISSION_NOT_FOUND: u32 = 12;
    pub const ARITHMETIC_OVERFLOW: u32 = 13;
    pub const ACCOUNT_OWNER_MISMATCH: u32 = 14;
    pub const INVALID_INSTRUCTION_DATA: u32 = 15;
    pub const INVALID_ACCOUNT_TYPE: u32 = 16;
    pub const UNKNOWN_AGENT: u32 = 17;
    pub const INVALID_SIGNER: u32 = 18;
    pub const INVALID_AGENT: u32 = 19;
    pub const INVALID_EXPIRY: u32 = 20;
    pub const DUPLICATE_PERMISSION: u32 = 21;
    pub const EMPTY_DISCRIMINATORS: u32 = 22;
}

/// SPL Token error codes that tests assert (the Token-2022 numbering is identical for these).
pub mod token_err {
    pub const NOT_RENT_EXEMPT: u32 = 0;
    pub const INSUFFICIENT_FUNDS: u32 = 1;
    pub const MINT_MISMATCH: u32 = 3;
    pub const OWNER_MISMATCH: u32 = 4;
    pub const ACCOUNT_FROZEN: u32 = 17;
    pub const MINT_DECIMALS_MISMATCH: u32 = 18;
}

/// Mock AMM error codes (RELAY-SPEC 14.1).
pub mod amm_err {
    pub const EXCEEDED_SLIPPAGE: u32 = 7001;
    pub const INVALID_POOL: u32 = 7002;
    pub const INVALID_VAULT: u32 = 7003;
    pub const ZERO_AMOUNT: u32 = 7004;
    pub const INVALID_INSTRUCTION: u32 = 7005;
}

// ---------------------------------------------------------------- PDAs

pub fn mandate_pda(owner: &Pubkey, agent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[agent_auth::MANDATE_SEED, owner.as_ref(), agent.as_ref()],
        &AGENT_AUTH_ID,
    )
}

pub fn policy_pda(mandate: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POLICY_SEED, mandate.as_ref()], &RELAY_ID)
}

pub fn authority_pda(mandate: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AUTHORITY_SEED, mandate.as_ref()], &RELAY_ID)
}

/// PDA the mock AMM uses as pool authority.
pub fn mock_amm_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MOCK_AMM_AUTH_SEED], &MOCK_AMM_ID)
}

/// Associated token account address for (wallet, token program, mint).
pub fn ata_address(wallet: &Pubkey, token_program: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

/// A fresh unique key (never a PDA, never on a real curve guarantee needed).
pub fn unique() -> Pubkey {
    Pubkey::new_unique()
}
