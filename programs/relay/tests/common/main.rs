//! Harness self-tests: `cargo test -p agent-auth-relay --test common`.
//!
//! This file is a test target of its own (cargo auto-discovers `tests/common/main.rs`), while
//! other test files include the harness with `mod common;` (which resolves to `mod.rs`).

#[macro_use]
#[path = "mod.rs"]
mod harness;

use harness::*;

mod st_amm;
mod st_ctx;
mod st_golden;
mod st_tokens;
