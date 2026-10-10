//! SPL Token / Token-2022 byte layouts and the validation routines the relay
//! applies to token accounts and mints (RELAY-SPEC sections 6.3 to 6.5).
//!
//! Only reads happen here; the relay never builds an `Approve`, `SetAuthority`,
//! `Revoke`, `CloseAccount` or `Burn`.

use pinocchio::{
    account_info::{AccountInfo, Ref},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::bytes::{byte_at, key_at, slice_at, u32_at, u64_at};
use crate::error::RelayError;
use crate::ids::TOKEN22_ID;

/// Classic token-account length.
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// Token-2022 account carrying exactly the ImmutableOwner extension.
pub const TOKEN22_ATA_LEN: usize = 170;
/// Mint length (extension-free).
pub const MINT_LEN: usize = 82;

/// Token account: mint key.
pub const TA_MINT: usize = 0;
/// Token account: owner key.
pub const TA_OWNER: usize = 32;
/// Token account: amount (u64 LE).
pub const TA_AMOUNT: usize = 64;
/// Token account: delegate COption (tag u32 + key), 36 bytes.
pub const TA_DELEGATE: usize = 72;
/// Token account: state byte (0 uninit, 1 initialised, 2 frozen).
pub const TA_STATE: usize = 108;
/// Token account: delegated amount (u64 LE).
pub const TA_DELEGATED_AMOUNT: usize = 121;
/// Token account: close-authority COption (tag u32 + key), 36 bytes.
pub const TA_CLOSE_AUTHORITY: usize = 129;
/// Token-2022 account-type byte (2 = Account).
pub const TA22_ACCOUNT_TYPE: usize = 165;
/// Token-2022 TLV header of the ImmutableOwner extension (type 7, length 0).
const TA22_IMMUTABLE_OWNER_TLV: [u8; 4] = [7, 0, 0, 0];

/// Mint: decimals byte.
pub const MINT_DECIMALS: usize = 44;
/// Mint: is-initialised byte.
pub const MINT_INITIALIZED: usize = 45;

/// Initialised token-account state value.
pub const STATE_INITIALIZED: u8 = 1;
/// Length of a `COption<Pubkey>` (u32 tag + 32-byte key).
pub const COPTION_KEY_LEN: usize = 36;

/// Pure layout check of a token account (RELAY-SPEC 6.3 steps 2 and 3).
///
/// Accepts 165 bytes, or for Token-2022 exactly the 170-byte shape with
/// AccountType = 2 and TLV = ImmutableOwner only (what the ATA program
/// creates). The state byte must be Initialised (not frozen). Errors are
/// `TokenAccountState` (105).
pub fn token_layout_ok(data: &[u8], program_key: &Pubkey) -> Result<(), RelayError> {
    let len_ok = data.len() == TOKEN_ACCOUNT_LEN
        || (program_key == &TOKEN22_ID
            && data.len() == TOKEN22_ATA_LEN
            && byte_at(data, TA22_ACCOUNT_TYPE) == 2
            && slice_at(data, TA22_ACCOUNT_TYPE + 1, 4) == TA22_IMMUTABLE_OWNER_TLV);
    if !len_ok || byte_at(data, TA_STATE) != STATE_INITIALIZED {
        return Err(RelayError::TokenAccountState);
    }
    Ok(())
}

/// `token_acct_ok` of RELAY-SPEC 6.3: the account is owned by `program_key`
/// (else 103) and has an accepted layout and initialised state (else 105).
///
/// Returns the data borrow so the caller can read fields without a second
/// borrow. The caller must drop it before any CPI that includes the account.
pub fn token_acct_ok<'a>(
    acct: &'a AccountInfo,
    program_key: &Pubkey,
) -> Result<Ref<'a, [u8]>, ProgramError> {
    if acct.owner() != program_key {
        return Err(RelayError::WrongProgram.into());
    }
    let data = acct.try_borrow_data()?;
    token_layout_ok(&data, program_key)?;
    Ok(data)
}

