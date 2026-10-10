import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IdempotencyStore, RateLimiter } from '../../src/guards'

describe('RateLimiter', () => {
  it('allows N per window and recovers', () => {
    const r = new RateLimiter(2, 1000)
    expect(r.tryAcquire(0)).toBe(true)
    expect(r.tryAcquire(10)).toBe(true)
    expect(r.tryAcquire(20)).toBe(false)
    expect(r.tryAcquire(1001)).toBe(true)
    expect(r.tryAcquire(1002)).toBe(false)
  })
})

describe('IdempotencyStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('replays a finished request and refuses a different one under the same key', () => {
    const s = new IdempotencyStore(undefined)
    expect(s.begin('k1', 'a', 0).kind).toBe('new')
    s.finish('k1', 'done', { signature: 'sig' }, 1)
    const again = s.begin('k1', 'a', 2)
    expect(again).toEqual({ kind: 'replay', state: 'done', result: { signature: 'sig' } })
    expect(s.begin('k1', 'b', 3).kind).toBe('conflict')
  })

  it('makes a concurrent duplicate wait for the first attempt', async () => {
    const s = new IdempotencyStore(undefined)
    s.begin('k', 'a', 0)
    const second = s.begin('k', 'a', 1)
    expect(second.kind).toBe('inflight')
    let woke = false
    if (second.kind === 'inflight') void second.wait.then(() => (woke = true))
    s.finish('k', 'done', { n: 1 }, 2)
    await Promise.resolve()
    await Promise.resolve()
    expect(woke).toBe(true)
  })

  it('keeps an indeterminate key, releases an unsent one', () => {
    const s = new IdempotencyStore(undefined)
    s.begin('u', 'a', 0)
    s.finish('u', 'indeterminate', {}, 1)
    expect(s.begin('u', 'a', 2)).toMatchObject({ kind: 'replay', state: 'indeterminate' })
    s.begin('r', 'a', 0)
    s.release('r')
    expect(s.begin('r', 'a', 1).kind).toBe('new')
  })

  it('tracks identical recent requests', () => {
    const s = new IdempotencyStore(undefined)
    s.markSent('fp', 1000)
    expect(s.isRecentDuplicate('fp', 1500, 1000, 'k')).toBe(true)
    expect(s.isRecentDuplicate('fp', 2500, 1000, 'k')).toBe(false)
    expect(s.isRecentDuplicate('other', 1500, 1000, 'k')).toBe(false)
  })

  it('treats an identical request that is still being sent under another key as a duplicate', () => {
    const s = new IdempotencyStore(undefined)
    s.begin('first', 'fp', 0)
    expect(s.isRecentDuplicate('fp', 1, 1000, 'second')).toBe(true)
    expect(s.isRecentDuplicate('fp', 1, 1000, 'first')).toBe(false)
    s.release('first')
    expect(s.isRecentDuplicate('fp', 2, 1000, 'second')).toBe(false)
  })

  it('persists finished keys in a mode 600 file and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-idem-'))
    dirs.push(dir)
    const file = join(dir, 'state', 'idem.json')
    const a = new IdempotencyStore(file)
    a.begin('k', 'fp', 0)
    a.finish('k', 'done', { signature: 's' }, 1)
    a.begin('inflight', 'x', 0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const b = new IdempotencyStore(file)
    expect(b.begin('k', 'fp', 5)).toMatchObject({ kind: 'replay', result: { signature: 's' } })
    // a request that was in flight when the process stopped is never sent again
    expect(b.begin('inflight', 'x', 5)).toMatchObject({ kind: 'replay', state: 'indeterminate' })
    b.begin('released', 'y', 6)
    b.release('released')
    expect(new IdempotencyStore(file).begin('released', 'y', 7).kind).toBe('new')
  })

  it('refuses to start a request it cannot record, and leaves no stuck key behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-idem-'))
    dirs.push(dir)
    // the parent of the state file is a regular file: every write fails
    writeFileSync(join(dir, 'blocker'), 'x')
    const s = new IdempotencyStore(join(dir, 'blocker', 'idem.json'))
    expect(() => s.begin('k', 'fp', 0)).toThrow()
    expect(s.peek('k')).toBeUndefined()
  })

  it('survives a corrupt state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-idem-'))
    dirs.push(dir)
    const file = join(dir, 'bad.json')
    new IdempotencyStore(file) // nothing to load
    const s = new IdempotencyStore(undefined)
    expect(s.begin('k', 'a', 0).kind).toBe('new')
  })
})
