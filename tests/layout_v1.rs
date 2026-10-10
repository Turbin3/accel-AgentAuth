//! Pins the bytes a v1 mandate (version 1, stored bump) occupies, including the
//! counters that `golden_mandate.bin` leaves at zero. The original golden file
//! stays untouched: the v1 header only uses bytes it declared reserved.
//!
//! Regenerate (only for an intentional layout change) with
//!   cargo test --test layout_v1 write_golden_v1 -- --ignored

use agent_auth::state::Mandate;
use agent_auth::*;

const GOLDEN: &[u8] = include_bytes!("../fixtures/golden_mandate_v1.bin");

fn build() -> [u8; ACCOUNT_SIZE] {
    let mut buf = [0u8; ACCOUNT_SIZE];
    let mut m = Mandate::initialize(&mut buf, &[1u8; 32], &[2u8; 32], 1_900_000_000, 254).unwrap();
    let a = m
        .append_permission(
            &[0xAA; 32],
            1_000_000,
            50_000,
            &[[1, 2, 3, 4, 5, 6, 7, 8], [9, 9, 9, 9, 9, 9, 9, 9]],
        )
        .unwrap();
    let mut p = m.permission_mut(a);
    p.set_spend_total(123_456);
    p.set_call_count(77);
    m.append_permission(&[0xBB; 32], 0, 0, &[[0xFF; 8]])
        .unwrap();
    buf
}

#[test]
fn v1_header_offsets() {
    assert_eq!(OFF_VERSION, 79);
    assert_eq!(OFF_BUMP, 80);
    assert_eq!(CURRENT_VERSION, 1);
    let b = build();
    assert_eq!(b[OFF_DISC], 1);
    assert_eq!(b[OFF_VERSION], 1);
    assert_eq!(b[OFF_BUMP], 254);
    assert_eq!(b[OFF_ACTIVE], 1);
    assert_eq!(&b[OFF_PERM_LEN..OFF_PERM_LEN + 2], &[2, 0]);
    // padding stays zero
    assert!(b[74..77].iter().all(|&x| x == 0));
    assert!(b[81..HEADER_SIZE].iter().all(|&x| x == 0));
}

#[test]
fn v1_counters_sit_at_their_offsets() {
    let b = build();
    let p0 = HEADER_SIZE;
    assert_eq!(
        u64::from_le_bytes(
            b[p0 + P_SPEND_TOTAL..p0 + P_SPEND_TOTAL + 8]
                .try_into()
                .unwrap()
        ),
        123_456
    );
    assert_eq!(
        u32::from_le_bytes(
            b[p0 + P_CALL_COUNT..p0 + P_CALL_COUNT + 4]
                .try_into()
                .unwrap()
        ),
        77
    );
    assert_eq!(b[p0 + P_DISC_LEN], 2);
    assert_eq!(
        &b[p0 + P_DISCRIMINATORS..p0 + P_DISCRIMINATORS + 8],
        &[1, 2, 3, 4, 5, 6, 7, 8]
    );
}

#[test]
fn v1_bytes_match_golden() {
    let got = build();
    assert_eq!(got.len(), GOLDEN.len());
    if let Some(i) = (0..got.len()).find(|&i| got[i] != GOLDEN[i]) {
        panic!(
            "v1 layout drift at byte {i}: got 0x{:02x}, golden 0x{:02x}",
            got[i], GOLDEN[i]
        );
    }
}

#[test]
#[ignore]
fn write_golden_v1() {
    std::fs::write("fixtures/golden_mandate_v1.bin", build()).unwrap();
}
