import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  parseDurationFlag,
  parseExpiryFlag,
  parseHumanAmount,
  parseLimitFlag,
  relativeTime,
  shortAddress,
} from '../src/units'
import { CliError } from '../src/errors'

const ctx = (over: Partial<Parameters<typeof parseHumanAmount>[1]> = {}) => ({
  decimals: 6,
  symbol: 'DUSD',
  field: '--amount',
  ...over,
})

describe('parseHumanAmount', () => {
  it('reads plain and symbol-suffixed decimals', () => {
    expect(parseHumanAmount('25', ctx())).toBe(25_000_000n)
    expect(parseHumanAmount('25 DUSD', ctx())).toBe(25_000_000n)
    expect(parseHumanAmount('0.000001', ctx())).toBe(1n)
    expect(parseHumanAmount(' 1.5  dusd ', ctx())).toBe(1_500_000n)
  })

  it('refuses a symbol that is not the mint, or any symbol on an unknown mint', () => {
    expect(() => parseHumanAmount('25 USDC', ctx())).toThrow(/is in USDC but the mint is DUSD/)
    expect(() => parseHumanAmount('25 DUSD', ctx({ symbol: undefined }))).toThrow(/no known symbol/)
  })

  it('refuses malformed input and too many fraction digits', () => {
    for (const bad of ['', 'abc', '-1', '1e6', '.5', '5.', '1,000', '1 2']) {
      expect(() => parseHumanAmount(bad, ctx()), bad).toThrow(CliError)
    }
    expect(() => parseHumanAmount('0.0000001', ctx())).toThrow(/fraction digits/)
  })

  it('treats --raw input as an integer of base units', () => {
    expect(parseHumanAmount('25000000', ctx({ raw: true }))).toBe(25_000_000n)
    expect(() => parseHumanAmount('25.5', ctx({ raw: true }))).toThrow(/integer of base units/)
  })
})

describe('parseLimitFlag', () => {
  it('accepts unlimited and positive amounts, and refuses 0', () => {
    expect(parseLimitFlag('unlimited', ctx())).toBe('unlimited')
    expect(parseLimitFlag('5 DUSD', ctx())).toBe(5_000_000n)
    expect(() => parseLimitFlag('0', ctx())).toThrow(/means UNLIMITED/)
  })
})

describe('durations and expiry', () => {
  it('parses duration units', () => {
    expect(parseDurationFlag('30d', '--max-expiry')).toBe(2_592_000n)
    expect(parseDurationFlag('12h', 'x')).toBe(43_200n)
    expect(parseDurationFlag('90m', 'x')).toBe(5_400n)
    expect(parseDurationFlag('2w', 'x')).toBe(1_209_600n)
    expect(parseDurationFlag('45', 'x')).toBe(45n)
    expect(() => parseDurationFlag('soon', 'x')).toThrow(CliError)
  })

  it('parses expiry as duration, ISO and unix seconds, and refuses milliseconds', () => {
    const now = 1_800_000_000n
    expect(parseExpiryFlag('7d', now)).toBe(now + 604_800n)
    expect(parseExpiryFlag('2027-01-15T08:00:00Z', now)).toBe(1_800_000_000n)
    expect(parseExpiryFlag('1900000000', now)).toBe(1_900_000_000n)
    expect(() => parseExpiryFlag('1900000000000', now)).toThrow(/MILLISECONDS/i)
    expect(() => parseExpiryFlag('tomorrow-ish', now)).toThrow(/--expiry/)
  })
})

describe('presentation helpers', () => {
  it('formats amounts in human units, or raw with --raw', () => {
    expect(formatAmount(25_000_000n, 6, 'DUSD')).toBe('25 DUSD')
    expect(formatAmount(1_500_000n, 6)).toBe('1.5')
    expect(formatAmount(25_000_000n, 6, 'DUSD', true)).toBe('25000000')
    expect(formatAmount(7n, undefined)).toBe('7 (raw units)')
  })

  it('prints relative times', () => {
    const now = 1_000_000n
    expect(relativeTime(now + 3n, now)).toBe('just now')
    expect(relativeTime(now + 90_000n, now)).toBe('in 1d 1h')
    expect(relativeTime(now - 125n, now)).toBe('2m ago')
    expect(relativeTime(now - 7_200n, now)).toBe('2h ago')
    expect(relativeTime(now + 30n, now)).toBe('in 30s')
  })

  it('shortens addresses', () => {
    expect(shortAddress('3YhwEJsgRiwZQ6H8e7iRttvNxmh9gecHbyga9dwcjR1u')).toBe('3Yhw…jR1u')
    expect(shortAddress('abc')).toBe('abc')
  })
})
