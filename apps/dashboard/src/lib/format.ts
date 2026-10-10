import { formatUnits } from '@agentauth-sol/sdk'

/** Middle-ellipsis for an address: `4Nd1mB...qy5z`. */
export function shortAddress(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail + 3) return value
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

/** Raw units to a human string with thousands separators in the integer part. */
export function formatAmount(raw: bigint, decimals: number | null): string {
  if (decimals === null) return `${raw.toLocaleString('en-US')} raw units`
  const text = formatUnits(raw, decimals)
  const [int, frac] = text.split('.')
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

/** A limit as shown to people: 'unlimited' stays a word, never a 0. */
export function formatLimit(limit: bigint | 'unlimited', decimals: number | null): string {
  return limit === 'unlimited' ? 'unlimited' : formatAmount(limit, decimals)
}

/** `bigint` to a number in [0, 100] for a meter; null when unbounded. Integer math, no float drift. */
export function percentOf(used: bigint, limit: bigint | 'unlimited'): number | null {
  if (limit === 'unlimited') return null
  if (limit <= 0n) return 100
  if (used >= limit) return 100
  return Number((used * 10_000n) / limit) / 100
}

/** Relative time for unix seconds, e.g. `in 6d 23h`, `2m ago`. */
export function relativeTime(seconds: bigint | number, nowSeconds: number): string {
  const delta = Number(seconds) - nowSeconds
  const abs = Math.abs(delta)
  const units: [number, string][] = [
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
    [1, 's'],
  ]
  let text = '0s'
  for (let i = 0; i < units.length; i++) {
    const [size, label] = units[i] as [number, string]
    if (abs >= size) {
      const first = Math.floor(abs / size)
      const next = units[i + 1]
      const rest = next ? Math.floor((abs % size) / next[0]) : 0
      text = rest > 0 && next ? `${first}${label} ${rest}${next[1]}` : `${first}${label}`
      break
    }
  }
  if (abs < 1) return 'now'
  return delta >= 0 ? `in ${text}` : `${text} ago`
}
