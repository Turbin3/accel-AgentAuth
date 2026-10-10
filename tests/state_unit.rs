//! Host-side unit tests of the real `agent_auth::state` code (no VM). Each test
//! names the mutant of `src/state.rs` it exists to kill.

use agent_auth::state::Mandate;
use agent_auth::*;

fn blank() -> [u8; ACCOUNT_SIZE] {
    [0u8; ACCOUNT_SIZE]
}

fn disc(n: u8) -> [u8; 8] {
    [n, 0, 0, 0, 0, 0, 0, 0]
}

fn slot_bytes(buf: &[u8], slot: usize) -> &[u8] {
    &buf[HEADER_SIZE + slot * PERMISSION_SIZE..HEADER_SIZE + (slot + 1) * PERMISSION_SIZE]
}

// --- lookup ---------------------------------------------------------------------

#[test]
fn find_permission_ignores_zeroed_slots() {
    // mutant: find_permission scans all 16 slots, so the all-zero program id
    // "matches" an empty slot and verify would treat it as allowed.
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.append_permission(&[7; 32], 0, 0, &[disc(1)]).unwrap();
    assert_eq!(m.find_permission(&[0; 32]), None);
    assert_eq!(m.find_permission(&[7; 32]), Some(0));
    assert_eq!(m.find_permission(&[8; 32]), None);
}

#[test]
fn find_permission_returns_the_matching_index_not_the_first() {
    // mutant: always return slot 0 / the last slot
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    for i in 1..=5u8 {
        m.append_permission(&[i; 32], 0, 0, &[disc(i)]).unwrap();
    }
    for i in 1..=5u8 {
        assert_eq!(m.find_permission(&[i; 32]), Some(i as usize - 1));
    }
}

#[test]
fn allows_ignores_unused_discriminator_slots() {
    // mutant: allows() scans all 8 slots, so the zero discriminator matches
    // every permission that has fewer than 8 entries.
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.append_permission(&[1; 32], 0, 0, &[disc(9)]).unwrap();
    assert!(m.permission(0).allows(&disc(9)));
    assert!(!m.permission(0).allows(&[0; 8]), "unused slots hold zeros");
    assert!(!m.permission(0).allows(&disc(10)));
}

#[test]
fn allows_checks_every_listed_discriminator_including_the_last() {
    // mutant: off-by-one in the scan (0..len-1) loses the 8th entry
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    let all: Vec<[u8; 8]> = (1..=8u8).map(disc).collect();
    m.append_permission(&[1; 32], 0, 0, &all).unwrap();
    for d in &all {
        assert!(m.permission(0).allows(d));
    }
    assert!(!m.permission(0).allows(&disc(9)));
    assert_eq!(m.permission(0).discriminators_len(), 8);
}

#[test]
fn allows_compares_all_eight_bytes() {
    // mutant: compare only a prefix
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.append_permission(&[1; 32], 0, 0, &[[1, 2, 3, 4, 5, 6, 7, 8]])
        .unwrap();
    for i in 0..8 {
        let mut d = [1, 2, 3, 4, 5, 6, 7, 8];
        d[i] ^= 0xff;
        assert!(!m.permission(0).allows(&d), "byte {i} must matter");
    }
}

// --- append ---------------------------------------------------------------------

#[test]
fn append_stores_every_field_at_its_documented_offset() {
    let mut buf = blank();
    {
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        m.append_permission(&[0xAB; 32], 11, 22, &[disc(5), disc(6)])
            .unwrap();
    }
    let s = slot_bytes(&buf, 0);
    assert_eq!(&s[P_PROGRAM_ID..P_PROGRAM_ID + 32], &[0xAB; 32]);
    assert_eq!(&s[P_SPEND_LIMIT..P_SPEND_LIMIT + 8], &11u64.to_le_bytes());
    assert_eq!(&s[P_PER_TX_LIMIT..P_PER_TX_LIMIT + 8], &22u64.to_le_bytes());
    assert_eq!(&s[P_SPEND_TOTAL..P_SPEND_TOTAL + 8], &[0; 8]);
    assert_eq!(&s[P_CALL_COUNT..P_CALL_COUNT + 4], &[0; 4]);
    assert_eq!(s[P_DISC_LEN], 2);
    assert_eq!(&s[P_DISCRIMINATORS..P_DISCRIMINATORS + 8], &disc(5));
    assert_eq!(&s[P_DISCRIMINATORS + 8..P_DISCRIMINATORS + 16], &disc(6));
    assert!(s[P_DISCRIMINATORS + 16..].iter().all(|&b| b == 0));
    assert_eq!(&buf[OFF_PERM_LEN..OFF_PERM_LEN + 2], &[1, 0]);
}

