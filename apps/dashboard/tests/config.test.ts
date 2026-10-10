import { clusterLabel, explorerUrl, isLoopbackUrl, resolveConfig } from '@/lib/config'
import { assertDevSignerAllowed } from '@/lib/wallet/dev-signer'

describe('resolveConfig', () => {
  it('defaults to devnet with the public RPC and no dev signer', () => {
    const c = resolveConfig({})
    expect(c.cluster).toBe('devnet')
    expect(c.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(c.devSigner).toEqual({ browserKey: false, serverKey: false, disabledReason: null })
    expect(c.fatal).toBeNull()
  })

  it('enables the browser dev signer on devnet but never the server key', () => {
    const c = resolveConfig({ NEXT_PUBLIC_AA_CLUSTER: 'devnet', NEXT_PUBLIC_AA_DEV_SIGNER: '1' })
    expect(c.devSigner.browserKey).toBe(true)
    expect(c.devSigner.serverKey).toBe(false)
  })

  it('enables the server dev key only on localnet with a loopback RPC', () => {
    const local = resolveConfig({
      NEXT_PUBLIC_AA_CLUSTER: 'localnet',
      NEXT_PUBLIC_AA_DEV_SIGNER: '1',
      AA_RPC_URL: 'http://127.0.0.1:8929',
    })
    expect(local.devSigner).toMatchObject({ browserKey: true, serverKey: true })
    const remote = resolveConfig({
      NEXT_PUBLIC_AA_CLUSTER: 'localnet',
      NEXT_PUBLIC_AA_DEV_SIGNER: '1',
      AA_RPC_URL: 'https://rpc.example.com',
    })
    expect(remote.devSigner.serverKey).toBe(false)
  })

  it('requires the exact value 1 to turn the dev signer on', () => {
    for (const v of ['true', '0', 'yes', ' ', '2']) {
      const c = resolveConfig({ NEXT_PUBLIC_AA_CLUSTER: 'localnet', NEXT_PUBLIC_AA_DEV_SIGNER: v })
      expect(c.devSigner.browserKey).toBe(false)
    }
  })

  it('is impossible to enable the dev signer on mainnet, and refuses to run', () => {
    const c = resolveConfig({
      NEXT_PUBLIC_AA_CLUSTER: 'mainnet-beta',
      NEXT_PUBLIC_AA_DEV_SIGNER: '1',
      NEXT_PUBLIC_AA_RPC_URL: 'http://127.0.0.1:8899',
    })
    expect(c.fatal).toMatch(/no mainnet deployment/)
    expect(c.devSigner.browserKey).toBe(false)
    expect(c.devSigner.serverKey).toBe(false)
    expect(c.devSigner.disabledReason).toMatch(/cannot be enabled/)
    expect(() => assertDevSignerAllowed(c, 'browser')).toThrow(/not enabled/)
    expect(() => assertDevSignerAllowed(c, 'server')).toThrow(/not enabled/)
  })

  it('treats unknown clusters like mainnet: fatal, no dev signer', () => {
    const c = resolveConfig({ NEXT_PUBLIC_AA_CLUSTER: 'testnet', NEXT_PUBLIC_AA_DEV_SIGNER: '1' })
    expect(c.fatal).toMatch(/Unknown cluster/)
    expect(c.devSigner.browserKey).toBe(false)
  })

  it('accepts only a valid demo mandate address and an https repo url', () => {
    expect(resolveConfig({ NEXT_PUBLIC_AA_DEMO_MANDATE: 'nope' }).demoMandate).toBeNull()
    expect(
      resolveConfig({ NEXT_PUBLIC_AA_DEMO_MANDATE: 'AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if' })
        .demoMandate,
    ).toBe('AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if')
    expect(resolveConfig({ NEXT_PUBLIC_AA_REPO_URL: 'javascript:alert(1)' }).repoUrl).toBeNull()
    expect(resolveConfig({ NEXT_PUBLIC_AA_REPO_URL: 'https://example.org/repo' }).repoUrl).toBe(
      'https://example.org/repo',
    )
  })

  it('assertDevSignerAllowed passes when enabled', () => {
    const c = resolveConfig({ NEXT_PUBLIC_AA_CLUSTER: 'localnet', NEXT_PUBLIC_AA_DEV_SIGNER: '1' })
    expect(() => assertDevSignerAllowed(c, 'browser')).not.toThrow()
    expect(() => assertDevSignerAllowed(c, 'server')).not.toThrow()
  })
})

describe('helpers', () => {
  it('detects loopback urls', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8899')).toBe(true)
    expect(isLoopbackUrl('http://localhost:8899')).toBe(true)
    expect(isLoopbackUrl('https://api.devnet.solana.com')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })

  it('url-encodes the explorer target and the custom RPC', () => {
    expect(
      explorerUrl({ cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899/?a=b&c' }, 'tx', 'S/I G'),
    ).toBe(
      'https://explorer.solana.com/tx/S%2FI%20G?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899%2F%3Fa%3Db%26c',
    )
  })

  it('builds explorer links per cluster', () => {
    expect(explorerUrl({ cluster: 'devnet', rpcUrl: 'x' }, 'tx', 'SIG')).toBe(
      'https://explorer.solana.com/tx/SIG?cluster=devnet',
    )
    expect(
      explorerUrl({ cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899' }, 'address', 'A'),
    ).toBe(
      'https://explorer.solana.com/address/A?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    )
    expect(clusterLabel('localnet')).toBe('Localnet')
  })
})
