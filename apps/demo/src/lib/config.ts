/** Where the local validator listens (scripts/localnet.sh uses the same fixed ports). */
export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899'
export const DEFAULT_WS_URL = 'ws://127.0.0.1:8900'

export interface Endpoints {
  readonly rpcUrl: string
  readonly wsUrl: string
}

/** True for loopback hosts: the only RPC endpoints the demo tooling writes to by default. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** Derive the websocket URL of an RPC URL (the validator serves it on rpc port + 1). */
export function wsUrlFor(rpcUrl: string): string {
  const u = new URL(rpcUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  if (u.port !== '') u.port = String(Number(u.port) + 1)
  return u.toString().replace(/\/$/, '')
}

/**
 * Endpoints from the environment: `AA_RPC_URL` and `AA_WS_URL` (default: the local validator).
 *
 * The demo tooling sends transactions and airdrops. It therefore refuses any non-loopback RPC
 * unless `AA_ALLOW_REMOTE=1`, so an exported `AA_RPC_URL` pointing at devnet or mainnet cannot be
 * hit by accident.
 */
export function endpointsFromEnv(): Endpoints {
  const rpcUrl = process.env['AA_RPC_URL'] ?? DEFAULT_RPC_URL
  const wsUrl =
    process.env['AA_WS_URL'] ?? (rpcUrl === DEFAULT_RPC_URL ? DEFAULT_WS_URL : wsUrlFor(rpcUrl))
  if (!isLoopbackUrl(rpcUrl) && process.env['AA_ALLOW_REMOTE'] !== '1') {
    throw new Error(
      `refusing to use non-local RPC ${new URL(rpcUrl).origin}: the demo tooling is for the local validator ` +
        '(scripts/localnet.sh start). Set AA_ALLOW_REMOTE=1 only if you really mean it.',
    )
  }
  return { rpcUrl, wsUrl }
}
