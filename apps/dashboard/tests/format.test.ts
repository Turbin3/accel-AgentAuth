import { formatAmount, formatLimit, percentOf, relativeTime, shortAddress } from '@/lib/format'

describe('format', () => {
  it('shortens with a middle ellipsis and leaves short strings alone', () => {
    expect(shortAddress('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z')).toBe('4Nd1...qy5z')
    expect(shortAddress('short')).toBe('short')
  })

  it('groups human amounts and keeps decimals exact', () => {
    expect(formatAmount(1_234_567_890_123n, 6)).toBe('1,234,567.890123')
    expect(formatAmount(5_000_000n, 6)).toBe('5')
    expect(formatAmount(1_000n, null)).toBe('1,000 raw units')
  })

  it('never renders unlimited as a number', () => {
    expect(formatLimit('unlimited', 6)).toBe('unlimited')
    expect(formatLimit(2_500_000n, 6)).toBe('2.5')
  })

  it('computes meter percentages with integer math', () => {
    expect(percentOf(3n, 20n)).toBe(15)
    expect(percentOf(20n, 20n)).toBe(100)
    expect(percentOf(30n, 20n)).toBe(100)
    expect(percentOf(1n, 'unlimited')).toBeNull()
    expect(percentOf(1n, 3n)).toBe(33.33)
  })

  it('writes relative times in both directions', () => {
    expect(relativeTime(1000, 1000)).toBe('now')
    expect(relativeTime(1000 + 90_000 + 3600, 1000)).toBe('in 1d 2h')
    expect(relativeTime(1000 - 120, 1000)).toBe('2m ago')
  })
})
