//! Byte-exact SPL Token / Token-2022 account and mint builders (RELAY-SPEC 6.5), views for
//! reading them back, and raw SPL instruction builders for the "agent has no authority" tests.
//!
//! Tests never run `InitializeAccount`/`InitializeMint`: accounts are placed with `set_account`.
//! The harness self-tests prove these builders equal what the real programs write.

use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use super::svm::SvmExt;

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const MINT_LEN: usize = 82;
/// Token-2022 account with exactly the ImmutableOwner extension (what the ATA program creates).
pub const IMMUTABLE_OWNER_ACCOUNT_LEN: usize = 170;

// Field offsets inside a token account (RELAY-SPEC 6.5).
pub const OFF_MINT: usize = 0;
pub const OFF_OWNER: usize = 32;
pub const OFF_AMOUNT: usize = 64;
pub const OFF_DELEGATE_TAG: usize = 72;
pub const OFF_DELEGATE: usize = 76;
pub const OFF_STATE: usize = 108;
pub const OFF_IS_NATIVE_TAG: usize = 109;
pub const OFF_IS_NATIVE: usize = 113;
pub const OFF_DELEGATED_AMOUNT: usize = 121;
pub const OFF_CLOSE_AUTH_TAG: usize = 129;
pub const OFF_CLOSE_AUTH: usize = 133;
/// Token-2022 AccountType byte (1 = Mint, 2 = Account) sits right after the 165-byte base.
pub const OFF_ACCOUNT_TYPE: usize = 165;

// Mint field offsets.
pub const MINT_OFF_AUTH_TAG: usize = 0;
pub const MINT_OFF_AUTH: usize = 4;
pub const MINT_OFF_SUPPLY: usize = 36;
pub const MINT_OFF_DECIMALS: usize = 44;
pub const MINT_OFF_INITIALIZED: usize = 45;
pub const MINT_OFF_FREEZE_TAG: usize = 46;
pub const MINT_OFF_FREEZE_AUTH: usize = 50;

/// `AccountState` byte values.
pub const STATE_UNINITIALIZED: u8 = 0;
pub const STATE_INITIALIZED: u8 = 1;
pub const STATE_FROZEN: u8 = 2;

/// `evil-token` misbehaviours (RELAY-SPEC 14.1b), selected with [`MintAcct::evil_mode`].
pub mod evil {
    pub const HONEST: u8 = 0;
    pub const MOVE_PLUS_ONE: u8 = 1;
    pub const CREDIT_MINUS_ONE: u8 = 2;
    pub const RAISE_SOURCE: u8 = 3;
    pub const REWRITE_CLOSE_AUTH: u8 = 4;
}

/// Token-2022 extension type numbers (declaration order in the interface crate).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Ext {
    TransferFeeConfig = 1,
    TransferFeeAmount = 2,
    MintCloseAuthority = 3,
    ConfidentialTransferMint = 4,
    ConfidentialTransferAccount = 5,
    DefaultAccountState = 6,
    ImmutableOwner = 7,
    MemoTransfer = 8,
    NonTransferable = 9,
    InterestBearingConfig = 10,
    CpiGuard = 11,
    PermanentDelegate = 12,
    NonTransferableAccount = 13,
    TransferHook = 14,
    TransferHookAccount = 15,
    MetadataPointer = 18,
    Pausable = 26,
    PausableAccount = 27,
}

impl Ext {
    /// Length of the extension value (all-zero default value is `vec![0; len]`).
    pub fn value_len(self) -> usize {
        match self {
            Ext::TransferFeeConfig => 108,
            Ext::TransferFeeAmount => 8,
            Ext::MintCloseAuthority => 32,
            Ext::ConfidentialTransferMint => 65,
            Ext::ConfidentialTransferAccount => 295,
            Ext::DefaultAccountState => 1,
            Ext::ImmutableOwner => 0,
            Ext::MemoTransfer => 1,
            Ext::NonTransferable => 0,
            Ext::InterestBearingConfig => 52,
            Ext::CpiGuard => 1,
            Ext::PermanentDelegate => 32,
            Ext::NonTransferableAccount => 0,
            Ext::TransferHook => 64,
            Ext::TransferHookAccount => 1,
            Ext::MetadataPointer => 64,
            Ext::Pausable => 33,
            Ext::PausableAccount => 0,
        }
    }

    /// TLV entry (type u16 LE, length u16 LE, zeroed value).
    pub fn tlv(self) -> Vec<u8> {
        let mut v = (self as u16).to_le_bytes().to_vec();
        v.extend_from_slice(&(self.value_len() as u16).to_le_bytes());
        v.extend(std::iter::repeat_n(0u8, self.value_len()));
        v
    }
}

