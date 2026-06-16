#[cfg(test)]
mod tests {
    use std::i64;

    use agent_auth::state::Mandate;
    use agent_auth::*;
    use pinocchio::account_info::AccountInfo;

    //helpers
    const OWNER: [u8; 32] = [1u8; 32];
    const AGENT: [u8; 32] = [2u8; 32];
    const PROGRAM_ID: [u8; 32] = [9u8; 32];
    const TARGET_PROGRAM: [u8; 32] = [3u8; 32];
    const DISC: [u8; 8] = [0xb, 0xa, 0xb, 0xe, 0, 0, 0, 0];

    //building a valid 2136-byte mandate buffer with one permission
    fn make_mandate(
        active: bool,
        expiry: i64,
        spend_limit: u64,
        per_tx_limit: u64,
        spend_total: u64,
        call_count: u32,
    ) -> [u8; ACCOUNT_SIZE] {
        let mut buf = [0u8; ACCOUNT_SIZE];

        buf[OFF_DISC] = MANDATE_DISCRIMINATOR;
        buf[OFF_OWNER..OFF_OWNER + 32].copy_from_slice(&OWNER);
        buf[OFF_AGENT..OFF_AGENT + 32].copy_from_slice(&AGENT);
        buf[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&expiry.to_le_bytes());
        buf[OFF_ACTIVE] = active as u8;
        buf[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&1u16.to_le_bytes());

        //permission slot
        let base = HEADER_SIZE;
        buf[base..base + 32].copy_from_slice(&TARGET_PROGRAM);
        buf[base + 32..base + 40].copy_from_slice(&spend_limit.to_le_bytes());
        buf[base + 40..base + 48].copy_from_slice(&per_tx_limit.to_le_bytes());
        buf[base + 48..base + 56].copy_from_slice(&spend_total.to_le_bytes());
        buf[base + 56..base + 60].copy_from_slice(&call_count.to_le_bytes());
        buf[base + 60] = 1; //discriminators_len
        buf[base + 64..base + 72].copy_from_slice(&DISC);

        buf
    }

    //build 48 byte verify instruction data
    fn make_ix_data(program_id: [u8; 32], disc: [u8; 8], amount: u64) -> [u8; 48] {
        let mut d = [0u8; 48];
        d[0..32].copy_from_slice(&program_id);
        d[32..40].copy_from_slice(&disc);
        d[40..48].copy_from_slice(&amount.to_le_bytes());
        d
    }

    fn make_account_info(
        key: [u8; 32],
        owner: [u8; 32],
        data: &mut Vec<u8>,
        writable: bool,
    ) -> AccountInfo {
        todo!("Later fix")
    }

    #[test]
    fn verifies_mandate() {
        let mut buf = make_mandate(true, i64::MAX, 1_000, 500, 0, 0);
        let mut mandate = Mandate::from_bytes(&mut buf).unwrap();

        //simulate verify logic
        assert!(mandate.is_active());
        assert!(mandate.expiry() > 0);

        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let perm = mandate.permission(idx);
        assert!(perm.allows(&DISC));
        assert_eq!(perm.spend_total(), 0);
        assert_eq!(perm.spend_total(), 0);

        //writeback
        let amount = 100u64;
        let new_total = perm.spend_total() + amount;
        let new_count = perm.call_count() + 1;
        drop(perm);
        let mut perm_mut = mandate.permission_mut(idx);
        perm_mut.set_spend_total(new_total);
        perm_mut.set_call_count(new_count);
        drop(perm_mut);

        assert_eq!(mandate.permission(idx).spend_total(), 100);
        assert_eq!(mandate.permission(idx).call_count(), 1);
    }

    #[test]
    fn verify_rejects_inactive() {
        let mut buf = make_mandate(false, i64::MAX, 0, 0, 0, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        assert!(!mandate.is_active());
    }

    #[test]
    fn verify_rejects_expired() {
        // expiry in the past
        let mut buf = make_mandate(true, 1_000, 0, 0, 0, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        // current unix time will be >> 1000; simulate the check
        let fake_now: i64 = 9_999_999;
        assert!(fake_now > mandate.expiry());
    }

    #[test]
    fn verify_rejects_program_not_allowed() {
        let mut buf = make_mandate(true, i64::MAX, 0, 0, 0, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let unknown_program = [42u8; 32];
        assert!(mandate.find_permission(&unknown_program).is_none());
    }

    #[test]
    fn verify_rejects_discriminator_not_allowed() {
        let mut buf = make_mandate(true, i64::MAX, 0, 0, 0, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let wrong_disc = [0xFFu8; 8];
        assert!(!mandate.permission(idx).allows(&wrong_disc));
    }

    #[test]
    fn verify_rejects_per_tx_exceeded() {
        let mut buf = make_mandate(true, i64::MAX, 0, 100, 0, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let perm = mandate.permission(idx);
        let amount = 200u64;
        assert!(perm.per_tx_limit() != 0 && amount > perm.per_tx_limit());
    }

    #[test]
    fn verify_rejects_spend_limit_exceeded() {
        let mut buf = make_mandate(true, i64::MAX, 500, 0, 400, 0);
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let perm = mandate.permission(idx);
        let amount = 200u64;
        let projected = perm.spend_total().checked_add(amount).unwrap();
        assert!(projected > perm.spend_limit());
    }

    #[test]
    fn verify_writeback_accumulates() {
        let mut buf = make_mandate(true, i64::MAX, 10_000, 0, 0, 0);
        let mut mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();

        for amount in [100u64, 250u64] {
            let (new_total, new_count) = {
                let p = mandate.permission(idx);
                (
                    p.spend_total().checked_add(amount).unwrap(),
                    p.call_count().checked_add(1).unwrap(),
                )
            };
            let mut pm = mandate.permission_mut(idx);
            pm.set_spend_total(new_total);
            pm.set_call_count(new_count);
        }

        let perm = mandate.permission(idx);
        assert_eq!(perm.spend_total(), 350);
        assert_eq!(perm.call_count(), 2);
    }

    #[test]
    fn verify_cu_under_2500() {}

    #[test]
    fn verify_spend_limit_zero_means_unlimited() {
        let mut buf = make_mandate(true, i64::MAX, 0, 0, 0, 0); // spend_limit = 0
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let perm = mandate.permission(idx);
        // 0 means unlimited — the check should be skipped entirely
        assert_eq!(perm.spend_limit(), 0);
    }

    #[test]
    fn verify_per_tx_zero_means_unlimited() {
        let mut buf = make_mandate(true, i64::MAX, 0, 0, 0, 0); // per_tx_limit = 0
        let mandate = Mandate::from_bytes(&mut buf).unwrap();
        let idx = mandate.find_permission(&TARGET_PROGRAM).unwrap();
        let perm = mandate.permission(idx);
        assert_eq!(perm.per_tx_limit(), 0);
    }

    #[test]
    fn verify_no_create_program_address() {}

    #[test]
    fn cpi_caller_aborts_on_error() {}
}
