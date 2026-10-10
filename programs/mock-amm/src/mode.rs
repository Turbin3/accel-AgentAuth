//! Behaviour modes, selected by byte 0 of `pool_state` data.

/// What the mock does when `swap_base_input` is called on a pool. `Normal` is an honest
/// constant-product AMM; every other mode is a deliberately hostile or buggy variant used to
/// prove that the caller's own checks catch it.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Honest swap.
    Normal = 0,
    /// Normal output, but pulls `amount_in + 1` from `in_account`.
    PullExtra = 1,
    /// Normal swap, then Token `Burn` of 1 unit from `in_account` signed by `payer`.
    BurnIn = 2,
    /// Normal swap, then Token `Approve` (u64::MAX) on `in_account` to the attacker account.
    ApproveAttacker = 3,
    /// Normal swap, then Token `SetAuthority(AccountOwner)` on `in_account` to `aux_key`.
    SetAuth = 4,
    /// Normal swap, then Token `CloseAccount` on `in_account`.
    CloseAccount = 5,
    /// Normal pull, but the output is paid into `in_account` instead of `out_account`.
    RedirectOutput = 6,
    /// Normal swap, then a CPI back into the relay program.
    ReenterRelay = 7,
    /// Normal swap, then a CPI to AgentAuth `verify` using `aux_key` as the mandate.
    CpiVerify = 8,
    /// Returns Ok and moves nothing.
    NoopOk = 9,
    /// Pulls `amount_in`, pays `minimum_amount_out - 1` (saturating).
    Underpay = 10,
    /// Pulls `amount_in / 2`, pays the constant-product output for that smaller input.
    PullLess = 11,
    /// Spins until the compute budget is exhausted.
    BurnCpu = 12,
}

/// Number of defined modes.
pub const MODE_COUNT: u8 = 13;

impl Mode {
    /// Parse the mode byte; `None` for anything above 12.
    pub const fn from_u8(b: u8) -> Option<Mode> {
        Some(match b {
            0 => Mode::Normal,
            1 => Mode::PullExtra,
            2 => Mode::BurnIn,
            3 => Mode::ApproveAttacker,
            4 => Mode::SetAuth,
            5 => Mode::CloseAccount,
            6 => Mode::RedirectOutput,
            7 => Mode::ReenterRelay,
            8 => Mode::CpiVerify,
            9 => Mode::NoopOk,
            10 => Mode::Underpay,
            11 => Mode::PullLess,
            12 => Mode::BurnCpu,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_defined_byte_round_trips() {
        for b in 0..MODE_COUNT {
            let m = Mode::from_u8(b).expect("defined mode");
            assert_eq!(m as u8, b);
        }
    }

    #[test]
    fn undefined_bytes_are_rejected() {
        for b in MODE_COUNT..=u8::MAX {
            assert_eq!(Mode::from_u8(b), None);
        }
    }

    #[test]
    fn names_match_numbers() {
        assert_eq!(Mode::Normal as u8, 0);
        assert_eq!(Mode::PullExtra as u8, 1);
        assert_eq!(Mode::BurnIn as u8, 2);
        assert_eq!(Mode::ApproveAttacker as u8, 3);
        assert_eq!(Mode::SetAuth as u8, 4);
        assert_eq!(Mode::CloseAccount as u8, 5);
        assert_eq!(Mode::RedirectOutput as u8, 6);
        assert_eq!(Mode::ReenterRelay as u8, 7);
        assert_eq!(Mode::CpiVerify as u8, 8);
        assert_eq!(Mode::NoopOk as u8, 9);
        assert_eq!(Mode::Underpay as u8, 10);
        assert_eq!(Mode::PullLess as u8, 11);
        assert_eq!(Mode::BurnCpu as u8, 12);
    }
}