fn put_coption_key(data: &mut [u8], tag_off: usize, key_off: usize, key: &Option<Pubkey>) {
    match key {
        Some(k) => {
            data[tag_off..tag_off + 4].copy_from_slice(&1u32.to_le_bytes());
            data[key_off..key_off + 32].copy_from_slice(k.as_ref());
        }
        None => {
            data[tag_off..tag_off + 4].copy_from_slice(&0u32.to_le_bytes());
            data[key_off..key_off + 32].fill(0);
        }
    }
}

// =====================================================================================
// Token account builder
// =====================================================================================

/// A token account to place with `set_account`. Every field of RELAY-SPEC 6.5 is controllable.
#[derive(Clone, Debug)]
pub struct TokenAcct {
    /// Program that owns the account (Token, Token-2022, or anything for negative tests).
    pub program: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub delegated_amount: u64,
    /// Raw `state` byte (0 uninitialised, 1 initialised, 2 frozen).
    pub state: u8,
    /// `is_native` COption (rent-exempt reserve of a wrapped-SOL account).
    pub is_native: Option<u64>,
    pub close_authority: Option<Pubkey>,
    /// Key bytes left behind in `[76..108]` while `delegate` is `None`. The classic Token and
    /// p-token programs only zero the COption TAG when a delegate is cleared (exhausted
    /// delegation or `Revoke`), they leave the old key bytes; Token-2022 zeroes them.
    pub stale_delegate: Option<Pubkey>,
    /// Same for `close_authority`.
    pub stale_close_authority: Option<Pubkey>,
    /// Bytes appended after the 165-byte base (Token-2022 AccountType byte + TLV entries).
    pub tail: Vec<u8>,
    /// Explicit lamports; `None` = rent-exempt minimum for the final length.
    pub lamports: Option<u64>,
    /// Raw overwrites applied last: `(offset, bytes)`; the vector is extended with zeros if needed.
    pub patches: Vec<(usize, Vec<u8>)>,
}

impl TokenAcct {
    /// Initialised, no delegate, no close authority, 165 bytes.
    pub fn new(program: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) -> Self {
        Self {
            program,
            mint,
            owner,
            amount,
            delegate: None,
            delegated_amount: 0,
            state: STATE_INITIALIZED,
            is_native: None,
            close_authority: None,
            stale_delegate: None,
            stale_close_authority: None,
            tail: Vec::new(),
            lamports: None,
            patches: Vec::new(),
        }
    }

    /// The state the Token program leaves after the delegation was exhausted or revoked:
    /// `delegate = None`, `delegated_amount = 0`, and, on classic Token and p-token only, the old
    /// delegate key still sitting in the key bytes (`stale = true`).
    pub fn cleared_delegate(mut self, old_delegate: Pubkey, stale: bool) -> Self {
        self.delegate = None;
        self.delegated_amount = 0;
        self.stale_delegate = stale.then_some(old_delegate);
        self
    }

    /// Like [`TokenAcct::cleared_delegate`], choosing `stale` from the flavour.
    pub fn cleared_delegate_for(self, flavor: super::svm::Flavor, old_delegate: Pubkey) -> Self {
        self.cleared_delegate(old_delegate, flavor != super::svm::Flavor::Token2022)
    }

    /// Set delegate and delegated amount together (what `Approve` does).
    pub fn delegate(mut self, delegate: Pubkey, delegated_amount: u64) -> Self {
        self.delegate = Some(delegate);
        self.delegated_amount = delegated_amount;
        self
    }

    /// Delegate set but `delegated_amount` left as is (default 0).
    pub fn delegate_only(mut self, delegate: Pubkey) -> Self {
        self.delegate = Some(delegate);
        self
    }

    /// `delegated_amount` without a delegate (the state the Token program writes after clearing
    /// is `delegate = None, delegated_amount = 0`; this builds the inconsistent variant).
    pub fn delegated_amount_only(mut self, amount: u64) -> Self {
        self.delegated_amount = amount;
        self
    }

    pub fn frozen(mut self) -> Self {
        self.state = STATE_FROZEN;
        self
    }

    pub fn state(mut self, raw: u8) -> Self {
        self.state = raw;
        self
    }

    pub fn native(mut self, reserve: u64) -> Self {
        self.is_native = Some(reserve);
        self
    }

    pub fn close_authority(mut self, key: Pubkey) -> Self {
        self.close_authority = Some(key);
        self
    }

