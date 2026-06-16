//! Pins the on-chain byte layout. If any offset here changes, the verify CPI
//! and any off-chain client that reads the account break silently — so we
//! check the bytes against a committed golden file as well as the spec offsets.

mod common;

use common::{assert_matches_golden, golden_fixture};

use agent_auth::{
    HEADER_SIZE, OFF_ACTIVE, OFF_AGENT, OFF_DISC, OFF_EXPIRY, OFF_OWNER, OFF_PERM_LEN,
    PERMISSION_SIZE, P_PER_TX_LIMIT, P_PROGRAM_ID, P_SPEND_LIMIT,
};

#[test]
fn offsets_match_spec() {
    let bytes = golden_fixture().to_bytes();

    // header
    assert_eq!(bytes[OFF_DISC], 1);
    assert_eq!(&bytes[OFF_OWNER..OFF_OWNER + 32], &[1u8; 32]);
    assert_eq!(&bytes[OFF_AGENT..OFF_AGENT + 32], &[2u8; 32]);
    assert_eq!(
        i64::from_le_bytes(bytes[OFF_EXPIRY..OFF_EXPIRY + 8].try_into().unwrap()),
        1_900_000_000
    );
    assert_eq!(bytes[OFF_ACTIVE], 1);
    assert_eq!(
        u16::from_le_bytes(bytes[OFF_PERM_LEN..OFF_PERM_LEN + 2].try_into().unwrap()),
        2
    );

    // permission 0 sits right after the header
    let p0 = HEADER_SIZE;
    assert_eq!(&bytes[p0 + P_PROGRAM_ID..p0 + P_PROGRAM_ID + 32], &[0xAAu8; 32]);
    assert_eq!(
        u64::from_le_bytes(bytes[p0 + P_SPEND_LIMIT..p0 + P_SPEND_LIMIT + 8].try_into().unwrap()),
        1_000_000
    );
    assert_eq!(
        u64::from_le_bytes(bytes[p0 + P_PER_TX_LIMIT..p0 + P_PER_TX_LIMIT + 8].try_into().unwrap()),
        50_000
    );

    // permission 1 is exactly one stride later
    let p1 = HEADER_SIZE + PERMISSION_SIZE;
    assert_eq!(&bytes[p1 + P_PROGRAM_ID..p1 + P_PROGRAM_ID + 32], &[0xBBu8; 32]);

    // and it matches the committed golden blob byte-for-byte
    assert_matches_golden(&bytes);
}

/// Regenerate fixtures/golden_mandate.bin. Run by hand when the layout changes:
///   cargo test write_golden -- --ignored
#[test]
#[ignore]
fn write_golden() {
    let bytes = golden_fixture().to_bytes();
    std::fs::write("fixtures/golden_mandate.bin", bytes).unwrap();
}