/// `check_mint` of RELAY-SPEC 6.4: owned by `program_key`, exactly 82 bytes
/// (any Token-2022 extension makes a mint longer, so this rejects them all)
/// and initialised. Returns the mint's decimals. Errors are `WrongProgram`.
pub fn check_mint(mint: &AccountInfo, program_key: &Pubkey) -> Result<u8, ProgramError> {
    if mint.owner() != program_key || mint.data_len() != MINT_LEN {
        return Err(RelayError::WrongProgram.into());
    }
    let data = mint.try_borrow_data()?;
    if byte_at(&data, MINT_INITIALIZED) != 1 {
        return Err(RelayError::WrongProgram.into());
    }
    Ok(byte_at(&data, MINT_DECIMALS))
}

/// Read-only field accessors over validated token-account bytes.
#[derive(Clone, Copy)]
pub struct TokenAcct<'a>(pub &'a [u8]);

impl<'a> TokenAcct<'a> {
    /// Mint key.
    pub fn mint(&self) -> &'a Pubkey {
        key_at(self.0, TA_MINT)
    }
    /// Owner field.
    pub fn owner(&self) -> &'a Pubkey {
        key_at(self.0, TA_OWNER)
    }
    /// Token balance.
    pub fn amount(&self) -> u64 {
        u64_at(self.0, TA_AMOUNT)
    }
    /// Delegated amount.
    pub fn delegated_amount(&self) -> u64 {
        u64_at(self.0, TA_DELEGATED_AMOUNT)
    }
    /// `true` iff the delegate COption is `Some(key)`.
    pub fn delegate_is(&self, key: &Pubkey) -> bool {
        u32_at(self.0, TA_DELEGATE) == 1 && key_at(self.0, TA_DELEGATE + 4) == key
    }
}

/// Immutable copy of the owner-side fields a callee must not change.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Snapshot {
    /// Program that owns the account.
    pub owner_program: Pubkey,
    /// Account data length.
    pub data_len: usize,
    /// Token-account owner field.
    pub owner_field: Pubkey,
    /// State byte.
    pub state: u8,
    /// Raw delegate COption (36 bytes).
    pub delegate_raw: [u8; COPTION_KEY_LEN],
    /// Raw close-authority COption (36 bytes).
    pub close_raw: [u8; COPTION_KEY_LEN],
    /// Balance.
    pub amount: u64,
    /// Delegated amount.
    pub delegated: u64,
}

impl Snapshot {
    /// Capture from account metadata and its (already validated) data.
    pub fn take(owner_program: &Pubkey, data_len: usize, data: &[u8]) -> Self {
        Self {
            owner_program: *owner_program,
            data_len,
            owner_field: *key_at(data, TA_OWNER),
            state: byte_at(data, TA_STATE),
            delegate_raw: coption_at(data, TA_DELEGATE),
            close_raw: coption_at(data, TA_CLOSE_AUTHORITY),
            amount: u64_at(data, TA_AMOUNT),
            delegated: u64_at(data, TA_DELEGATED_AMOUNT),
        }
    }

    /// Invariants a callee must preserve (RELAY-SPEC 7.5 step 19, error 119):
    /// owner program, data length, owner field, state and close authority are
    /// unchanged, and the raw delegate bytes are unchanged, except that when
    /// `allow_delegate_clear` the delegate may become `None` iff the delegated
    /// amount fell to zero (the Token program clears it then; whether it also
    /// zeroes the key bytes differs between implementations, so only the tag is
    /// compared in that case).
    pub fn invariants_hold(&self, after: &Snapshot, allow_delegate_clear: bool) -> bool {
        let delegate_ok = self.delegate_raw == after.delegate_raw
            || (allow_delegate_clear
                && after.delegated == 0
                && u32_at(&after.delegate_raw, 0) == 0);
        self.owner_program == after.owner_program
            && self.data_len == after.data_len
            && self.owner_field == after.owner_field
            && self.state == after.state
            && self.close_raw == after.close_raw
            && delegate_ok
    }
}