    pub fn owner_program(mut self, program: Pubkey) -> Self {
        self.program = program;
        self
    }

    pub fn lamports(mut self, lamports: u64) -> Self {
        self.lamports = Some(lamports);
        self
    }

    pub fn patch(mut self, offset: usize, bytes: &[u8]) -> Self {
        self.patches.push((offset, bytes.to_vec()));
        self
    }

    /// Token-2022 account with the given extensions: `[AccountType=2] + TLV entries`.
    pub fn with_extensions(mut self, exts: &[Ext]) -> Self {
        let mut tail = vec![2u8];
        for e in exts {
            tail.extend_from_slice(&e.tlv());
        }
        self.tail = tail;
        self
    }

    /// The 170-byte Token-2022 shape the ATA program creates: ImmutableOwner only.
    pub fn immutable_owner_170(self) -> Self {
        self.with_extensions(&[Ext::ImmutableOwner])
    }

    /// Arbitrary raw tail (account type byte + anything) for malformed-shape tests.
    pub fn raw_tail(mut self, tail: &[u8]) -> Self {
        self.tail = tail.to_vec();
        self
    }

    /// Exact account data.
    pub fn data(&self) -> Vec<u8> {
        let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
        d[OFF_MINT..OFF_MINT + 32].copy_from_slice(self.mint.as_ref());
        d[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(self.owner.as_ref());
        d[OFF_AMOUNT..OFF_AMOUNT + 8].copy_from_slice(&self.amount.to_le_bytes());
        put_coption_key(&mut d, OFF_DELEGATE_TAG, OFF_DELEGATE, &self.delegate);
        if let (None, Some(stale)) = (&self.delegate, &self.stale_delegate) {
            d[OFF_DELEGATE..OFF_DELEGATE + 32].copy_from_slice(stale.as_ref());
        }
        d[OFF_STATE] = self.state;
        match self.is_native {
            Some(v) => {
                d[OFF_IS_NATIVE_TAG..OFF_IS_NATIVE_TAG + 4].copy_from_slice(&1u32.to_le_bytes());
                d[OFF_IS_NATIVE..OFF_IS_NATIVE + 8].copy_from_slice(&v.to_le_bytes());
            }
            None => d[OFF_IS_NATIVE_TAG..OFF_IS_NATIVE + 8].fill(0),
        }
        d[OFF_DELEGATED_AMOUNT..OFF_DELEGATED_AMOUNT + 8]
            .copy_from_slice(&self.delegated_amount.to_le_bytes());
        put_coption_key(
            &mut d,
            OFF_CLOSE_AUTH_TAG,
            OFF_CLOSE_AUTH,
            &self.close_authority,
        );
        if let (None, Some(stale)) = (&self.close_authority, &self.stale_close_authority) {
            d[OFF_CLOSE_AUTH..OFF_CLOSE_AUTH + 32].copy_from_slice(stale.as_ref());
        }
        d.extend_from_slice(&self.tail);
        for (off, bytes) in &self.patches {
            if d.len() < off + bytes.len() {
                d.resize(off + bytes.len(), 0);
            }
            d[*off..off + bytes.len()].copy_from_slice(bytes);
        }
        d
    }

    /// Account ready for `set_account`.
    pub fn account(&self, svm: &impl SvmExt) -> Account {
        let data = self.data();
        Account {
            lamports: self.lamports.unwrap_or_else(|| svm.rent(data.len())),
            data,
            owner: self.program,
            executable: false,
            rent_epoch: 0,
        }
    }
}

// =====================================================================================
// Mint builder
// =====================================================================================

/// A mint to place with `set_account`.
#[derive(Clone, Debug)]
pub struct MintAcct {
    pub program: Pubkey,
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    /// Raw `is_initialized` byte.
    pub initialized: u8,
    pub freeze_authority: Option<Pubkey>,
    /// Bytes appended after the 82-byte base. For Token-2022 the base is first padded to 165
    /// bytes; use [`MintAcct::with_extensions`].
    pub tail: Vec<u8>,
    pub pad_to_165: bool,
    pub lamports: Option<u64>,
    pub patches: Vec<(usize, Vec<u8>)>,
}

impl MintAcct {
    /// Initialised, extension-free, 82 bytes, no mint/freeze authority.
    pub fn new(program: Pubkey, decimals: u8) -> Self {
        Self {
            program,
            mint_authority: None,
            supply: 0,
            decimals,
            initialized: 1,
            freeze_authority: None,
            tail: Vec::new(),
            pad_to_165: false,
            lamports: None,
            patches: Vec::new(),
        }
    }

