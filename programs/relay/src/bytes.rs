//! Panic-free fixed-offset readers over untrusted account bytes.
//!
//! Every reader returns a fail-closed default (zero key, zero integer) when the
//! range is out of bounds. Callers validate lengths first (`check_policy`,
//! `check_mandate`, `token_acct_ok`, `check_mint`), so the default is
//! unreachable in practice; if it were reached, a zero value fails every
//! equality or minimum check the relay performs.

use pinocchio::pubkey::Pubkey;

const ZERO_KEY: Pubkey = [0u8; 32];

/// Key equality, deliberately not inlined: 32-byte comparisons are repeated
/// ~100 times across the validation code and inlining each one costs program
/// size (the `.so` budget is 64 KB) for a negligible CU saving.
#[inline(never)]
pub fn same_key(a: &Pubkey, b: &Pubkey) -> bool {
    a == b
}

/// 32 bytes at `off` as a key reference (zero key if out of range).
#[inline]
pub fn key_at(data: &[u8], off: usize) -> &Pubkey {
    off.checked_add(32)
        .and_then(|end| data.get(off..end))
        .and_then(|s| <&Pubkey>::try_from(s).ok())
        .unwrap_or(&ZERO_KEY)
}

/// Little-endian `u64` at `off` (0 if out of range).
#[inline]
pub fn u64_at(data: &[u8], off: usize) -> u64 {
    off.checked_add(8)
        .and_then(|end| data.get(off..end))
        .and_then(|s| <[u8; 8]>::try_from(s).ok())
        .map(u64::from_le_bytes)
        .unwrap_or(0)
}

/// Little-endian `u32` at `off` (0 if out of range).
#[inline]
pub fn u32_at(data: &[u8], off: usize) -> u32 {
    off.checked_add(4)
        .and_then(|end| data.get(off..end))
        .and_then(|s| <[u8; 4]>::try_from(s).ok())
        .map(u32::from_le_bytes)
        .unwrap_or(0)
}

/// Byte at `off` (0 if out of range).
#[inline]
pub fn byte_at(data: &[u8], off: usize) -> u8 {
    data.get(off).copied().unwrap_or(0)
}

/// `len` bytes at `off` (empty if out of range).
#[inline]
pub fn slice_at(data: &[u8], off: usize, len: usize) -> &[u8] {
    off.checked_add(len)
        .and_then(|end| data.get(off..end))
        .unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_range_reads() {
        let mut d = [0u8; 48];
        d[8..40].copy_from_slice(&[7u8; 32]);
        d[40..48].copy_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
        assert_eq!(key_at(&d, 8), &[7u8; 32]);
        assert_eq!(u64_at(&d, 40), 0x0102_0304_0506_0708);
        assert_eq!(u32_at(&d, 40), 0x0506_0708);
        assert_eq!(byte_at(&d, 8), 7);
        assert_eq!(slice_at(&d, 8, 2), &[7, 7]);
    }

    #[test]
    fn out_of_range_fails_closed_without_panicking() {
        let d = [1u8; 16];
        assert_eq!(key_at(&d, 0), &[0u8; 32]);
        assert_eq!(key_at(&d, usize::MAX), &[0u8; 32]);
        assert_eq!(u64_at(&d, 9), 0);
        assert_eq!(u64_at(&d, usize::MAX), 0);
        assert_eq!(u32_at(&d, 13), 0);
        assert_eq!(byte_at(&d, 16), 0);
        assert!(slice_at(&d, 10, 7).is_empty());
        assert!(slice_at(&d, usize::MAX, 2).is_empty());
    }
}
