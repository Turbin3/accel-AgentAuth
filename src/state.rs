//! Zero-copy views over the mandate account.
//!
//! The runtime hands us a raw, unaligned `&mut [u8]`, so every field is read
//! and written with explicit little-endian conversions. No `repr(C)` structs or
//! pointer casts — those are UB on an unaligned buffer.

use pinocchio::pubkey::Pubkey;

use crate::constants::*;
use crate::error::MandateError;

/// A mutable view over a 2136-byte mandate account.
pub struct Mandate<'a> {
    data: &'a mut [u8],
}

impl<'a> Mandate<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, MandateError> {
        if data.len() != ACCOUNT_SIZE {
            return Err(MandateError::InvalidInstructionData);
        }
        Ok(Self { data })
    }

    // --- header ---------------------------------------------------------

    pub fn discriminator(&self) -> u8 {
        self.data[OFF_DISC]
    }

    pub fn set_discriminator(&mut self, v: u8) {
        self.data[OFF_DISC] = v;
    }

    pub fn owner(&self) -> &[u8] {
        &self.data[OFF_OWNER..OFF_OWNER + 32]
    }

    pub fn set_owner(&mut self, key: &Pubkey) {
        self.data[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(key);
    }

    pub fn agent(&self) -> &[u8] {
        &self.data[OFF_AGENT..OFF_AGENT + 32]
    }

    pub fn set_agent(&mut self, key: &Pubkey) {
        self.data[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(key);
    }

    pub fn expiry(&self) -> i64 {
        i64::from_le_bytes(self.data[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap())
    }

    pub fn set_expiry(&mut self, ts: i64) {
        self.data[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&ts.to_le_bytes());
    }

    pub fn is_active(&self) -> bool {
        self.data[OFF_ACTIVE] == 1
    }

    pub fn set_active(&mut self, active: bool) {
        self.data[OFF_ACTIVE] = active as u8;
    }

    pub fn permissions_len(&self) -> usize {
        u16::from_le_bytes(self.data[OFF_PERM_LEN..OFF_PERM_LEN + 2].try_into().unwrap()) as usize
    }

    fn set_permissions_len(&mut self, n: usize) {
        self.data[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&(n as u16).to_le_bytes());
    }

    // --- permissions ----------------------------------------------------

    pub fn permission(&self, i: usize) -> Permission<'_> {
        let base = HEADER_SIZE + i * PERMISSION_SIZE;
        Permission {
            data: &self.data[base..base + PERMISSION_SIZE],
        }
    }

    pub fn permission_mut(&mut self, i: usize) -> PermissionMut<'_> {
        let base = HEADER_SIZE + i * PERMISSION_SIZE;
        PermissionMut {
            data: &mut self.data[base..base + PERMISSION_SIZE],
        }
    }

    /// Index of the permission whose `program_id` matches, if any.
    pub fn find_permission(&self, program_id: &Pubkey) -> Option<usize> {
        (0..self.permissions_len()).find(|&i| self.permission(i).program_id() == &program_id[..])
    }

    /// Append a permission and return its index. Counters start at zero.
    pub fn append_permission(
        &mut self,
        program_id: &Pubkey,
        spend_limit: u64,
        per_tx_limit: u64,
        discriminators: &[[u8; 8]],
    ) -> Result<usize, MandateError> {
        if discriminators.len() > MAX_DISCRIMINATORS {
            return Err(MandateError::TooManyDiscriminators);
        }
        let len = self.permissions_len();
        if len >= MAX_PERMISSIONS {
            return Err(MandateError::PermissionsFull);
        }

        {
            let mut p = self.permission_mut(len);
            p.clear();
            p.set_program_id(program_id);
            p.set_spend_limit(spend_limit);
            p.set_per_tx_limit(per_tx_limit);
            for (i, d) in discriminators.iter().enumerate() {
                p.set_discriminator(i, d);
            }
            p.set_discriminators_len(discriminators.len() as u8);
        }

        self.set_permissions_len(len + 1);
        Ok(len)
    }

    /// Remove permission `idx` by moving the last one into its place and
    /// zeroing the now-unused tail slot. O(1) and keeps the array packed.
    pub fn swap_remove_permission(&mut self, idx: usize) -> Result<(), MandateError> {
        let len = self.permissions_len();
        if idx >= len {
            return Err(MandateError::PermissionNotFound);
        }

        let last = len - 1;
        if idx != last {
            let mut tmp = [0u8; PERMISSION_SIZE];
            let src = HEADER_SIZE + last * PERMISSION_SIZE;
            tmp.copy_from_slice(&self.data[src..src + PERMISSION_SIZE]);
            let dst = HEADER_SIZE + idx * PERMISSION_SIZE;
            self.data[dst..dst + PERMISSION_SIZE].copy_from_slice(&tmp);
        }

        let tail = HEADER_SIZE + last * PERMISSION_SIZE;
        self.data[tail..tail + PERMISSION_SIZE].fill(0);
        self.set_permissions_len(last);
        Ok(())
    }
}

/// Read-only view over a single 128-byte permission slot.
pub struct Permission<'a> {
    data: &'a [u8],
}

impl<'a> Permission<'a> {
    pub fn program_id(&self) -> &[u8] {
        &self.data[P_PROGRAM_ID..P_PROGRAM_ID + 32]
    }

    pub fn spend_limit(&self) -> u64 {
        u64::from_le_bytes(self.data[P_SPEND_LIMIT..P_SPEND_LIMIT + 8].try_into().unwrap())
    }

    pub fn per_tx_limit(&self) -> u64 {
        u64::from_le_bytes(self.data[P_PER_TX_LIMIT..P_PER_TX_LIMIT + 8].try_into().unwrap())
    }

