import { afterEach, describe, expect, it } from 'vitest'
import { address, type Address } from '@solana/kit'
import { endpointsFromEnv, isLoopbackUrl, wsUrlFor } from '../src/lib/config'
import { parseDemoState, type DemoState } from '../src/lib/state'

const a = (n: number): Address => {
  // distinct valid addresses: base58 of a 32-byte buffer is not needed, reuse well-known ones
  const pool = [
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if',
    '33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6',
    '6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw',
    'CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ',
  ]
  return address(pool[n % pool.length] as string)
}

function sampleState(): DemoState {
  const mint = (n: number, symbol: string) => ({
    address: a(n),
    symbol,
    name: symbol,
    decimals: 6,
    mintAuthority: a(5),
  })
  return {
    version: 1,
    network: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    wsUrl: 'ws://127.0.0.1:8900',
    genesisHash: 'abc',
    wallets: {
      owner: a(0),
      agent: a(1),
      attacker: a(2),
      recipient: a(3),
      harness: a(4),
      hot: a(5),
    },
    mints: { dusd: mint(1, 'DUSD'), dout: mint(2, 'DOUT') },
    tokenAccounts: {
      ownerDusd: a(0),
      ownerDout: a(1),
      recipientDusd: a(2),
      attackerDusd: a(3),
      attackerDusdB: a(4),
      attackerDout: a(5),
      hotDusd: a(0),
      harnessDusd: a(1),
      harnessDout: a(2),
    },
    pool: {
      state: a(0),
      authority: a(1),
      config: a(2),
      observation: a(3),
      vaultDusd: a(4),
      vaultDout: a(5),
      initialReserves: { dusd: '10000000000', dout: '10000000000' },
    },
    gated: { config: a(3) },
    initialBalances: { ownerDusd: '1000000000', hotDusd: '50000000', harnessDusd: '1000000000' },
  }
}

describe('parseDemoState', () => {
  it('round-trips through JSON', () => {
    const s = sampleState()
    expect(parseDemoState(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('rejects a bad address, a bad amount, a wrong version and missing sections', () => {
    const s = JSON.parse(JSON.stringify(sampleState())) as Record<string, any>
    const bad = (mutate: (o: Record<string, any>) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(s)) as Record<string, any>
      mutate(copy)
      return copy
    }
    expect(() => parseDemoState(bad((o) => (o['wallets']['owner'] = 'not-an-address')))).toThrow(
      /wallets\.owner/,
    )
    expect(() =>
      parseDemoState(bad((o) => (o['pool']['initialReserves']['dusd'] = '1.5'))),
    ).toThrow(/initialReserves\.dusd/)
    expect(() => parseDemoState(bad((o) => (o['version'] = 2)))).toThrow(/version/)
    expect(() => parseDemoState(bad((o) => delete o['pool']))).toThrow(/pool/)
    expect(() => parseDemoState(bad((o) => (o['mints']['dusd']['decimals'] = 99)))).toThrow(
      /decimals/,
    )
    expect(() => parseDemoState(null)).toThrow(/state/)
  })

  it('never carries key material fields', () => {
    const text = JSON.stringify(sampleState())
    expect(text).not.toMatch(/secret|private|seed/i)
  })
})

describe('endpoints', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('recognises loopback URLs only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8899')).toBe(true)
    expect(isLoopbackUrl('http://localhost:8899')).toBe(true)
    expect(isLoopbackUrl('https://api.devnet.solana.com')).toBe(false)
    expect(isLoopbackUrl('nonsense')).toBe(false)
  })

  it('derives the websocket URL on rpc port + 1', () => {
    expect(wsUrlFor('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8900')
    expect(wsUrlFor('http://localhost:9000/')).toBe('ws://localhost:9001')
  })

  it('defaults to the fixed local ports and refuses a remote RPC unless explicitly allowed', () => {
    delete process.env['AA_RPC_URL']
    delete process.env['AA_WS_URL']
    delete process.env['AA_ALLOW_REMOTE']
    expect(endpointsFromEnv()).toEqual({
      rpcUrl: 'http://127.0.0.1:8899',
      wsUrl: 'ws://127.0.0.1:8900',
    })
    process.env['AA_RPC_URL'] = 'https://api.devnet.solana.com'
    expect(() => endpointsFromEnv()).toThrow(/refusing to use non-local RPC/)
    process.env['AA_ALLOW_REMOTE'] = '1'
    expect(endpointsFromEnv().rpcUrl).toBe('https://api.devnet.solana.com')
  })
})
