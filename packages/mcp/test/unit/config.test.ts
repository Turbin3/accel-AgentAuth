import { describe, expect, it } from 'vitest'
import { ConfigError, parseConfig } from '../../src/config'

const OWNER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'
const base = ['--profile', 'agent', '--owner', OWNER]
const env = { AGENTAUTH_AGENT_KEYPAIR: '/tmp/agent.json' }

describe('parseConfig', () => {
  it('accepts a minimal agent profile and applies safe defaults', () => {
    const c = parseConfig(base, env)
    expect(c.profile).toBe('agent')
    expect(c.cluster).toBe('devnet')
    expect(c.maxPaysPerMinute).toBe(5)
    expect(c.duplicateWindowSeconds).toBe(60)
    expect(c.landDenied).toBe(false)
    expect(c.unsafeDevSign).toBe(false)
  })

  it('needs a profile, a keypair path and a trusted owner for the agent profile', () => {
    expect(() => parseConfig([], env)).toThrow(ConfigError)
    expect(() => parseConfig(['--profile', 'root'], env)).toThrow(/profile/)
    expect(() => parseConfig(base, {})).toThrow(/AGENTAUTH_AGENT_KEYPAIR/)
    expect(() => parseConfig(['--profile', 'agent'], env)).toThrow(/--owner/)
  })

  it('refuses to start an agent process that can see the owner key', () => {
    expect(() => parseConfig(base, { ...env, AGENTAUTH_OWNER_KEYPAIR: '/tmp/owner.json' })).toThrow(
      /never see the owner key/,
    )
  })

  it('refuses --unsafe-dev-sign outside the owner profile and on mainnet', () => {
    expect(() => parseConfig([...base, '--unsafe-dev-sign'], env)).toThrow(
      /only for --profile owner/,
    )
    const owner = ['--profile', 'owner', '--owner', OWNER, '--unsafe-dev-sign']
    expect(() =>
      parseConfig([...owner, '--cluster', 'mainnet-beta'], { AGENTAUTH_OWNER_KEYPAIR: '/k' }),
    ).toThrow(/mainnet/)
    expect(() => parseConfig(owner, {})).toThrow(/AGENTAUTH_OWNER_KEYPAIR/)
    const c = parseConfig(owner, { AGENTAUTH_OWNER_KEYPAIR: '/k' })
    expect(c.unsafeDevSign).toBe(true)
    expect(c.ownerKeypairPath).toBe('/k')
  })

  it('does not read the owner key path unless dev signing was asked for', () => {
    const c = parseConfig(['--profile', 'owner', '--owner', OWNER], {
      AGENTAUTH_OWNER_KEYPAIR: '/k',
    })
    expect(c.ownerKeypairPath).toBeUndefined()
  })

  it('owner and observer profiles hold no agent key', () => {
    expect(parseConfig(['--profile', 'observer'], {}).agentKeypairPath).toBeUndefined()
    expect(() =>
      parseConfig(['--profile', 'owner', '--owner', OWNER, '--agent-keypair', '/x'], {}),
    ).toThrow(/only for --profile agent/)
    expect(
      parseConfig(['--profile', 'owner', '--owner', OWNER], env).agentKeypairPath,
    ).toBeUndefined()
  })

  it('validates addresses, numbers and flags', () => {
    expect(() => parseConfig(['--profile', 'owner', '--owner', 'nope'], {})).toThrow(/valid base58/)
    expect(() => parseConfig([...base, '--max-pays-per-minute', '0'], env)).toThrow(/between/)
    expect(() => parseConfig([...base, '--max-amount', '1e9'], env)).toThrow(/decimal/)
    expect(() => parseConfig([...base, '--bogus'], env)).toThrow(ConfigError)
    expect(() =>
      parseConfig(['--profile', 'owner', '--owner', OWNER, '--land-denied'], {}),
    ).toThrow(/only for --profile agent/)
  })

  it('never echoes key material in an error', () => {
    try {
      parseConfig(base, { ...env, AGENTAUTH_OWNER_KEYPAIR: '/tmp/SECRET-PATH-owner.json' })
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SECRET-PATH')
    }
  })
})
