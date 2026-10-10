import { describe, expect, it } from 'vitest'
import { createLogger, redact } from '../../src/log'

describe('redact', () => {
  it('hides secret-named fields, byte arrays and Uint8Arrays', () => {
    const out = redact({
      privateKey: 'abc',
      agent_secret: 'x',
      seedPhrase: 'a b c',
      keypair: Array.from({ length: 64 }, (_, i) => i),
      bytes: new Uint8Array(64),
      nested: { password: 'p', fine: 'visible' },
      signature: '5abc',
    }) as Record<string, unknown>
    expect(out['privateKey']).toBe('[REDACTED]')
    expect(out['agent_secret']).toBe('[REDACTED]')
    expect(out['seedPhrase']).toBe('[REDACTED]')
    expect(out['keypair']).toBe('[REDACTED]')
    expect(out['bytes']).toBe('[REDACTED bytes]')
    expect((out['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]')
    expect((out['nested'] as Record<string, unknown>)['fine']).toBe('visible')
    expect(out['signature']).toBe('5abc')
  })

  it('redacts a byte array even under an innocent name, and bounds depth and size', () => {
    const out = redact({
      data: Array.from({ length: 32 }, () => 7),
      deep: { a: { b: { c: { d: 1 } } } },
    }) as Record<string, unknown>
    expect(out['data']).toBe('[REDACTED bytes]')
    expect(JSON.stringify(out['deep'])).toContain('[depth]')
    expect(redact('x'.repeat(1000)) as string).toHaveLength(308)
  })
})

describe('createLogger', () => {
  it('writes one JSON object per line, honours the level and redacts', () => {
    const lines: string[] = []
    const log = createLogger('info', (l) => lines.push(l))
    log.debug('hidden')
    log.info('hello', { token_count: 3, secret: 'nope' })
    log.error('boom', { code: 7n })
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(first).toMatchObject({
      level: 'info',
      event: 'hello',
      token_count: 3,
      secret: '[REDACTED]',
    })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ level: 'error', code: '7' })
  })
})
