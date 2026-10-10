import { U64_MAX } from './bytes'
import { ValidationError } from './sdk-errors'

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ValidationError('BAD_DECIMALS', 'decimals must be an integer in [0, 255]')
  }
}

const DECIMAL_RE = /^([0-9]+)(?:\.([0-9]+))?$/

/**
 * Parse a human decimal string (`"12.5"`) into base units, with no floating point anywhere.
 *
 * Strict: digits with an optional single `.fraction`; no sign, exponent, whitespace, separators,
 * `NaN`/`Infinity`, empty integer or fraction part (`".5"`, `"5."`), and no more fraction digits than
 * `decimals`. The result must fit a u64.
 *
 * @example
 * parseUnits('1.5', 6) // 1_500_000n
 * @throws ValidationError `BAD_UNITS | BAD_DECIMALS | U64_RANGE`
 */
export function parseUnits(human: string, decimals: number): bigint {
  checkDecimals(decimals)
  if (typeof human !== 'string') {
    throw new ValidationError('BAD_UNITS', 'amount must be a decimal string')
  }
  // A u64 has at most 20 digits; fraction digits are capped by `decimals` (<= 255). Reject longer
  // inputs before the regex and BigInt conversion so a hostile megabyte string costs nothing.
  if (human.length > 20 + 1 + decimals) {
    throw new ValidationError(
      'BAD_UNITS',
      `amount string is too long (${human.length} characters) for a u64 with ${decimals} decimals`,
    )
  }
  const m = DECIMAL_RE.exec(human)
  if (!m) {
    throw new ValidationError(
      'BAD_UNITS',
      `not a plain non-negative decimal: ${JSON.stringify(human.slice(0, 40))}`,
    )
  }
  const whole = m[1] as string
  const fraction = m[2] ?? ''
  if (fraction.length > decimals) {
    throw new ValidationError(
      'BAD_UNITS',
      `${JSON.stringify(human)} has ${fraction.length} fraction digits but the token has ${decimals}`,
    )
  }
  const value = BigInt(whole + fraction.padEnd(decimals, '0'))
  if (value > U64_MAX) {
    throw new ValidationError(
      'U64_RANGE',
      `${JSON.stringify(human)} exceeds the u64 range in base units`,
    )
  }
  return value
}

/** Options of {@link formatUnits}. */
export interface FormatUnitsOptions {
  /** Keep trailing fraction zeros (`"1.500000"`). Default false. */
  readonly fixed?: boolean
}

/**
 * Format base units as a canonical decimal string: no exponent, no float, no trailing zeros
 * (unless `fixed`). The inverse of {@link parseUnits} for canonical input.
 *
 * @example
 * formatUnits(1_500_000n, 6) // "1.5"
 * @throws ValidationError `BAD_UNITS | BAD_DECIMALS`
 */
export function formatUnits(base: bigint, decimals: number, opts: FormatUnitsOptions = {}): string {
  checkDecimals(decimals)
  if (typeof base !== 'bigint' || base < 0n) {
    throw new ValidationError('BAD_UNITS', 'base units must be a non-negative bigint')
  }
  if (decimals === 0) return base.toString()
  const digits = base.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  let fraction = digits.slice(digits.length - decimals)
  if (!opts.fixed) fraction = fraction.replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}

/**
 * Parse a limit typed by a person or an LLM: the exact word `"unlimited"` or a positive decimal
 * string in token units (`"5"`, `"0.25"`). `"0"` is refused (on chain 0 means unlimited; say so
 * explicitly). The result is a valid input for the permission builders and plans.
 *
 * @example
 * parseLimitInput('250', 6) // 250_000_000n
 * parseLimitInput('unlimited', 6) // 'unlimited'
 * @throws ValidationError `BAD_LIMIT | BAD_UNITS | U64_RANGE`
 */
export function parseLimitInput(input: string, decimals: number): bigint | 'unlimited' {
  if (input === 'unlimited') return 'unlimited'
  const value = parseUnits(input, decimals)
  if (value === 0n) {
    throw new ValidationError(
      'ZERO_LIMIT_AMBIGUOUS',
      'a limit of 0 is ambiguous (0 means UNLIMITED on chain); write "unlimited" if that is what you mean',
    )
  }
  return value
}