#[test]
fn append_clears_a_dirty_slot_first() {
    // mutant: append does not clear the slot, leaking old counters/discriminators
    let mut buf = blank();
    let off = HEADER_SIZE;
    buf[off..off + PERMISSION_SIZE].fill(0xEE);
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.append_permission(&[1; 32], 5, 6, &[disc(1)]).unwrap();
    let p = m.permission(0);
    assert_eq!((p.spend_total(), p.call_count()), (0, 0));
    assert_eq!(p.discriminators_len(), 1);
    assert!(!p.allows(&[0xEE; 8]));
    assert!(slot_bytes(&buf, 0)[P_DISCRIMINATORS + 8..]
        .iter()
        .all(|&b| b == 0));
}

#[test]
fn append_boundaries_8_discriminators_and_16_slots() {
    // mutants: `>` -> `>=` on either bound (a legal permission is refused) and
    // `>=` -> `>` (a 17th write runs past the account).
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    let eight: Vec<[u8; 8]> = (0..8).map(disc).collect();
    let nine: Vec<[u8; 8]> = (0..9).map(disc).collect();
    assert_eq!(
        m.append_permission(&[1; 32], 0, 0, &nine),
        Err(MandateError::TooManyDiscriminators)
    );
    assert_eq!(m.permissions_len(), 0, "a refused append writes nothing");
    assert_eq!(m.append_permission(&[1; 32], 0, 0, &eight), Ok(0));
    for i in 1..16u8 {
        assert_eq!(m.append_permission(&[i + 1; 32], 0, 0, &[]), Ok(i as usize));
    }
    assert_eq!(m.permissions_len(), 16);
    assert_eq!(
        m.append_permission(&[99; 32], 0, 0, &[]),
        Err(MandateError::PermissionsFull)
    );
    assert_eq!(m.permissions_len(), 16);
    assert_eq!(m.find_permission(&[99; 32]), None);
}

// --- swap-remove ------------------------------------------------------------------

#[test]
fn swap_remove_out_of_range_is_not_found_and_changes_nothing() {
    // mutant: bounds `>=` -> `>` (idx == len silently "removes" an empty slot)
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    for i in 0..3u8 {
        m.append_permission(&[i + 1; 32], 0, 0, &[disc(i)]).unwrap();
    }
    let before = buf;
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    for idx in [3usize, 4, 15, 16, 99, usize::MAX] {
        assert_eq!(
            m.swap_remove_permission(idx),
            Err(MandateError::PermissionNotFound),
            "idx {idx}"
        );
    }
    assert_eq!(buf[..], before[..]);
}

#[test]
fn swap_remove_first_middle_last_and_only() {
    for (n, idx) in [(1usize, 0usize), (2, 0), (2, 1), (5, 0), (5, 2), (5, 4)] {
        let mut buf = blank();
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        for i in 0..n {
            m.append_permission(&[i as u8 + 1; 32], i as u64, 0, &[disc(i as u8)])
                .unwrap();
        }
        m.swap_remove_permission(idx).unwrap();
        assert_eq!(m.permissions_len(), n - 1);

        // model: swap-remove on a Vec
        let mut model: Vec<u8> = (1..=n as u8).collect();
        model.swap_remove(idx);
        for (slot, id) in model.iter().enumerate() {
            assert_eq!(
                m.permission(slot).program_id(),
                &[*id; 32][..],
                "n={n} idx={idx}"
            );
            assert_eq!(m.permission(slot).spend_limit(), *id as u64 - 1);
        }
        assert_eq!(m.find_permission(&[idx as u8 + 1; 32]), None);
        // the vacated tail slot is fully zero, and nothing past it was touched
        assert!(slot_bytes(&buf, n - 1).iter().all(|&b| b == 0));
        assert!(buf[HEADER_SIZE + n * PERMISSION_SIZE..]
            .iter()
            .all(|&b| b == 0));
    }
}

#[test]
fn swap_remove_moves_counters_with_the_slot() {
    // mutant: copy only the key, leaving the old slot's counters behind
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    for i in 0..3u8 {
        m.append_permission(&[i + 1; 32], 100, 10, &[disc(i)])
            .unwrap();
    }
    {
        let mut p = m.permission_mut(2);
        p.set_spend_total(77);
        p.set_call_count(9);
    }
    m.swap_remove_permission(0).unwrap();
    let moved = m.permission(0);
    assert_eq!(moved.program_id(), &[3u8; 32][..]);
    assert_eq!((moved.spend_total(), moved.call_count()), (77, 9));
    assert!(moved.allows(&disc(2)));
}

