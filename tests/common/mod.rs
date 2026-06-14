//! Shared helpers for building mandate account bytes in tests.

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
