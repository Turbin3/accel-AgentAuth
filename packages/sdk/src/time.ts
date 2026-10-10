import { nowSeconds, toSeconds } from './bytes'
import { ValidationError } from './sdk-errors'

/** Default maximum mandate lifetime the plans accept: one year, in seconds. */
export const MAX_MANDATE_LIFETIME_SECONDS = 365n * 86_400n

/** 2100-01-01T00:00:00Z in unix seconds: no expiry beyond this is ever sensible. */
export const MAX_SANE_EXPIRY = 4_102_444_800n

/** Any "seconds" value above this is almost certainly milliseconds (year 5138 in seconds). */
export const MILLISECOND_SUSPECT_THRESHOLD = 100_000_000_000n

const UNIT_SECONDS: Readonly<Record<string, bigint>> = {
  s: 1n,
  m: 60n,
  h: 3_600n,
  d: 86_400n,
  w: 604_800n,
}

/** ISO-8601 string for unix seconds, or `"out of range"` when JS dates cannot represent it. */
export function isoOfSeconds(seconds: bigint): string {
  const ms = Number(seconds) * 1000
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return 'out of range'
  return new Date(ms).toISOString()
}

/**
 * Convert a duration into a lifetime in whole seconds. Accepts a number of seconds, a bigint, or a
 * string such as `"90m"`, `"7d"`, `"2w"` (units s, m, h, d, w).
 *
 * @throws ValidationError `BAD_EXPIRY`
 */
export function parseDuration(duration: bigint | number | string): bigint {
  let seconds: bigint
  if (typeof duration === 'string') {
    const m = /^([0-9]{1,9})([smhdw])$/.exec(duration)
    if (!m) {
      throw new ValidationError(
        'BAD_EXPIRY',
        `duration must look like "90m", "12h", "7d" (units s, m, h, d, w), got ${JSON.stringify(duration.slice(0, 20))}`,
      )
    }
    seconds = BigInt(m[1] as string) * (UNIT_SECONDS[m[2] as string] as bigint)
  } else {
    seconds = toSeconds(duration, 'duration')
  }
  if (seconds <= 0n) throw new ValidationError('BAD_EXPIRY', 'duration must be positive')
  return seconds
}

/**
 * The `expiry` value (unix SECONDS, bigint) for a mandate that should last `duration` from `now`.
 * This is the safe way to build an expiry: it can never produce milliseconds by mistake.
 *
 * @example
 * const expiry = expiresIn('7d')
 * @throws ValidationError `BAD_EXPIRY`
 */
export function expiresIn(duration: bigint | number | string, now?: bigint | number): bigint {
  const base = now === undefined ? nowSeconds() : toSeconds(now, 'now')
  return base + parseDuration(duration)
}

/** Options of {@link checkExpiry}. */
export interface ExpiryCheckOptions {
  readonly now?: bigint | number
  /** Allow a lifetime beyond {@link MAX_MANDATE_LIFETIME_SECONDS} (still capped at the year 2100). */
  readonly allowLongExpiry?: boolean
}

/**
 * Sanity-check an expiry. Returns the list of problems (empty when fine): in the past, looks like
 * milliseconds, beyond the year 2100, or longer than one year without `allowLongExpiry`.
 */
export function checkExpiry(expiry: bigint, opts: ExpiryCheckOptions = {}): string[] {
  const now = opts.now === undefined ? nowSeconds() : toSeconds(opts.now, 'now')
  const problems: string[] = []
  if (typeof expiry !== 'bigint') return ['expiry must be a bigint of unix seconds']
  if (expiry <= now) {
    problems.push(`expiry ${expiry} must be after now (${now}); the program rejects it (20)`)
  }
  if (expiry > MILLISECOND_SUSPECT_THRESHOLD) {
    problems.push(
      `expiry ${expiry} looks like MILLISECONDS; expiry is unix SECONDS (use expiresIn('7d'))`,
    )
  } else if (expiry > MAX_SANE_EXPIRY) {
    problems.push(`expiry ${expiry} is beyond the year 2100`)
  } else if (opts.allowLongExpiry !== true && expiry - now > MAX_MANDATE_LIFETIME_SECONDS) {
    problems.push(
      `expiry is more than one year away; pass allowLongExpiry: true to accept ${isoOfSeconds(expiry)}`,
    )
  }
  return problems
}

/**
 * Parse an expiry typed by a person or an LLM into unix seconds: a duration (`"7d"`), an ISO-8601
 * timestamp (`"2026-12-31T00:00:00Z"`), or a bigint/number of unix seconds. Applies the
 * milliseconds guard. It does not apply the one-year cap (the plans do).
 *
 * @throws ValidationError `BAD_EXPIRY`
 */
export function parseExpiry(input: bigint | number | string, now?: bigint | number): bigint {
  if (typeof input === 'string') {
    if (/^[0-9]{1,9}[smhdw]$/.test(input)) return expiresIn(input, now)
    if (/^[0-9]+$/.test(input)) return guard(BigInt(input))
    const ms = Date.parse(input)
    if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}/.test(input)) {
      throw new ValidationError(
        'BAD_EXPIRY',
        `expiry must be a duration ("7d"), an ISO-8601 time or unix seconds, got ${JSON.stringify(input.slice(0, 30))}`,
      )
    }
    return BigInt(Math.floor(ms / 1000))
  }
  return guard(toSeconds(input, 'expiry'))
}

function guard(seconds: bigint): bigint {
  if (seconds > MILLISECOND_SUSPECT_THRESHOLD) {
    throw new ValidationError(
      'BAD_EXPIRY',
      `expiry ${seconds} looks like MILLISECONDS; expiry is unix SECONDS`,
    )
  }
  return seconds
}
