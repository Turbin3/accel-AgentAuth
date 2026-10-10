//! Constant-product math (no fees, no rounding in the trader's favour).

/// `floor(amount_in * out_reserve / (in_reserve + amount_in))`, computed in u128.
///
/// Returns `None` only when the denominator is zero (empty pool and zero input) or the
/// result does not fit in u64 (impossible for `out_reserve <= u64::MAX`, kept as a guard).
pub fn amount_out(in_reserve: u64, out_reserve: u64, amount_in: u64) -> Option<u64> {
    let denominator = (in_reserve as u128).checked_add(amount_in as u128)?;
    if denominator == 0 {
        return None;
    }
    let numerator = (amount_in as u128).checked_mul(out_reserve as u128)?;
    u64::try_from(numerator / denominator).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symmetric_pool_pays_slightly_under_input() {
        // 1_000_000 * 1e9 / (1e9 + 1e6) = 999_000.999.. -> 999_000
        assert_eq!(
            amount_out(1_000_000_000, 1_000_000_000, 1_000_000),
            Some(999_000)
        );
    }

    #[test]
    fn rounds_down() {
        assert_eq!(amount_out(3, 10, 1), Some(2)); // 10/4 = 2.5
        assert_eq!(amount_out(1, 1, 1), Some(0)); // 1/2
    }

    #[test]
    fn zero_input_pays_zero() {
        assert_eq!(amount_out(100, 100, 0), Some(0));
    }

    #[test]
    fn empty_pool_zero_input_is_none() {
        assert_eq!(amount_out(0, 100, 0), None);
    }

    #[test]
    fn empty_input_reserve_pays_whole_output_reserve() {
        assert_eq!(amount_out(0, 77, 5), Some(77));
    }

    #[test]
    fn never_exceeds_output_reserve() {
        assert_eq!(amount_out(1, 1_000, u64::MAX), Some(999));
        assert_eq!(amount_out(1, u64::MAX, u64::MAX), Some(u64::MAX - 1));
    }

    #[test]
    fn no_overflow_at_u64_max() {
        let out = amount_out(u64::MAX, u64::MAX, u64::MAX).unwrap();
        assert_eq!(out, u64::MAX / 2);
    }

    #[test]
    fn constant_product_does_not_decrease() {
        for (r_in, r_out, a) in [(1_000u64, 2_000u64, 10u64), (7, 13, 5), (1_000_000, 3, 999)] {
            let out = amount_out(r_in, r_out, a).unwrap();
            let before = (r_in as u128) * (r_out as u128);
            let after = (r_in as u128 + a as u128) * (r_out as u128 - out as u128);
            assert!(after >= before);
        }
    }
}
