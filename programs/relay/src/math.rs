//! Floor-price arithmetic for `swap` (RELAY-SPEC 7.5 step 16).

use crate::error::RelayError;

/// Quotient and remainder of `num / den` by restoring (shift-subtract)
/// division, `den != 0`.
///
/// `u128 / u128` would pull the compiler-builtins routine into the program
/// (about 5 KB of the `.so`); this loop uses only shifts, compares and
/// subtractions, which lower to inline 64-bit instructions. The loop runs
/// only when the product does not fit in `u64` (see [`required_min_out`]).
fn div_rem(num: u128, den: u128) -> (u128, u128) {
    let mut q = 0u128;
    let mut r = 0u128;
    let mut i = 128u32;
    while i > 0 {
        i = i.saturating_sub(1);
        // r < den <= 2^64 - 1 here, so shifting left by one cannot overflow.
        r = (r << 1) | ((num >> i) & 1);
        q <<= 1;
        if r >= den {
            r = r.saturating_sub(den);
            q |= 1;
        }
    }
    (q, r)
}

/// `ceil(amount_in * floor_out / floor_in)` computed in `u128`.
///
/// `amount_in * floor_out` is at most `(2^64-1)^2 < 2^128`, so the product
/// cannot overflow. The only failures are a zero denominator and a result
/// that does not fit in `u64`; both are `ArithmeticOverflow` (114).
///
/// When the product fits in 64 bits (every realistic swap) the native 64-bit
/// divide is used; otherwise a shift-subtract division.
pub fn required_min_out(amount_in: u64, floor_out: u64, floor_in: u64) -> Result<u64, RelayError> {
    if floor_in == 0 {
        return Err(RelayError::ArithmeticOverflow);
    }
    let num = u128::from(amount_in)
        .checked_mul(u128::from(floor_out))
        .ok_or(RelayError::ArithmeticOverflow)?;
    let (q, r) = match u64::try_from(num) {
        Ok(small) => (
            u128::from(small.checked_div(floor_in).unwrap_or(0)),
            u128::from(small.checked_rem(floor_in).unwrap_or(0)),
        ),
        Err(_) => div_rem(num, u128::from(floor_in)),
    };
    let ceil = if r == 0 {
        q
    } else {
        q.checked_add(1).ok_or(RelayError::ArithmeticOverflow)?
    };
    u64::try_from(ceil).map_err(|_| RelayError::ArithmeticOverflow)
}

/// The effective minimum output: `max(agent_min_out, required_min_out)`.
pub fn effective_min_out(
    amount_in: u64,
    min_out: u64,
    floor_out: u64,
    floor_in: u64,
) -> Result<u64, RelayError> {
    Ok(min_out.max(required_min_out(amount_in, floor_out, floor_in)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_floor_vector() {
        // golden/policy_example.json: floor 95/100, 5_000_000 in -> 4_750_000.
        assert_eq!(required_min_out(5_000_000, 95, 100), Ok(4_750_000));
    }

    #[test]
    fn rounds_up() {
        assert_eq!(required_min_out(1, 1, 2), Ok(1));
        assert_eq!(required_min_out(3, 1, 2), Ok(2));
        assert_eq!(required_min_out(4, 1, 2), Ok(2));
        assert_eq!(required_min_out(0, 5, 3), Ok(0));
    }

    #[test]
    fn boundaries() {
        assert_eq!(required_min_out(u64::MAX, 1, 1), Ok(u64::MAX));
        assert_eq!(required_min_out(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
        assert_eq!(
            required_min_out(u64::MAX, 2, 1),
            Err(RelayError::ArithmeticOverflow)
        );
        assert_eq!(
            required_min_out(u64::MAX, u64::MAX, 1),
            Err(RelayError::ArithmeticOverflow)
        );
        // Result exactly 2^64 overflows; 2^64 - 1 does not.
        assert_eq!(
            required_min_out(1 << 63, 2, 1),
            Err(RelayError::ArithmeticOverflow)
        );
        assert_eq!(required_min_out((1 << 63) - 1, 2, 1), Ok(u64::MAX - 1));
        assert_eq!(
            required_min_out(1, 1, 0),
            Err(RelayError::ArithmeticOverflow)
        );
    }

    /// SW-12: agent `min_out` can raise but never lower the floor.
    #[test]
    fn effective_min_is_max() {
        assert_eq!(effective_min_out(100, 0, 95, 100), Ok(95));
        assert_eq!(effective_min_out(100, 96, 95, 100), Ok(96));
        assert_eq!(effective_min_out(100, 95, 95, 100), Ok(95));
    }

    #[test]
    fn div_rem_matches_native_u128() {
        let mut s = 0x1234_5678_9ABC_DEF0u64;
        let mut next = || {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            s.wrapping_mul(0x2545_F491_4F6C_DD1D)
        };
        for _ in 0..20_000 {
            let num = (u128::from(next()) << 64) | u128::from(next());
            let num = num >> (next() % 128);
            let den = (u128::from(next()) >> (next() % 64)).max(1);
            assert_eq!(div_rem(num, den), (num / den, num % den));
        }
        assert_eq!(div_rem(0, 1), (0, 0));
        assert_eq!(div_rem(u128::MAX, 1), (u128::MAX, 0));
        let m = u128::from(u64::MAX);
        assert_eq!(div_rem(m * m, m), (m, 0));
    }

    /// Property check against an independent definition of the ceiling:
    /// `r = required_min_out` is the least value with `r * den >= num`.
    #[test]
    fn matches_reference_definition() {
        // xorshift64*, deterministic.
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            s.wrapping_mul(0x2545_F491_4F6C_DD1D)
        };
        let specials = [0u64, 1, 2, 3, 99, 100, u64::MAX, u64::MAX - 1, 1 << 63];
        for i in 0..20_000u32 {
            let pick = |x: u64, r: u64| -> u64 {
                match r % 4 {
                    0 => specials[(x as usize) % specials.len()],
                    1 => x % 1_000,
                    2 => x % 1_000_000_007,
                    _ => x,
                }
            };
            let a = pick(next(), next());
            let fo = pick(next(), next());
            let fi = pick(next(), next()).max(1);
            let num = u128::from(a) * u128::from(fo);
            match required_min_out(a, fo, fi) {
                Ok(r) => {
                    let r = u128::from(r);
                    let den = u128::from(fi);
                    // r*den >= num and (r-1)*den < num; checked in u128 where
                    // it fits, falling back to division-based comparison.
                    assert!(r.checked_mul(den).is_none_or(|v| v >= num), "case {i}");
                    if r > 0 {
                        assert!(
                            (r - 1).checked_mul(den).is_some_and(|v| v < num),
                            "case {i}"
                        );
                    }
                }
                Err(e) => {
                    assert_eq!(e, RelayError::ArithmeticOverflow);
                    assert!(
                        num.div_ceil(u128::from(fi)) > u128::from(u64::MAX),
                        "case {i}"
                    );
                }
            }
        }
    }
}
