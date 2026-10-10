//! Shared LiteSVM test harness for the AgentAuth relay. See `README.md` in this directory.
//!
//! Use from an integration test file:
//!
//! ```ignore
//! #[macro_use]
//! mod common;
//! use common::*;
//! ```

#![allow(dead_code, unused_imports, unused_macros)]

#[macro_use]
pub mod macros;

pub mod aa;
pub mod amm;
pub mod assert;
pub mod ctx;
pub mod ids;
pub mod policy;
pub mod relay_ix;
pub mod svm;
pub mod token;

pub use amm::{mode as amm_mode, PoolState};
pub use assert::{
    assert_aa_err, assert_err, assert_failed, assert_instruction_error, assert_not_enough_accounts,
    assert_nothing_moved, assert_ok, assert_relay_err, assert_token_err, audit_relay_cpis, cu,
    decode_event, failing_program, parse_failures, program_data, relay_events, tx_wire_size, Exec,
    InnerCall, RelayEvent, Snapshot,
};
pub use ctx::{
    build_tx, compute_unit_limit_ix, send_keys, send_tx, system_transfer_ix, Ctx, CtxBuilder,
    PoolFixture, Principal, SwapFixture, SwapOpts, Who,
};
pub use ids::*;
pub use macros::for_flavors;
pub use policy::{
    header_alias_rows, invalid_config_rows, required_min_out, InvalidRow, PolicyCfg, PolicyHeader,
    PolicyView, SwapPins, FLAG_PAUSED, FLAG_STRICT_TOP_LEVEL,
};
pub use relay_ix::{
    init_idx, swap_idx, transfer_idx, InitPolicyIx, IxExt, SwapIx, TransferIx, SWAP_PIN_TABLE,
};
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_pubkey::Pubkey;
pub use solana_signer::Signer;
pub use svm::{new_svm, Flavor, RelayBuild, SvmExt};
pub use token::{Ext, MintAcct, MintView, TokenAcct, TokenView};
