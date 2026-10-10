import { generateKeyPairSigner } from '@solana/kit'
import type { Client } from '@agentauth-sol/sdk'
import { programIds } from '@agentauth-sol/sdk'
import type { Config } from '../../src/config'
import { silentLogger } from '../../src/log'
import { createServer, type ServerHandle } from '../../src/server'
import { baseConfig, connectClient } from './fixture'

export const OWNER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'

/** A client double for tests that must not touch a network. Unset members throw if used. */
export function stubClient(over: Record<string, unknown> = {}): Client {
  const unreachable = () => Promise.reject(new Error('fetch failed: ECONNREFUSED (stub)'))
  return {
    cluster: 'localnet',
    programIds: programIds('localnet'),
    fetchPolicy: unreachable,
    fetchMandateFor: unreachable,
    inspect: unreachable,
    fetchMint: unreachable,
    activity: unreachable,
    ...over,
  } as unknown as Client
}

export async function offlineServer(
  over: Partial<Config> = {},
  clientOver: Record<string, unknown> = {},
): Promise<{ handle: ServerHandle; client: Awaited<ReturnType<typeof connectClient>> }> {
  const profile = over.profile ?? 'agent'
  const agentSigner = profile === 'agent' ? await generateKeyPairSigner() : undefined
  const handle = createServer({
    config: baseConfig({ profile, owner: OWNER as Config['owner'], ...over }),
    log: silentLogger,
    client: stubClient(clientOver),
    ...(agentSigner ? { agentSigner } : {}),
  })
  await handle.refreshSwap()
  return { handle, client: await connectClient(handle) }
}
