import { formatUnits, parseExpiry, parseUnits } from '@agentauth-sol/sdk'
import { usageError } from './errors'

/** The mint an amount is expressed in (for decimals, the optional symbol check and `--raw`). */
export interface AmountContext {
  readonly decimals: number
  /** Known symbol of the mint (for example `DUSD`). When set, a typed suffix must match it. */
  readonly symbol?: string | undefined
  /** `--raw`: the input is an integer number of base units. */
  readonly raw?: boolean
  /** Flag name for error messages. */
  readonly field: string
}

const HUMAN = /^([0-9]+(?:\.[0-9]+)?)(?:\s+([A-Za-z][A-Za-z0-9._-]{0,15}))?$/

/**
 * Parse a human amount such as `25`, `25.5` or `25 DUSD` into base units. A symbol suffix is only
 * accepted when the mint's symbol is known and equal (so `25 USDC` can never be silently read as
 * another token). With `--raw` the input must be a plain integer of base units.
 */
export function parseHumanAmount(input: string, ctx: AmountContext): bigint {
  const text = input.trim()
  if (ctx.raw === true) {
    if (!/^[0-9]+$/.test(text)) {
      throw usageError(
        `${ctx.field}: with --raw an amount is an integer of base units, got "${input}"`,
      )
    }
    return parseUnits(text, 0)
  }
  const match = HUMAN.exec(text)
  if (!match) {
    throw usageError(
      `${ctx.field}: cannot read "${input}" as an amount`,
      'Use a plain decimal such as "25" or "25.5", optionally followed by the token symbol ("25 DUSD").',
    )
  }
  const [, number, symbol] = match
  if (symbol !== undefined) {
    if (ctx.symbol === undefined) {
      throw usageError(
        `${ctx.field}: "${input}" names a token but this mint has no known symbol`,
        'Drop the symbol and give the number only (the mint comes from --mint or the mandate).',
      )
    }
    if (symbol.toLowerCase() !== ctx.symbol.toLowerCase()) {
      throw usageError(
        `${ctx.field}: "${input}" is in ${symbol} but the mint is ${ctx.symbol}`,
        'Use the same token as the mandate budget mint.',
      )
    }
  }
  try {
    return parseUnits(number as string, ctx.decimals)
  } catch (error) {
    throw usageError(
      `${ctx.field}: ${error instanceof Error ? error.message : String(error)}`,
      `This mint has ${ctx.decimals} decimals.`,
    )
  }
}

/** A limit: the word `unlimited` or a positive human amount. */
export function parseLimitFlag(input: string, ctx: AmountContext): bigint | 'unlimited' {
  if (input.trim().toLowerCase() === 'unlimited') return 'unlimited'
  const value = parseHumanAmount(input, ctx)
  if (value === 0n) {
    throw usageError(
      `${ctx.field}: 0 is not a limit (on chain 0 means UNLIMITED)`,
      'Write "unlimited" and pass --allow-unlimited if you really mean it.',
    )
  }
  return value
}

/** Format base units for people: `25 DUSD`, or `25000000 base units` with `--raw`. */
export function formatAmount(
  value: bigint,
  decimals: number | undefined,
  symbol?: string,
  raw = false,
): string {
  if (raw || decimals === undefined) return `${value.toString()}${raw ? '' : ' (raw units)'}`.trim()
  const text = formatUnits(value, decimals)
  return symbol === undefined ? text : `${text} ${symbol}`
}

/** Expiry flag: a duration (`7d`), an ISO timestamp or unix seconds. Relative to `nowSeconds`. */
export function parseExpiryFlag(input: string, nowSeconds: bigint): bigint {
  const text = input.trim()
  try {
    return parseExpiry(/^[0-9]+$/.test(text) ? BigInt(text) : text, nowSeconds)
  } catch (error) {
    throw usageError(
      `--expiry: ${error instanceof Error ? error.message : String(error)}`,
      'Use a duration (30m, 12h, 7d, 2w), an ISO date (2026-12-31T00:00:00Z) or unix SECONDS.',
    )
  }
}

/** `Nd`/`Nh`/`Nm`/`Ns`/`Nw` (or bare seconds) to whole seconds. */
export function parseDurationFlag(input: string, field: string): bigint {
  const match = /^([0-9]+)\s*([smhdw]?)$/.exec(input.trim())
  if (!match) throw usageError(`${field}: cannot read "${input}" as a duration (try 30d, 12h, 90m)`)
  const n = BigInt(match[1] as string)
  const unit = { '': 1n, s: 1n, m: 60n, h: 3600n, d: 86_400n, w: 604_800n }[match[2] as string]
  return n * (unit as bigint)
}

/** Relative time between two unix-second values: `in 6d 23h`, `4m ago`, `just now`. */
export function relativeTime(targetSeconds: bigint, nowSeconds: bigint): string {
  const delta = targetSeconds - nowSeconds
  const abs = delta < 0n ? -delta : delta
  if (abs < 5n) return 'just now'
  const d = abs / 86_400n
  const h = (abs % 86_400n) / 3600n
  const m = (abs % 3600n) / 60n
  const s = abs % 60n
  let span: string
  if (d > 0n) span = h > 0n ? `${d}d ${h}h` : `${d}d`
  else if (h > 0n) span = m > 0n ? `${h}h ${m}m` : `${h}h`
  else if (m > 0n) span = `${m}m`
  else span = `${s}s`
  return delta < 0n ? `${span} ago` : `in ${span}`
}

export function shortAddress(address: string, keep = 4): string {
  return address.length <= keep * 2 + 1
    ? address
    : `${address.slice(0, keep)}…${address.slice(-keep)}`
}

/** "(50 (50000000 raw units))" reads badly: fold a nested raw-units note into one pair of parentheses. */
export function tidyText(text: string): string {
  return text.replace(/\(([^()]*?) \((\d+ raw units)\)\)/g, '($1, $2)')
}

/**
 * A plan summary as one clause. The SDK ends summaries with ", unsigned." / " unsigned."; that is
 * stale once the plan is sent and breaks any sentence built from it.
 */
export function summaryText(summary: string): string {
  return summary.replace(/,? unsigned\.?$/, '').replace(/\.$/, '')
}
