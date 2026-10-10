//! Events (RELAY-SPEC 7.6): one `sol_log_data` call per successful action. The
//! SDK and dashboard decode `Program data:` log lines using the layouts in
//! `idl/relay-idl.json` `events`.
//!
//! `pinocchio::log::sol_log_data` wraps the syscall, so this crate needs no
//! `unsafe` of its own for logging.

use pinocchio::{log::sol_log_data, pubkey::Pubkey};

/// Event tag of `TransferExecuted`.
pub const EV_TRANSFER: u8 = 1;
/// Event tag of `SwapExecuted`.
pub const EV_SWAP: u8 = 2;
/// Event tag of `PolicyInitialized`.
pub const EV_POLICY_INITIALIZED: u8 = 3;
/// Event tag of `PolicyClosed`.
pub const EV_POLICY_CLOSED: u8 = 4;
/// Event tag of `PausedChanged`.
pub const EV_PAUSED_CHANGED: u8 = 5;

/// Size of `TransferExecuted`.
pub const TRANSFER_EVENT_LEN: usize = 105;
/// Size of `SwapExecuted`.
pub const SWAP_EVENT_LEN: usize = 89;

/// Bytes of `TransferExecuted`: tag, mandate, destination, mint, amount.
pub fn transfer_event(
    mandate: &Pubkey,
    destination: &Pubkey,
    mint: &Pubkey,
    amount: u64,
) -> [u8; TRANSFER_EVENT_LEN] {
    let mut b = [0u8; TRANSFER_EVENT_LEN];
    b[0] = EV_TRANSFER;
    b[1..33].copy_from_slice(mandate);
    b[33..65].copy_from_slice(destination);
    b[65..97].copy_from_slice(mint);
    b[97..105].copy_from_slice(&amount.to_le_bytes());
    b
}

/// Bytes of `SwapExecuted`: tag, mandate, pool, amount_in requested, in_delta, out_delta.
pub fn swap_event(
    mandate: &Pubkey,
    pool_state: &Pubkey,
    amount_in: u64,
    in_delta: u64,
    out_delta: u64,
) -> [u8; SWAP_EVENT_LEN] {
    let mut b = [0u8; SWAP_EVENT_LEN];
    b[0] = EV_SWAP;
    b[1..33].copy_from_slice(mandate);
    b[33..65].copy_from_slice(pool_state);
    b[65..73].copy_from_slice(&amount_in.to_le_bytes());
    b[73..81].copy_from_slice(&in_delta.to_le_bytes());
    b[81..89].copy_from_slice(&out_delta.to_le_bytes());
    b
}

/// Emit `TransferExecuted`.
pub fn emit_transfer(mandate: &Pubkey, destination: &Pubkey, mint: &Pubkey, amount: u64) {
    sol_log_data(&[&transfer_event(mandate, destination, mint, amount)]);
}

/// Emit `SwapExecuted`.
pub fn emit_swap(
    mandate: &Pubkey,
    pool_state: &Pubkey,
    amount_in: u64,
    in_delta: u64,
    out_delta: u64,
) {
    sol_log_data(&[&swap_event(
        mandate, pool_state, amount_in, in_delta, out_delta,
    )]);
}

/// Emit `PolicyInitialized`.
pub fn emit_policy_initialized(mandate: &Pubkey, policy: &Pubkey, flags: u8) {
    let mut b = [0u8; 66];
    b[0] = EV_POLICY_INITIALIZED;
    b[1..33].copy_from_slice(mandate);
    b[33..65].copy_from_slice(policy);
    b[65] = flags;
    sol_log_data(&[&b]);
}

/// Emit `PolicyClosed`.
pub fn emit_policy_closed(mandate: &Pubkey, policy: &Pubkey) {
    let mut b = [0u8; 65];
    b[0] = EV_POLICY_CLOSED;
    b[1..33].copy_from_slice(mandate);
    b[33..65].copy_from_slice(policy);
    sol_log_data(&[&b]);
}

/// Emit `PausedChanged`.
pub fn emit_paused_changed(mandate: &Pubkey, paused: bool) {
    let mut b = [0u8; 34];
    b[0] = EV_PAUSED_CHANGED;
    b[1..33].copy_from_slice(mandate);
    b[33] = u8::from(paused);
    sol_log_data(&[&b]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_event_layout() {
        let e = transfer_event(&[1; 32], &[2; 32], &[3; 32], 0x0102);
        assert_eq!(e.len(), 105);
        assert_eq!(e[0], 1);
        assert_eq!(&e[1..33], &[1; 32]);
        assert_eq!(&e[33..65], &[2; 32]);
        assert_eq!(&e[65..97], &[3; 32]);
        assert_eq!(&e[97..105], &0x0102u64.to_le_bytes());
    }

    #[test]
    fn swap_event_layout() {
        let e = swap_event(&[1; 32], &[2; 32], 5, 6, 7);
        assert_eq!(e.len(), 89);
        assert_eq!(e[0], 2);
        assert_eq!(&e[65..73], &5u64.to_le_bytes());
        assert_eq!(&e[73..81], &6u64.to_le_bytes());
        assert_eq!(&e[81..89], &7u64.to_le_bytes());
    }
}