    pub fn spend_total(&self) -> u64 {
        u64::from_le_bytes(self.data[P_SPEND_TOTAL..P_SPEND_TOTAL + 8].try_into().unwrap())
    }

    pub fn call_count(&self) -> u32 {
        u32::from_le_bytes(self.data[P_CALL_COUNT..P_CALL_COUNT + 4].try_into().unwrap())
    }

    pub fn discriminators_len(&self) -> usize {
        self.data[P_DISC_LEN] as usize
    }

    pub fn discriminator(&self, i: usize) -> &[u8] {
        let off = P_DISCRIMINATORS + i * 8;
        &self.data[off..off + 8]
    }

    /// True if `disc` is in this permission's allow-list.
    pub fn allows(&self, disc: &[u8; 8]) -> bool {
        (0..self.discriminators_len()).any(|i| self.discriminator(i) == &disc[..])
    }
}

/// Mutable view over a single 128-byte permission slot.
pub struct PermissionMut<'a> {
    data: &'a mut [u8],
}

impl<'a> PermissionMut<'a> {
    pub fn clear(&mut self) {
        self.data.fill(0);
    }

    pub fn set_program_id(&mut self, key: &Pubkey) {
        self.data[P_PROGRAM_ID..P_PROGRAM_ID + 32].copy_from_slice(key);
    }

    pub fn set_spend_limit(&mut self, v: u64) {
        self.data[P_SPEND_LIMIT..P_SPEND_LIMIT + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn set_per_tx_limit(&mut self, v: u64) {
        self.data[P_PER_TX_LIMIT..P_PER_TX_LIMIT + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn set_spend_total(&mut self, v: u64) {
        self.data[P_SPEND_TOTAL..P_SPEND_TOTAL + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn set_call_count(&mut self, v: u32) {
        self.data[P_CALL_COUNT..P_CALL_COUNT + 4].copy_from_slice(&v.to_le_bytes());
    }

    pub fn set_discriminators_len(&mut self, n: u8) {
        self.data[P_DISC_LEN] = n;
    }

    pub fn set_discriminator(&mut self, i: usize, disc: &[u8; 8]) {
        let off = P_DISCRIMINATORS + i * 8;
        self.data[off..off + 8].copy_from_slice(disc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> [u8; ACCOUNT_SIZE] {
        [0u8; ACCOUNT_SIZE]
    }

    #[test]
    fn mandate_size_is_2136() {
        assert_eq!(ACCOUNT_SIZE, 2136);
        assert_eq!(HEADER_SIZE + MAX_PERMISSIONS * PERMISSION_SIZE, ACCOUNT_SIZE);
    }

    #[test]
    fn permission_size_is_128() {
        assert_eq!(PERMISSION_SIZE, 128);
        // slot 0 starts right after the header, slot 1 one stride later
        assert_eq!(HEADER_SIZE + 0 * PERMISSION_SIZE, 88);
        assert_eq!(HEADER_SIZE + 1 * PERMISSION_SIZE, 216);
    }

    #[test]
    fn permission_roundtrips() {
        let mut buf = blank();
        let mut m = Mandate::from_bytes(&mut buf).unwrap();

        let pid = [7u8; 32];
        let discs = [[1, 0, 0, 0, 0, 0, 0, 0u8], [9, 9, 9, 9, 9, 9, 9, 9u8]];
        let idx = m.append_permission(&pid, 1_000, 250, &discs).unwrap();

        let p = m.permission(idx);
        assert_eq!(p.program_id(), &pid[..]);
        assert_eq!(p.spend_limit(), 1_000);
        assert_eq!(p.per_tx_limit(), 250);
        assert_eq!(p.spend_total(), 0);
        assert_eq!(p.call_count(), 0);
        assert_eq!(p.discriminators_len(), 2);
        assert_eq!(p.discriminator(0), &discs[0][..]);
        assert_eq!(p.discriminator(1), &discs[1][..]);
        assert!(p.allows(&discs[1]));
        assert!(!p.allows(&[5, 5, 5, 5, 5, 5, 5, 5]));
    }

    #[test]
    fn append_rejects_full_16() {
        let mut buf = blank();
        let mut m = Mandate::from_bytes(&mut buf).unwrap();

        for i in 0..MAX_PERMISSIONS {
            m.append_permission(&[i as u8; 32], 0, 0, &[]).unwrap();
        }
        assert_eq!(m.permissions_len(), 16);

        let err = m.append_permission(&[99u8; 32], 0, 0, &[]).unwrap_err();
        assert!(matches!(err, MandateError::PermissionsFull));
        assert_eq!(m.permissions_len(), 16);
    }

    #[test]
    fn swap_remove_preserves_others() {
        let mut buf = blank();
        let mut m = Mandate::from_bytes(&mut buf).unwrap();

        for i in 0..4u8 {
            m.append_permission(&[i; 32], (i as u64) + 1, 0, &[]).unwrap();
        }

        // drop index 1; the last one ([3; 32]) slides into slot 1
        m.swap_remove_permission(1).unwrap();
        assert_eq!(m.permissions_len(), 3);
        assert_eq!(m.permission(0).program_id(), &[0u8; 32][..]);
        assert_eq!(m.permission(1).program_id(), &[3u8; 32][..]);
        assert_eq!(m.permission(2).program_id(), &[2u8; 32][..]);
        drop(m);

        let tail = HEADER_SIZE + 3 * PERMISSION_SIZE;
        assert!(buf[tail..tail + PERMISSION_SIZE].iter().all(|&b| b == 0));
    }
}
