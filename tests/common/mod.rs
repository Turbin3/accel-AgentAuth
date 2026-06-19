//! Shared helpers for building mandate account bytes in tests.

pub mod integration;
//
// Imported by everyone via `mod common;`: `MandateFixture` builds a valid
// 2136-byte account in memory, and `golden_fixture` / `assert_matches_golden`
/// guard the byte layout against silent drift between people.

use agent_auth::state::Mandate;
use agent_auth::{ACCOUNT_SIZE, MANDATE_DISCRIMINATOR};

pub struct PermissionSpec {
    pub program_id: [u8; 32],
    pub spend_limit: u64,
    pub per_tx_limit: u64,
    pub discriminators: Vec<[u8; 8]>,
}

pub struct MandateFixture {
    pub owner: [u8; 32],
    pub agent: [u8; 32],
    pub expiry: i64,
    pub permissions: Vec<PermissionSpec>,
}

impl MandateFixture {
    /// Serialize into the exact 2136-byte on-chain layout.
    pub fn to_bytes(&self) -> [u8; ACCOUNT_SIZE] {
        let mut buf = [0u8; ACCOUNT_SIZE];
        let mut m = Mandate::from_bytes(&mut buf).unwrap();

        m.set_discriminator(MANDATE_DISCRIMINATOR);
        m.set_owner(&self.owner);
        m.set_agent(&self.agent);
        m.set_expiry(self.expiry);
        m.set_active(true);

        for p in &self.permissions {
            m.append_permission(&p.program_id, p.spend_limit, p.per_tx_limit, &p.discriminators)
                .unwrap();
        }

        buf
    }
}

/// The canonical fixture baked into `fixtures/golden_mandate.bin`. Build from
/// this in a test and feed the bytes to `assert_matches_golden` to prove the
/// layout still serializes identically.
pub fn golden_fixture() -> MandateFixture {
    MandateFixture {
        owner: [1u8; 32],
        agent: [2u8; 32],
        expiry: 1_900_000_000,
        permissions: vec![
            PermissionSpec {
                program_id: [0xAA; 32],
                spend_limit: 1_000_000,
                per_tx_limit: 50_000,
                discriminators: vec![[1, 2, 3, 4, 5, 6, 7, 8]],
            },
            PermissionSpec {
                program_id: [0xBB; 32],
                spend_limit: 9,
                per_tx_limit: 9,
                discriminators: vec![],
            },
        ],
    }
}

/// Assert `bytes` matches the committed golden blob exactly, reporting the first
/// offset that differs. A mismatch means someone changed the on-chain layout.
pub fn assert_matches_golden(bytes: &[u8]) {
    let want: &[u8] = include_bytes!("../../fixtures/golden_mandate.bin");
    assert_eq!(
        bytes.len(),
        want.len(),
        "length drift: got {} bytes, golden is {}",
        bytes.len(),
        want.len()
    );
    if let Some(i) = (0..want.len()).find(|&i| bytes[i] != want[i]) {
        panic!(
            "layout drift at byte {i}: got 0x{:02x}, golden has 0x{:02x}",
            bytes[i], want[i]
        );
    }
}
