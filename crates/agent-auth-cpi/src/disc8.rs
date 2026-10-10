//! Helpers to build the 8-byte `disc8` that `verify` takes (the "instruction
//! discriminator" of the action you are about to perform).
//!
//! `disc8` is the canonical 8-byte value defined by the AgentAuth registry
//! (`packages/registry/SCHEMA.md`):
//!
//! | target program kind | `disc8` |
//! |---|---|
//! | Anchor | the first 8 bytes of the instruction data = `sha256("global:<snake_case_name>")[..8]` |
//! | 1-byte-tag (SPL Token, Token-2022, ...) | the tag byte, then 7 zero bytes. NEVER the first 8 raw bytes: for `Transfer` they include 7 bytes of the amount |
//! | u32-LE-tag (System, Stake, ...) | the 4 tag bytes (little endian), then 4 zero bytes |
//!
//! # Anchor discriminators
//!
//! They are SHA-256 based and this crate is `no_std` with a single dependency,
//! so there is deliberately no `anchor_disc!` macro here. Precompute the bytes
//! once and paste them as a `const`:
//!
//! ```text
//! # first 8 bytes of sha256("global:swap_base_input"), as hex
//! printf 'global:swap_base_input' | shasum -a 256 | cut -c1-16
//! ```
//!
//! or look the instruction up in the verified registry (`disc8` field). Then:
//!
//! ```
//! use agent_auth_cpi::disc8;
//! // 8f be 5a da c4 1e 33 de = sha256("global:swap_base_input")[..8]
//! const SWAP_BASE_INPUT: [u8; 8] = disc8::from_prefix(&[0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);
//! # assert_eq!(SWAP_BASE_INPUT[0], 0x8f);
//! ```

/// `disc8` for a program whose instructions start with a single tag byte.
pub const fn from_u8_tag(tag: u8) -> [u8; 8] {
    [tag, 0, 0, 0, 0, 0, 0, 0]
}

/// `disc8` for a program whose instructions start with a little-endian `u32` tag.
pub const fn from_u32_tag(tag: u32) -> [u8; 8] {
    let t = tag.to_le_bytes();
    [t[0], t[1], t[2], t[3], 0, 0, 0, 0]
}

/// `disc8` from the leading bytes of an already-known discriminator (the 8 Anchor
/// bytes, or any prefix up to 8 bytes, zero padded). Usable in `const` context;
/// a prefix longer than 8 bytes is a compile-time panic there (a run-time panic
/// otherwise) so a pasted full hash is caught immediately.
pub const fn from_prefix(prefix: &[u8]) -> [u8; 8] {
    assert!(prefix.len() <= 8, "disc8 prefix must be at most 8 bytes");
    let mut out = [0u8; 8];
    let mut i = 0;
    while i < prefix.len() {
        out[i] = prefix[i];
        i += 1;
    }
    out
}

/// System program `Transfer` (u32 tag 2).
pub const SYSTEM_TRANSFER: [u8; 8] = from_u32_tag(2);
/// SPL Token / Token-2022 `Transfer` (tag 3).
pub const SPL_TOKEN_TRANSFER: [u8; 8] = from_u8_tag(3);
/// SPL Token / Token-2022 `TransferChecked` (tag 12).
pub const SPL_TOKEN_TRANSFER_CHECKED: [u8; 8] = from_u8_tag(12);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_forms() {
        assert_eq!(from_u8_tag(12), [12, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(from_u32_tag(0x0102_0304), [4, 3, 2, 1, 0, 0, 0, 0]);
        assert_eq!(SYSTEM_TRANSFER, [2, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(SPL_TOKEN_TRANSFER, [3, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(SPL_TOKEN_TRANSFER_CHECKED, [12, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn prefix_pads_and_passes_through() {
        assert_eq!(from_prefix(&[]), [0; 8]);
        assert_eq!(from_prefix(&[1, 2, 3]), [1, 2, 3, 0, 0, 0, 0, 0]);
        assert_eq!(
            from_prefix(&[1, 2, 3, 4, 5, 6, 7, 8]),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
    }

    #[test]
    #[should_panic(expected = "at most 8 bytes")]
    fn prefix_rejects_long_input() {
        let _ = from_prefix(&[0; 9]);
    }
}
