/**
 * Structured, redacted logging to STDERR (stdout belongs to the MCP protocol). One JSON object
 * per line. Tool arguments are never logged, only tool names, outcomes and durations.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

const SECRET_KEY = /key|secret|seed|private|mnemonic|password|token_?value|authorization/i
const MAX_DEPTH = 4

/** Replace anything that looks like key material: by field name, by shape (byte arrays), by size. */
export function redact(value: unknown, depth = 0, key = ''): unknown {
  if (SECRET_KEY.test(key) && key !== 'keypair_path' && key !== 'key_source') return '[REDACTED]'
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string')
    return value.length > 300 ? `${value.slice(0, 300)}...[cut]` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[depth]'
  if (value instanceof Uint8Array) return '[REDACTED bytes]'
  if (Array.isArray(value)) {
    if (value.length >= 32 && value.every((v) => typeof v === 'number')) return '[REDACTED bytes]'
    return value.slice(0, 20).map((v) => redact(v, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1, k)
    return out
  }
  return '[unserializable]'
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** Logger writing to `write` (default: process.stderr). */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    if (ORDER[lvl] < ORDER[level]) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    })
    write(`${line}\n`)
  }
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  }
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = createLogger('silent')