/// The 36 raw bytes of a `COption<Pubkey>` at `off` (zeros if out of range).
fn coption_at(data: &[u8], off: usize) -> [u8; COPTION_KEY_LEN] {
    <[u8; COPTION_KEY_LEN]>::try_from(slice_at(data, off, COPTION_KEY_LEN))
        .unwrap_or([0u8; COPTION_KEY_LEN])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::TOKEN_ID;

    fn base(len: usize) -> Vec<u8> {
        let mut d = vec![0u8; len];
        d[TA_STATE] = 1;
        d
    }

    #[test]
    fn classic_layout() {
        assert!(token_layout_ok(&base(165), &TOKEN_ID).is_ok());
        assert!(token_layout_ok(&base(165), &TOKEN22_ID).is_ok());
        assert_eq!(
            token_layout_ok(&base(164), &TOKEN_ID),
            Err(RelayError::TokenAccountState)
        );
    }

    #[test]
    fn frozen_and_uninitialised_rejected() {
        for state in [0u8, 2, 3] {
            let mut d = base(165);
            d[TA_STATE] = state;
            assert_eq!(
                token_layout_ok(&d, &TOKEN_ID),
                Err(RelayError::TokenAccountState)
            );
        }
    }

    /// T22-07 / T22-08: the exact ATA shape only, only for Token-2022.
    #[test]
    fn token22_immutable_owner_shape() {
        let mut ata = base(170);
        ata[165] = 2;
        ata[166..170].copy_from_slice(&[7, 0, 0, 0]);
        assert!(token_layout_ok(&ata, &TOKEN22_ID).is_ok());
        // Same bytes under the classic program id are rejected.
        assert!(token_layout_ok(&ata, &TOKEN_ID).is_err());
        // Wrong account type.
        let mut bad = ata.clone();
        bad[165] = 1;
        assert!(token_layout_ok(&bad, &TOKEN22_ID).is_err());
        // Wrong extension type.
        let mut bad = ata.clone();
        bad[166] = 8;
        assert!(token_layout_ok(&bad, &TOKEN22_ID).is_err());
        // Non-zero extension length.
        let mut bad = ata.clone();
        bad[168] = 1;
        assert!(token_layout_ok(&bad, &TOKEN22_ID).is_err());
        // Longer account (e.g. CpiGuard / MemoTransfer) is rejected.
        let mut longer = base(171);
        longer[165] = 2;
        longer[166..170].copy_from_slice(&[7, 0, 0, 0]);
        assert!(token_layout_ok(&longer, &TOKEN22_ID).is_err());
    }

    #[test]
    fn field_offsets_match_spl_layout() {
        let mut d = base(165);
        d[TA_MINT..TA_MINT + 32].copy_from_slice(&[1u8; 32]);
        d[TA_OWNER..TA_OWNER + 32].copy_from_slice(&[2u8; 32]);
        d[TA_AMOUNT..TA_AMOUNT + 8].copy_from_slice(&77u64.to_le_bytes());
        d[TA_DELEGATE..TA_DELEGATE + 4].copy_from_slice(&1u32.to_le_bytes());
        d[TA_DELEGATE + 4..TA_DELEGATE + 36].copy_from_slice(&[3u8; 32]);
        d[TA_DELEGATED_AMOUNT..TA_DELEGATED_AMOUNT + 8].copy_from_slice(&55u64.to_le_bytes());
        let t = TokenAcct(&d);
        assert_eq!(t.mint(), &[1u8; 32]);
        assert_eq!(t.owner(), &[2u8; 32]);
        assert_eq!(t.amount(), 77);
        assert_eq!(t.delegated_amount(), 55);
        assert!(t.delegate_is(&[3u8; 32]));
        assert!(!t.delegate_is(&[4u8; 32]));
        // SPL layout sanity: 165 = close authority end.
        assert_eq!(TA_CLOSE_AUTHORITY + COPTION_KEY_LEN, TOKEN_ACCOUNT_LEN);
    }

    #[test]
    fn delegate_none_tag_is_not_a_match() {
        let mut d = base(165);
        d[TA_DELEGATE + 4..TA_DELEGATE + 36].copy_from_slice(&[3u8; 32]);
        assert!(!TokenAcct(&d).delegate_is(&[3u8; 32]));
    }

    fn snap(data: &[u8]) -> Snapshot {
        Snapshot::take(&TOKEN_ID, data.len(), data)
    }

    #[test]
    fn invariants_detect_every_forbidden_change() {
        let mut d = base(165);
        d[TA_OWNER..TA_OWNER + 32].copy_from_slice(&[2u8; 32]);
        d[TA_DELEGATE..TA_DELEGATE + 4].copy_from_slice(&1u32.to_le_bytes());
        d[TA_DELEGATE + 4..TA_DELEGATE + 36].copy_from_slice(&[3u8; 32]);
        d[TA_DELEGATED_AMOUNT..TA_DELEGATED_AMOUNT + 8].copy_from_slice(&10u64.to_le_bytes());
        let before = snap(&d);
        assert!(before.invariants_hold(&before, false));

        let mut e = d.clone();
        e[TA_OWNER] ^= 1;
        assert!(!before.invariants_hold(&snap(&e), true));

        let mut e = d.clone();
        e[TA_STATE] = 2;
        assert!(!before.invariants_hold(&snap(&e), true));

        let mut e = d.clone();
        e[TA_CLOSE_AUTHORITY] = 1;
        assert!(!before.invariants_hold(&snap(&e), true));

        let mut e = d.clone();
        e[TA_DELEGATE + 4] ^= 1;
        assert!(!before.invariants_hold(&snap(&e), true));

        let mut e = d.clone();
        e.push(0);
        assert!(!before.invariants_hold(&snap(&e), true));

        let mut other_owner = before;
        other_owner.owner_program = [9u8; 32];
        assert!(!before.invariants_hold(&other_owner, true));

        // balance / delegated_amount changes alone are not invariants.
        let mut e = d.clone();
        e[TA_AMOUNT] = 5;
        e[TA_DELEGATED_AMOUNT] = 5;
        assert!(before.invariants_hold(&snap(&e), false));
    }

    #[test]
    fn delegate_clear_only_at_zero_delegated_and_only_when_allowed() {
        let mut d = base(165);
        d[TA_DELEGATE..TA_DELEGATE + 4].copy_from_slice(&1u32.to_le_bytes());
        d[TA_DELEGATE + 4..TA_DELEGATE + 36].copy_from_slice(&[3u8; 32]);
        d[TA_DELEGATED_AMOUNT..TA_DELEGATED_AMOUNT + 8].copy_from_slice(&10u64.to_le_bytes());
        let before = snap(&d);

        // Token program clears tag; key bytes may or may not be zeroed.
        for zero_key in [false, true] {
            let mut e = d.clone();
            e[TA_DELEGATE..TA_DELEGATE + 4].copy_from_slice(&0u32.to_le_bytes());
            e[TA_DELEGATED_AMOUNT..TA_DELEGATED_AMOUNT + 8].copy_from_slice(&0u64.to_le_bytes());
            if zero_key {
                e[TA_DELEGATE + 4..TA_DELEGATE + 36].fill(0);
            }
            assert!(before.invariants_hold(&snap(&e), true));
            // Not allowed for the output account.
            assert!(!before.invariants_hold(&snap(&e), false));
        }

        // Cleared while delegated_amount is still non-zero: violation.
        let mut e = d.clone();
        e[TA_DELEGATE..TA_DELEGATE + 4].copy_from_slice(&0u32.to_le_bytes());
        assert!(!before.invariants_hold(&snap(&e), true));
    }
}