    pub fn supply(mut self, supply: u64) -> Self {
        self.supply = supply;
        self
    }

    pub fn mint_authority(mut self, key: Pubkey) -> Self {
        self.mint_authority = Some(key);
        self
    }

    pub fn freeze_authority(mut self, key: Pubkey) -> Self {
        self.freeze_authority = Some(key);
        self
    }

    pub fn uninitialized(mut self) -> Self {
        self.initialized = 0;
        self
    }

    pub fn owner_program(mut self, program: Pubkey) -> Self {
        self.program = program;
        self
    }

    pub fn lamports(mut self, lamports: u64) -> Self {
        self.lamports = Some(lamports);
        self
    }

    pub fn patch(mut self, offset: usize, bytes: &[u8]) -> Self {
        self.patches.push((offset, bytes.to_vec()));
        self
    }

    /// Select the `evil-token` stub behaviour (`evil::*`) via `mint.data[81]`, the last byte of
    /// the freeze-authority key (unused when there is no freeze authority). Test-only convention
    /// of RELAY-SPEC 14.1b; the real Token programs ignore the byte.
    pub fn evil_mode(self, mode: u8) -> Self {
        self.patch(81, &[mode])
    }

    /// Token-2022 mint with extensions: base padded to 165 bytes, `AccountType = 1`, TLVs.
    /// The relay must reject every such mint (`data_len != 82`, error 103).
    pub fn with_extensions(mut self, exts: &[Ext]) -> Self {
        let mut tail = vec![1u8];
        for e in exts {
            tail.extend_from_slice(&e.tlv());
        }
        self.tail = tail;
        self.pad_to_165 = true;
        self
    }

    /// Exact mint data.
    pub fn data(&self) -> Vec<u8> {
        let mut d = vec![0u8; MINT_LEN];
        put_coption_key(
            &mut d,
            MINT_OFF_AUTH_TAG,
            MINT_OFF_AUTH,
            &self.mint_authority,
        );
        d[MINT_OFF_SUPPLY..MINT_OFF_SUPPLY + 8].copy_from_slice(&self.supply.to_le_bytes());
        d[MINT_OFF_DECIMALS] = self.decimals;
        d[MINT_OFF_INITIALIZED] = self.initialized;
        put_coption_key(
            &mut d,
            MINT_OFF_FREEZE_TAG,
            MINT_OFF_FREEZE_AUTH,
            &self.freeze_authority,
        );
        if self.pad_to_165 {
            d.resize(TOKEN_ACCOUNT_LEN, 0);
        }
        d.extend_from_slice(&self.tail);
        for (off, bytes) in &self.patches {
            if d.len() < off + bytes.len() {
                d.resize(off + bytes.len(), 0);
            }
            d[*off..off + bytes.len()].copy_from_slice(bytes);
        }
        d
    }

    pub fn account(&self, svm: &impl SvmExt) -> Account {
        let data = self.data();
        Account {
            lamports: self.lamports.unwrap_or_else(|| svm.rent(data.len())),
            data,
            owner: self.program,
            executable: false,
            rent_epoch: 0,
        }
    }
}

/// Place a token account.
pub fn put_token(svm: &mut impl SvmExt, key: Pubkey, acct: &TokenAcct) {
    let account = acct.account(&*svm);
    svm.put(key, account);
}

/// Place a mint.
pub fn put_mint(svm: &mut impl SvmExt, key: Pubkey, mint: &MintAcct) {
    let account = mint.account(&*svm);
    svm.put(key, account);
}

// =====================================================================================
// Views
// =====================================================================================

fn rd_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().expect("8 bytes"))
}

fn rd_key(d: &[u8], off: usize) -> Pubkey {
    Pubkey::try_from(&d[off..off + 32]).expect("32 bytes")
}

fn rd_coption_key(d: &[u8], tag_off: usize, key_off: usize) -> Option<Pubkey> {
    let tag = u32::from_le_bytes(d[tag_off..tag_off + 4].try_into().expect("4 bytes"));
    (tag == 1).then(|| rd_key(d, key_off))
}

/// Decoded token account (first 165 bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub delegated_amount: u64,
    pub state: u8,
    pub is_native: Option<u64>,
    pub close_authority: Option<Pubkey>,
    pub len: usize,
}

