import { CLUSTER_RPC_URLS } from '@agentauth-sol/sdk'
import { MAINNET_GENESIS_HASH, type Config } from './config'
import { loadKeypairSigner } from './keys'
import type { Logger } from './log'
import { createServer, type ServerHandle } from './server'

export const UNSAFE_BANNER = [
  '################################################################################',
  '# --unsafe-dev-sign is ON: this process holds a LOCAL DEMO OWNER KEY and signs   #',
  '# plans itself. That defeats the point of the owner profile. Demos and tests     #',
  '# only. Never use a key that holds real funds. Refused on mainnet.               #',
  '################################################################################',
].join('\n')

async function genesisHash(url: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }),
    signal: AbortSignal.timeout(10_000),
  })
  const body: unknown = await res.json()
  const result = (body as { result?: unknown }).result
  if (typeof result !== 'string') throw new Error('the RPC did not return a genesis hash')
  return result
}

/**
 * Load the keys the profile needs and build the server. The agent profile loads ONLY the agent
 * key. The owner profile loads an owner key only under `--unsafe-dev-sign`, after printing a
 * banner and verifying that the RPC is not mainnet.
 */
export async function buildFromConfig(
  config: Config,
  log: Logger,
  banner: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): Promise<ServerHandle> {
  const agentSigner =
    config.profile === 'agent' && config.agentKeypairPath
      ? await loadKeypairSigner(config.agentKeypairPath, 'agent', log)
      : undefined

  let ownerSigner
  if (config.unsafeDevSign) {
    if (config.cluster === 'mainnet-beta')
      throw new Error('--unsafe-dev-sign is refused on mainnet-beta')
    banner(UNSAFE_BANNER)
    const url = config.rpcUrl ?? CLUSTER_RPC_URLS[config.cluster]
    if ((await genesisHash(url)) === MAINNET_GENESIS_HASH) {
      throw new Error('--unsafe-dev-sign is refused: the RPC endpoint is Solana mainnet-beta')
    }
    if (!config.ownerKeypairPath) throw new Error('--unsafe-dev-sign needs AGENTAUTH_OWNER_KEYPAIR')
    ownerSigner = await loadKeypairSigner(config.ownerKeypairPath, 'owner', log)
    if (ownerSigner.address !== config.owner) {
      throw new Error('AGENTAUTH_OWNER_KEYPAIR does not match --owner')
    }
  }

  const handle = createServer({
    config,
    log,
    ...(agentSigner ? { agentSigner } : {}),
    ...(ownerSigner ? { ownerSigner } : {}),
  })
  log.info('server_ready', {
    profile: config.profile,
    cluster: config.cluster,
    owner: config.owner ?? null,
    agent: agentSigner?.address ?? config.agent ?? null,
    tools: handle.tools.map((t) => t.name),
    land_denied: config.landDenied,
    unsafe_dev_sign: config.unsafeDevSign,
  })
  if (agentSigner) await handle.refreshSwap()
  return handle
}
