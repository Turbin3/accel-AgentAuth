#[cfg(test)]
mod tests {
    use agent_auth::state::Mandate;
    use agent_auth::*;

    const OWNER: [u8; 32] = [1u8; 32];
    const AGENT: [u8; 32] = [2u8; 32];

    /// Build a mandate buffer pre-filled with `n` permission slots.
    /// Slot i gets:
    ///   program_id  = [i as u8; 32]
    ///   spend_limit = i * 100
    ///   per_tx      = i * 10
    fn make_mandate_n_perms(n: usize) -> [u8; ACCOUNT_SIZE] {
        let mut buf = [0u8; ACCOUNT_SIZE];
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        m.set_discriminator(MANDATE_DISCRIMINATOR);
        m.set_owner(&OWNER);
        m.set_agent(&AGENT);
        m.set_expiry(i64::MAX);
        m.set_active(true);
        for i in 0..n {
            m.append_permission(&[i as u8; 32], (i as u64) * 100, (i as u64) * 10, &[])
                .unwrap();
        }
        buf
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 1 — remove_swap_remove_preserves_others
    // ──────────────────────────────────────────────────────────────────────
    /// Removing a middle slot:
    ///   • moves the last slot into the removed slot's position,
    ///   • decrements `permissions_len`,
    ///   • zeroes the vacated tail slot,
    ///   • leaves every other slot byte-intact.
    ///
    /// Why it matters: an O(1) swap-remove that doesn't pack correctly or
    /// leaves the tail non-zeroed could expose stale permission data.
    #[test]
    fn remove_swap_remove_preserves_others() {
        // 4 slots: [0;32] [1;32] [2;32] [3;32]
        let mut buf = make_mandate_n_perms(4);

        {
            let mut m = Mandate::from_bytes(&mut buf).unwrap();
            assert_eq!(m.permissions_len(), 4, "pre-condition: 4 slots");

            // Remove slot 1 ([1u8;32]) — slot 3 ([3u8;32]) must swap in
            let idx = m
                .find_permission(&[1u8; 32])
                .expect("slot 1 must be present before remove");
            m.swap_remove_permission(idx).unwrap();

            assert_eq!(m.permissions_len(), 3, "length must drop to 3");

            assert_eq!(
                m.permission(0).program_id(),
                &[0u8; 32][..],
                "slot 0 must be untouched"
            );
            assert_eq!(
                m.permission(1).program_id(),
                &[3u8; 32][..],
                "slot 1 must now hold the former last slot"
            );
            assert_eq!(
                m.permission(2).program_id(),
                &[2u8; 32][..],
                "slot 2 must be untouched"
            );
        } // mandate dropped — safe to inspect raw bytes

        // Vacated tail slot (index 3) must be all zeros
        let tail_start = HEADER_SIZE + 3 * PERMISSION_SIZE;
        assert!(
            buf[tail_start..tail_start + PERMISSION_SIZE]
                .iter()
                .all(|&b| b == 0),
            "vacated tail slot must be zeroed"
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 2 — remove_rejects_not_found
    // ──────────────────────────────────────────────────────────────────────
    /// Removing a program_id that has no slot must not change `permissions_len`.
    ///
    /// Why it matters: silently "removing" a non-existent permission would
    /// hide owner mistakes and make revocation auditing unreliable.
    #[test]
    fn remove_rejects_not_found() {
        let mut buf = make_mandate_n_perms(3); // slots 0, 1, 2
        let mut m = Mandate::from_bytes(&mut buf).unwrap();

        let original_len = m.permissions_len();
        assert_eq!(original_len, 3);

        // [0xFF; 32] was never added
        let not_found = m.find_permission(&[0xFFu8; 32]);
        assert!(not_found.is_none(), "unknown program must not be found");

        // swap_remove with an out-of-range index must return PermissionNotFound
        let err = m
            .swap_remove_permission(99)
            .expect_err("swap_remove with invalid idx must error");
        assert!(
            matches!(err, MandateError::PermissionNotFound),
            "expected PermissionNotFound, got {err:?}"
        );

        // Length must be completely unchanged
        assert_eq!(
            m.permissions_len(),
            original_len,
            "permissions_len must not change on a failed remove"
        );
    }
}
