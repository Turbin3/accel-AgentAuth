// Mandate account layout. Sizes and byte offsets live here so the rest of the
// program (and the tests) never hard-code a magic number.
//
//   header        88 bytes
//   permissions   16 * 128 = 2048 bytes
//   total         2136 bytes
//
// header:
//   0   discriminator   u8   (== 1 once initialised)
//   1   owner           [u8; 32]
//   33  agent           [u8; 32]
//   65  expiry          i64
//   73  active          u8
//   77  permissions_len u16
//   79  version         u8   (== CURRENT_VERSION, written by create_mandate)
//   80  bump            u8   (PDA bump, written by create_mandate)
//   (74..77 and 81..88 are padding / reserved, always zero)
//
// Accounts created by the v0.1 binary have version == 0 and bump == 0 (the
// bytes were reserved padding): handlers treat version 0 as "no stored bump".
pub const ACCOUNT_SIZE: usize = 2136;
pub const HEADER_SIZE: usize = 88;
pub const PERMISSION_SIZE: usize = 128;

pub const MAX_PERMISSIONS: usize = 16;
pub const MAX_DISCRIMINATORS: usize = 8;

// value of the discriminator byte for an initialised mandate
pub const MANDATE_DISCRIMINATOR: u8 = 1;
pub const MANDATE_SEED: &[u8] = b"mandate";

// header field offsets
pub const OFF_DISC: usize = 0;
pub const OFF_OWNER: usize = 1;
pub const OFF_AGENT: usize = 33;
pub const OFF_EXPIRY: usize = 65;
pub const OFF_ACTIVE: usize = 73;
pub const OFF_PERM_LEN: usize = 77;
pub const OFF_VERSION: usize = 79;
pub const OFF_BUMP: usize = 80;

// value written to OFF_VERSION by this release
pub const CURRENT_VERSION: u8 = 1;

// permission field offsets, relative to the slot base (HEADER_SIZE + i * PERMISSION_SIZE)
pub const P_PROGRAM_ID: usize = 0;
pub const P_SPEND_LIMIT: usize = 32;
pub const P_PER_TX_LIMIT: usize = 40;
pub const P_SPEND_TOTAL: usize = 48;
pub const P_CALL_COUNT: usize = 56;
pub const P_DISC_LEN: usize = 60;
pub const P_DISCRIMINATORS: usize = 64;
