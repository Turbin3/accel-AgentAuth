import { describe, expect, it } from 'vitest'
import { ValidationError, formatUnits, parseUnits } from '../src/index'

/** mulberry32: small seeded PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function randU64(r: () => number): bigint {
  // random bit length so small and huge values are both common
  const bits = 1 + Math.floor(r() * 64)
  let v = 0n
  for (let i = 0; i < bits; i++) v = (v << 1n) | (r() < 0.5 ? 0n : 1n)
  return v
}
const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    return (e as ValidationError).code
  }
  return 'NO_THROW'
}

describe('parseUnits', () => {
  it.each([
    ['0', 6, 0n],
    ['1', 6, 1_000_000n],
    ['1.5', 6, 1_500_000n],
    ['0.000001', 6, 1n],
    ['123456789.123456', 6, 123_456_789_123_456n],
    ['1.50', 6, 1_500_000n],
    ['007', 0, 7n],
    ['18446744073709551615', 0, 18446744073709551615n],
    ['18446744073.709551615', 9, 18446744073709551615n],
    ['1', 0, 1n],
    ['0.5', 1, 5n],
  ] as const)('%s @ %i => %s', (s, d, expected) => {
    expect(parseUnits(s, d)).toBe(expected)
  })

  it.each([
    ['', 'BAD_UNITS'],
    ['.', 'BAD_UNITS'],
    ['.5', 'BAD_UNITS'],
    ['5.', 'BAD_UNITS'],
    ['-1', 'BAD_UNITS'],
    ['+1', 'BAD_UNITS'],
    ['1e6', 'BAD_UNITS'],
    ['1E6', 'BAD_UNITS'],
    ['0x10', 'BAD_UNITS'],
    ['NaN', 'BAD_UNITS'],
    ['Infinity', 'BAD_UNITS'],
    ['1,000', 'BAD_UNITS'],
    ['1_000', 'BAD_UNITS'],
    [' 1', 'BAD_UNITS'],
    ['1 ', 'BAD_UNITS'],
    ['1..2', 'BAD_UNITS'],
    ['１２', 'BAD_UNITS'],
    ['1.1234567', 'BAD_UNITS'],
    ['18446744073709.551616', 'U64_RANGE'],
  ])('rejects %j (%s)', (s, c) => {
    expect(code(() => parseUnits(s, 6))).toBe(c)
  })

  it('rejects too many fraction digits and an overflow of u64', () => {
    expect(code(() => parseUnits('1.5', 0))).toBe('BAD_UNITS')
    expect(code(() => parseUnits('18446744073709551616', 0))).toBe('U64_RANGE')
  })

  it('rejects non-strings and bad decimals', () => {
    expect(code(() => parseUnits(1.5 as unknown as string, 6))).toBe('BAD_UNITS')
    expect(code(() => parseUnits('1', -1))).toBe('BAD_DECIMALS')
    expect(code(() => parseUnits('1', 256))).toBe('BAD_DECIMALS')
    expect(code(() => parseUnits('1', 1.5))).toBe('BAD_DECIMALS')
  })
})

describe('formatUnits', () => {
  it.each([
    [0n, 6, '0'],
    [1n, 6, '0.000001'],
    [1_500_000n, 6, '1.5'],
    [1_000_000n, 6, '1'],
    [123n, 0, '123'],
    [18446744073709551615n, 9, '18446744073.709551615'],
    [5n, 1, '0.5'],
    [100n, 2, '1'],
  ] as const)('%s @ %i => %s', (v, d, s) => {
    expect(formatUnits(v, d)).toBe(s)
  })
  it('fixed keeps trailing zeros', () => {
    expect(formatUnits(1_500_000n, 6, { fixed: true })).toBe('1.500000')
    expect(formatUnits(0n, 6, { fixed: true })).toBe('0.000000')
    expect(formatUnits(7n, 0, { fixed: true })).toBe('7')
  })
  it('rejects negatives, non-bigints, bad decimals', () => {
    expect(code(() => formatUnits(-1n, 6))).toBe('BAD_UNITS')
    expect(code(() => formatUnits(1 as unknown as bigint, 6))).toBe('BAD_UNITS')
    expect(code(() => formatUnits(1n, 300))).toBe('BAD_DECIMALS')
  })
})

describe('round-trip properties (seeded, 3000 cases)', () => {
  it('parseUnits(formatUnits(x, d), d) === x and the string has no float artefacts', () => {
    const r = rng(0xa6e17)
    for (let i = 0; i < 3000; i++) {
      const d = Math.floor(r() * 19)
      const x = randU64(r)
      const s = formatUnits(x, d)
      expect(s).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/)
      expect(parseUnits(s, d)).toBe(x)
      const fixed = formatUnits(x, d, { fixed: true })
      expect(parseUnits(fixed, d)).toBe(x)
      if (d > 0) expect(fixed.split('.')[1]).toHaveLength(d)
    }
  })
  it('formatUnits(parseUnits(s, d), d) is the canonical form of s', () => {
    const r = rng(42)
    for (let i = 0; i < 2000; i++) {
      const d = 1 + Math.floor(r() * 12)
      const whole = String(Math.floor(r() * 1e6))
      const fracLen = Math.floor(r() * (d + 1))
      let frac = ''
      for (let k = 0; k < fracLen; k++) frac += String(Math.floor(r() * 10))
      const s = frac ? `${whole}.${frac}` : whole
      const canon = formatUnits(parseUnits(s, d), d)
      expect(parseUnits(canon, d)).toBe(parseUnits(s, d))
      const trimmed = frac.replace(/0+$/, '')
      expect(canon).toBe(trimmed ? `${whole}.${trimmed}` : whole)
    }
  })
  it('ordering is preserved (a < b iff parse(a) < parse(b))', () => {
    const r = rng(7)
    for (let i = 0; i < 1000; i++) {
      const a = randU64(r)
      const b = randU64(r)
      const pa = parseUnits(formatUnits(a, 9), 9)
      const pb = parseUnits(formatUnits(b, 9), 9)
      expect(pa < pb).toBe(a < b)
    }
  })
  it('no input string with an exponent, sign or non-digit ever parses', () => {
    const r = rng(99)
    const alphabet = '0123456789.eE+-xX _, aN'
    for (let i = 0; i < 3000; i++) {
      let s = ''
      const n = 1 + Math.floor(r() * 10)
      for (let k = 0; k < n; k++) s += alphabet[Math.floor(r() * alphabet.length)]
      let parsed: bigint | undefined
      try {
        parsed = parseUnits(s, 6)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined) expect(s).toMatch(/^[0-9]+(\.[0-9]+)?$/)
    }
  })
})
