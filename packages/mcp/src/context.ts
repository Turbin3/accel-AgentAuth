import { readFileSync } from 'node:fs'
import type { Address } from '@solana/kit'
import { createClient, programIds, type Client, type Plan } from '@agentauth-sol/sdk'
import type { KeyPairSigner } from '@solana/kit'
import type { Config } from './config'
import { IdempotencyStore, RateLimiter } from './guards'
import type { Logger } from './log'
import { safeString } from './sanitize'

/** Everything a tool handler needs. Built once per server. */
export interface Context {
  readonly config: Config
  readonly client: Client
  readonly log: Logger
  /** Agent profile only. */
  readonly agentSigner: KeyPairSigner | undefined
  /** `--unsafe-dev-sign` only. */
  readonly ownerSigner: KeyPairSigner | undefined
  readonly labels: ReadonlyMap<string, string>
  readonly idempotency: IdempotencyStore
  readonly payLimiter: RateLimiter
  readonly callLimiter: RateLimiter
  /** Plans built in this process, for `owner_dev_sign_and_send` only. */
  readonly plans: Map<string, Plan>
  readonly now: () => number
  /** Run `work` with the configured timeout. Rejects with {@link TimeoutError}. */
  withTimeout<T>(work: Promise<T>, what: string, ms?: number): Promise<T>
  decimalsOf(mint: Address): Promise<number>
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

export interface ContextParts {
  readonly config: Config
  readonly log: Logger
  readonly agentSigner?: KeyPairSigner
  readonly ownerSigner?: KeyPairSigner
  readonly client?: Client
  readonly now?: () => number
}

function readLabels(path: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!path) return out
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [address, label] of Object.entries(parsed)) {
        if (typeof label === 'string' && label.length > 0) out.set(address, safeString(label, 40))
      }
    }
  } catch {
    throw new Error('cannot read the --labels file (expected JSON {"<token account>": "label"})')
  }
  return out
}

/** Build the shared context (client, guards, labels). Performs no network call. */
export function createContext(parts: ContextParts): Context {
  const { config } = parts
  const client =
    parts.client ??
    createClient({
      cluster: config.cluster,
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.cluster === 'localnet' ? { programIds: programIds('localnet') } : {}),
      commitment: 'confirmed',
    })
  const decimals = new Map<string, number>()
  const now = parts.now ?? (() => Date.now())
  return {
    config,
    client,
    log: parts.log,
    agentSigner: parts.agentSigner,
    ownerSigner: parts.ownerSigner,
    labels: readLabels(config.labelsFile),
    idempotency: new IdempotencyStore(config.stateFile),
    payLimiter: new RateLimiter(config.maxPaysPerMinute, 60_000),
    callLimiter: new RateLimiter(config.maxCallsPerMinute, 60_000),
    plans: new Map(),
    now,
    async withTimeout<T>(work: Promise<T>, what: string, ms = config.timeoutMs): Promise<T> {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms)
        timer.unref()
      })
      try {
        return await Promise.race([work, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async decimalsOf(mint: Address): Promise<number> {
      const cached = decimals.get(mint)
      if (cached !== undefined) return cached
      const view = await client.fetchMint(mint)
      if (!view) throw new Error('the token mint account does not exist')
      decimals.set(mint, view.decimals)
      return view.decimals
    },
  }
}