// --- header ---------------------------------------------------------------------

#[test]
fn is_expired_boundary_and_extremes() {
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.set_expiry(100);
    assert!(!m.is_expired(i64::MIN));
    assert!(!m.is_expired(99));
    assert!(m.is_expired(100));
    assert!(m.is_expired(i64::MAX));
    m.set_expiry(i64::MAX);
    assert!(
        m.is_expired(i64::MAX),
        "now == expiry is expired even at MAX"
    );
    assert!(!m.is_expired(i64::MAX - 1));
}

#[test]
fn only_the_byte_one_means_active() {
    // mutant: is_active() as `!= 0`; verify treats 2 as paused
    let mut buf = blank();
    for (byte, active) in [(0u8, false), (1, true), (2, false), (255, false)] {
        buf[OFF_ACTIVE] = byte;
        assert_eq!(Mandate::from_bytes(&mut buf).unwrap().is_active(), active);
    }
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.set_active(true);
    assert_eq!(buf[OFF_ACTIVE], 1);
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.set_active(false);
    assert_eq!(buf[OFF_ACTIVE], 0);
}

#[test]
fn header_setters_hit_exactly_their_own_bytes() {
    // mutant: a setter writes the wrong width or the wrong offset
    let mut buf = blank();
    {
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        m.set_discriminator(MANDATE_DISCRIMINATOR);
        m.set_owner(&[0x11; 32]);
        m.set_agent(&[0x22; 32]);
        m.set_expiry(-2);
        m.set_active(true);
        m.set_version(CURRENT_VERSION);
        m.set_bump(0xFE);
        m.set_permissions_len(3);
    }
    let mut want = [0u8; HEADER_SIZE];
    want[OFF_DISC] = 1;
    want[OFF_OWNER..OFF_OWNER + 32].fill(0x11);
    want[OFF_AGENT..OFF_AGENT + 32].fill(0x22);
    want[OFF_EXPIRY..OFF_EXPIRY + 8].copy_from_slice(&(-2i64).to_le_bytes());
    want[OFF_ACTIVE] = 1;
    want[OFF_PERM_LEN] = 3;
    want[OFF_VERSION] = CURRENT_VERSION;
    want[OFF_BUMP] = 0xFE;
    assert_eq!(&buf[..HEADER_SIZE], &want[..]);
    assert!(buf[HEADER_SIZE..].iter().all(|&b| b == 0));
}

#[test]
fn permission_setters_hit_exactly_their_own_bytes() {
    let mut buf = blank();
    {
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        m.set_permissions_len(1);
        let mut p = m.permission_mut(0);
        p.set_program_id(&[0x33; 32]);
        p.set_spend_limit(u64::MAX);
        p.set_per_tx_limit(0x0102_0304_0506_0708);
        p.set_spend_total(0xAABB);
        p.set_call_count(u32::MAX);
        p.set_discriminators_len(2);
        p.set_discriminator(1, &disc(0x44));
    }
    let s = slot_bytes(&buf, 0);
    assert_eq!(&s[P_PROGRAM_ID..P_PROGRAM_ID + 32], &[0x33; 32]);
    assert_eq!(&s[P_SPEND_LIMIT..P_SPEND_LIMIT + 8], &[0xFF; 8]);
    assert_eq!(
        &s[P_PER_TX_LIMIT..P_PER_TX_LIMIT + 8],
        &0x0102_0304_0506_0708u64.to_le_bytes()
    );
    assert_eq!(
        &s[P_SPEND_TOTAL..P_SPEND_TOTAL + 8],
        &0xAABBu64.to_le_bytes()
    );
    assert_eq!(&s[P_CALL_COUNT..P_CALL_COUNT + 4], &[0xFF; 4]);
    assert_eq!(s[P_DISC_LEN], 2);
    assert_eq!(&s[P_DISCRIMINATORS..P_DISCRIMINATORS + 8], &[0; 8]);
    assert_eq!(&s[P_DISCRIMINATORS + 8..P_DISCRIMINATORS + 16], &disc(0x44));
    // the next slot is untouched
    assert!(slot_bytes(&buf, 1).iter().all(|&b| b == 0));
}