impl TokenView {
    pub fn parse(data: &[u8]) -> Self {
        assert!(
            data.len() >= TOKEN_ACCOUNT_LEN,
            "not a token account: {} bytes",
            data.len()
        );
        let is_native_tag = u32::from_le_bytes(
            data[OFF_IS_NATIVE_TAG..OFF_IS_NATIVE_TAG + 4]
                .try_into()
                .expect("4 bytes"),
        );
        Self {
            mint: rd_key(data, OFF_MINT),
            owner: rd_key(data, OFF_OWNER),
            amount: rd_u64(data, OFF_AMOUNT),
            delegate: rd_coption_key(data, OFF_DELEGATE_TAG, OFF_DELEGATE),
            delegated_amount: rd_u64(data, OFF_DELEGATED_AMOUNT),
            state: data[OFF_STATE],
            is_native: (is_native_tag == 1).then(|| rd_u64(data, OFF_IS_NATIVE)),
            close_authority: rd_coption_key(data, OFF_CLOSE_AUTH_TAG, OFF_CLOSE_AUTH),
            len: data.len(),
        }
    }
}

/// Decoded mint (first 82 bytes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintView {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub initialized: u8,
    pub freeze_authority: Option<Pubkey>,
    pub len: usize,
}

impl MintView {
    pub fn parse(data: &[u8]) -> Self {
        assert!(data.len() >= MINT_LEN, "not a mint: {} bytes", data.len());
        Self {
            mint_authority: rd_coption_key(data, MINT_OFF_AUTH_TAG, MINT_OFF_AUTH),
            supply: rd_u64(data, MINT_OFF_SUPPLY),
            decimals: data[MINT_OFF_DECIMALS],
            initialized: data[MINT_OFF_INITIALIZED],
            freeze_authority: rd_coption_key(data, MINT_OFF_FREEZE_TAG, MINT_OFF_FREEZE_AUTH),
            len: data.len(),
        }
    }
}

// =====================================================================================
// Raw SPL instruction builders (identical wire format for Token and Token-2022)
// =====================================================================================

/// `TransferChecked` (tag 12). `authority` signs.
pub fn spl_transfer_checked(
    program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// Legacy `Transfer` (tag 3).
pub fn spl_transfer(
    program: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*source, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// `Approve` (tag 4): `[source W, delegate R, owner S]`. This is the instruction the OWNER sends
/// at onboarding; with the agent as signer it must fail with Token `Custom(4)`.
pub fn spl_approve(
    program: &Pubkey,
    source: &Pubkey,
    delegate: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = vec![4u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*delegate, false),
            AccountMeta::new_readonly(*owner, true),
        ],
    )
}

/// `Revoke` (tag 5): `[source W, owner S]`.
pub fn spl_revoke(program: &Pubkey, source: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        *program,
        &[5u8],
        vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*owner, true),
        ],
    )
}

/// `SetAuthority` (tag 6) of type `AccountOwner` (2) or `CloseAccount` (3) to `new_authority`.
pub fn spl_set_authority(
    program: &Pubkey,
    account: &Pubkey,
    current_authority: &Pubkey,
    authority_type: u8,
    new_authority: Option<&Pubkey>,
) -> Instruction {
    let mut data = vec![6u8, authority_type];
    match new_authority {
        Some(k) => {
            data.push(1);
            data.extend_from_slice(k.as_ref());
        }
        None => data.push(0),
    }
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*current_authority, true),
        ],
    )
}

/// `AccountOwner` authority type for [`spl_set_authority`].
pub const AUTH_ACCOUNT_OWNER: u8 = 2;
/// `CloseAccount` authority type for [`spl_set_authority`].
pub const AUTH_CLOSE_ACCOUNT: u8 = 3;

/// `CloseAccount` (tag 9): `[account W, destination W, owner S]`.
pub fn spl_close_account(
    program: &Pubkey,
    account: &Pubkey,
    destination: &Pubkey,
    owner: &Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        *program,
        &[9u8],
        vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*owner, true),
        ],
    )
}

/// `Burn` (tag 8): `[account W, mint W, authority S]`.
pub fn spl_burn(
    program: &Pubkey,
    account: &Pubkey,
    mint: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = vec![8u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction::new_with_bytes(
        *program,
        &data,
        vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// ATA program `CreateIdempotent` (tag 1): creates the associated token account for
/// (`wallet`, `mint`) under `token_program`, paid by `funder`. Used to obtain REAL 170-byte
/// Token-2022 ImmutableOwner accounts (T22-07).
pub fn ata_create_idempotent(
    funder: &Pubkey,
    wallet: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let ata = super::ids::ata_address(wallet, token_program, mint);
    Instruction::new_with_bytes(
        super::ids::ATA_PROGRAM_ID,
        &[1u8],
        vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(super::ids::SYSTEM_ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
    )
}
