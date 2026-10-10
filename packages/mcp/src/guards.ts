import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Sliding-window rate limiter (in memory, per process). */
export class RateLimiter {
  private readonly stamps: number[] = []
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Take a slot; false when the window is full. */
  tryAcquire(now: number): boolean {
    while (this.stamps.length > 0 && now - (this.stamps[0] ?? 0) >= this.windowMs)
      this.stamps.shift()
    if (this.stamps.length >= this.limit) return false
    this.stamps.push(now)
    return true
  }
}

export type IdempotencyState = 'inflight' | 'done' | 'indeterminate'

interface Entry {
  fingerprint: string
  state: IdempotencyState
  result: Record<string, unknown> | undefined
  at: number
}

export type Begin =
  | { kind: 'new' }
  | {
      kind: 'replay'
      state: Exclude<IdempotencyState, 'inflight'>
      result: Record<string, unknown>
    }
  | { kind: 'inflight'; wait: Promise<void> }
  | { kind: 'conflict' }

const MAX_ENTRIES = 2000

/**
 * Remembers payment attempts by idempotency key so a retried tool call cannot pay twice.
 *
 * - same key + same request while a send is running: the caller waits and gets the same result;
 * - same key + same request after it finished: the stored result is replayed, nothing is sent;
 * - same key + a different request: conflict;
 * - a send whose outcome is unknown (timeout) is stored as `indeterminate`: the key is never
 *   re-sent automatically, the user must check the activity first.
 *
 * Optionally persisted to a JSON file (mode 600, atomic rename) so a restart does not forget. The
 * key is written BEFORE the send (as indeterminate) and updated after it.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private readonly waiters = new Map<string, Array<() => void>>()
  /** fingerprint -> time of the last send that was not definitely rejected */
  private readonly recent = new Map<string, number>()

  constructor(private readonly file: string | undefined) {
    if (file && existsSync(file)) this.load(file)
  }

  begin(key: string, fingerprint: string, now: number): Begin {
    const e = this.entries.get(key)
    if (e === undefined) {
      this.entries.set(key, { fingerprint, state: 'inflight', result: undefined, at: now })
      this.trim()
      try {
        this.persist() // write-ahead: a crash during the send leaves an indeterminate key behind
      } catch (e) {
        // Cannot guarantee idempotency across a crash: do not let the caller send.
        this.entries.delete(key)
        throw e
      }
      return { kind: 'new' }
    }
    if (e.fingerprint !== fingerprint) return { kind: 'conflict' }
    if (e.state === 'inflight') {
      return {
        kind: 'inflight',
        wait: new Promise<void>((resolve) => {
          const list = this.waiters.get(key) ?? []
          list.push(resolve)
          this.waiters.set(key, list)
        }),
      }
    }
    return { kind: 'replay', state: e.state, result: e.result ?? {} }
  }

  /** Record the final outcome of a request that was sent (or definitely rejected on chain). */
  finish(
    key: string,
    state: 'done' | 'indeterminate',
    result: Record<string, unknown>,
    now: number,
  ): void {
    const e = this.entries.get(key)
    if (e === undefined) return
    e.state = state
    e.result = result
    e.at = now
    this.persistBestEffort()
    this.wake(key)
  }

  /** Forget a key whose request never reached the network (nothing was sent). */
  release(key: string): void {
    this.entries.delete(key)
    this.persistBestEffort()
    this.wake(key)
  }

  /** Result stored for `key`, if any (tests, status). */
  peek(key: string): Entry | undefined {
    return this.entries.get(key)
  }

  /**
   * True when an identical request (same fingerprint, any other key) was sent less than `windowMs`
   * ago or is being sent right now.
   */
  isRecentDuplicate(
    fingerprint: string,
    now: number,
    windowMs: number,
    exceptKey: string,
  ): boolean {
    const t = this.recent.get(fingerprint)
    if (t !== undefined && now - t < windowMs) return true
    for (const [key, e] of this.entries) {
      if (key !== exceptKey && e.state === 'inflight' && e.fingerprint === fingerprint) return true
    }
    return false
  }

  markSent(fingerprint: string, now: number): void {
    this.recent.set(fingerprint, now)
    if (this.recent.size > MAX_ENTRIES) {
      const first = this.recent.keys().next()
      if (!first.done) this.recent.delete(first.value)
    }
  }

  private wake(key: string): void {
    const list = this.waiters.get(key)
    this.waiters.delete(key)
    for (const resolve of list ?? []) resolve()
  }

  private trim(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const first = this.entries.keys().next()
      if (first.done) return
      this.entries.delete(first.value)
    }
  }

  private load(file: string): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const row of parsed) {
        if (
          typeof row === 'object' &&
          row !== null &&
          typeof (row as Record<string, unknown>)['key'] === 'string' &&
          typeof (row as Record<string, unknown>)['fingerprint'] === 'string'
        ) {
          const r = row as {
            key: string
            fingerprint: string
            state: string
            result: Record<string, unknown>
            at: number
          }
          if (r.state === 'done' || r.state === 'indeterminate') {
            this.entries.set(r.key, {
              fingerprint: r.fingerprint,
              state: r.state,
              result: r.result,
              at: r.at,
            })
          }
        }
      }
    } catch {
      // A corrupt state file must not stop the server; the in-memory guard still works.
    }
  }

  /** After the send the in-memory state is authoritative; a failing disk must not hide the result. */
  private persistBestEffort(): void {
    try {
      this.persist()
    } catch {
      // keep going: the in-memory entry still protects this process
    }
  }

  private persist(): void {
    if (!this.file) return
    // A request that is still in flight is stored as indeterminate: if the process dies before it
    // finishes, the next process must not send it again.
    const rows = [...this.entries.entries()].map(([key, e]) => ({
      key,
      fingerprint: e.fingerprint,
      state: e.state === 'inflight' ? 'indeterminate' : e.state,
      result: e.state === 'inflight' ? { note: 'in flight when the process stopped' } : e.result,
      at: e.at,
    }))
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}