#[test]
fn from_bytes_requires_exact_size_and_sane_length() {
    // mutant: `!=` -> `<` on the size check, or a missing permissions_len bound
    for len in [
        0usize,
        1,
        ACCOUNT_SIZE - 1,
        ACCOUNT_SIZE + 1,
        2 * ACCOUNT_SIZE,
    ] {
        let mut v = vec![0u8; len];
        assert_eq!(
            Mandate::from_bytes(&mut v).err(),
            Some(MandateError::InvalidAccountType),
            "len {len}"
        );
    }
    for bad in [17u16, 255, 256, u16::MAX] {
        let mut buf = blank();
        buf[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&bad.to_le_bytes());
        assert_eq!(
            Mandate::from_bytes(&mut buf).err(),
            Some(MandateError::InvalidAccountType),
            "permissions_len {bad}"
        );
    }
    for ok in [0u16, 1, 16] {
        let mut buf = blank();
        buf[OFF_PERM_LEN..OFF_PERM_LEN + 2].copy_from_slice(&ok.to_le_bytes());
        assert!(Mandate::from_bytes(&mut buf).is_ok());
    }
}

#[test]
fn initialize_wipes_then_writes_only_the_header() {
    let mut buf = [0xEEu8; ACCOUNT_SIZE];
    {
        let m = Mandate::initialize(&mut buf, &[1; 32], &[2; 32], 99, 254).unwrap();
        assert!(m.is_active());
        assert_eq!(m.permissions_len(), 0);
    }
    assert_eq!(buf[OFF_DISC], MANDATE_DISCRIMINATOR);
    assert_eq!(buf[OFF_VERSION], CURRENT_VERSION);
    assert_eq!(buf[OFF_BUMP], 254);
    assert_eq!(buf[OFF_ACTIVE], 1);
    assert!(buf[74..77].iter().all(|&b| b == 0), "padding is zeroed");
    assert!(
        buf[81..].iter().all(|&b| b == 0),
        "reserved + permissions are zeroed"
    );
    assert!(Mandate::initialize(&mut [0u8; ACCOUNT_SIZE - 1], &[1; 32], &[2; 32], 1, 1).is_err());
}

#[test]
fn corrupt_discriminator_count_is_clamped_to_eight() {
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    m.append_permission(&[1; 32], 0, 0, &[disc(7)]).unwrap();
    for bad in [9u8, 64, 255] {
        m.permission_mut(0).set_discriminators_len(bad);
        assert_eq!(m.permission(0).discriminators_len(), MAX_DISCRIMINATORS);
        assert!(m.permission(0).allows(&disc(7)));
    }
}

#[test]
fn layout_constants_are_self_consistent() {
    assert_eq!(
        HEADER_SIZE + MAX_PERMISSIONS * PERMISSION_SIZE,
        ACCOUNT_SIZE
    );
    assert_eq!(ACCOUNT_SIZE, 2136);
    assert_eq!(P_DISCRIMINATORS + MAX_DISCRIMINATORS * 8, PERMISSION_SIZE);
    assert_eq!(OFF_OWNER + 32, OFF_AGENT);
    assert_eq!(OFF_AGENT + 32, OFF_EXPIRY);
    assert_eq!(OFF_EXPIRY + 8, OFF_ACTIVE);
    assert_eq!(OFF_PERM_LEN + 2, OFF_VERSION);
    assert_eq!(OFF_VERSION + 1, OFF_BUMP);
    assert_eq!(P_PROGRAM_ID + 32, P_SPEND_LIMIT);
    assert_eq!(P_SPEND_LIMIT + 8, P_PER_TX_LIMIT);
    assert_eq!(P_PER_TX_LIMIT + 8, P_SPEND_TOTAL);
    assert_eq!(P_SPEND_TOTAL + 8, P_CALL_COUNT);
    assert_eq!(P_CALL_COUNT + 4, P_DISC_LEN);
    assert_eq!(MANDATE_SEED, b"mandate");
    assert_eq!(MANDATE_DISCRIMINATOR, 1);
}

#[test]
fn find_permission_compares_every_byte_of_the_key() {
    // mutant: key compared on a prefix (31 bytes) or a single byte
    let mut buf = blank();
    let mut m = Mandate::from_bytes(&mut buf).unwrap();
    let base = [0x5Au8; 32];
    m.append_permission(&base, 0, 0, &[disc(1)]).unwrap();
    for i in 0..32 {
        let mut other = base;
        other[i] ^= 1;
        assert_eq!(m.find_permission(&other), None, "byte {i} must matter");
    }
    assert_eq!(m.find_permission(&base), Some(0));
}
