import { parseArgs } from 'node:util'
import { isAddress, type Address } from '@solana/kit'
import type { Cluster } from '@agentauth-sol/sdk'
import type { LogLevel } from './log'

export const PROFILES = ['agent', 'owner', 'observer'] as const
export type Profile = (typeof PROFILES)[number]

/** Genesis hash of Solana mainnet-beta; `--unsafe-dev-sign` refuses an RPC that reports it. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/** Validated server configuration. Contains paths, never key material. */
export interface Config {
  readonly profile: Profile
  readonly cluster: Cluster
  readonly rpcUrl: string | undefined
  /** The owner every owner-profile plan is built for / the only owner an agent trusts. */
  readonly owner: Address | undefined
  /** Owner profile: the default agent. */
  readonly agent: Address | undefined
  /** Agent profile: path of the agent keypair file (a Solana CLI JSON array). */
  readonly agentKeypairPath: string | undefined
  /** Owner profile, demo only: path of the owner keypair for `--unsafe-dev-sign`. */
  readonly ownerKeypairPath: string | undefined
  readonly unsafeDevSign: boolean
  /** Agent profile: send a transaction even when the pre-flight predicts a denial (attack demos). */
  readonly landDenied: boolean
  readonly stateFile: string | undefined
  readonly labelsFile: string | undefined
  /** Optional hard client-side cap for one payment, in token units (decimal string). */
  readonly maxAmount: string | undefined
  readonly maxPaysPerMinute: number
  readonly maxCallsPerMinute: number
  readonly duplicateWindowSeconds: number
  readonly timeoutMs: number
  readonly logLevel: LogLevel
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export const USAGE = `agentauth-mcp: MCP server for AgentAuth mandates on Solana (unaudited devnet prototype)

Usage: agentauth-mcp --profile <agent|owner|observer> [options]

  --profile <p>              agent: holds ONLY the agent key; owner: builds UNSIGNED plans; observer: read-only
  --cluster <c>              localnet | devnet (default devnet). mainnet-beta is not deployed.
  --rpc-url <url>            RPC endpoint (env AGENTAUTH_RPC_URL or AA_RPC_URL)
  --owner <address>          trusted owner wallet (env AGENTAUTH_OWNER); required for agent and owner profiles
  --agent <address>          owner profile: default agent (env AGENTAUTH_AGENT)
  --agent-keypair <path>     agent profile: keypair file (env AGENTAUTH_AGENT_KEYPAIR, preferred)
  --state-file <path>        agent profile: persist idempotency keys across restarts
  --labels <path>            JSON {"<token account>": "label"} for allowed recipients
  --max-amount <decimal>     agent profile: extra client-side cap per payment, in token units
  --max-pays-per-minute <n>  agent profile rate limit (default 5)
  --max-calls-per-minute <n> all tools rate limit (default 120)
  --duplicate-window <sec>   refuse an identical payment inside this window (default 60)
  --timeout-ms <n>           RPC timeout (default 20000)
  --log-level <l>            debug | info | warn | error | silent (default info; logs go to stderr)
  --land-denied              agent profile, demos: send even when the pre-flight predicts a denial
  --unsafe-dev-sign          owner profile, demos ONLY: sign plans with AGENTAUTH_OWNER_KEYPAIR. Never on mainnet.
`

function address(label: string, value: string | undefined): Address | undefined {
  if (value === undefined || value === '') return undefined
  if (!isAddress(value)) throw new ConfigError(`${label} is not a valid base58 address`)
  return value
}

function positiveInt(
  label: string,
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback
  if (!/^\d{1,9}$/.test(value)) throw new ConfigError(`${label} must be a whole number`)
  const n = Number(value)
  if (n < 1 || n > max) throw new ConfigError(`${label} must be between 1 and ${max}`)
  return n
}

/**
 * Parse argv and environment into a {@link Config}. Throws {@link ConfigError} (message safe to
 * print) for anything inconsistent: a missing key for the profile, an owner key where it must not
 * be, `--unsafe-dev-sign` on the wrong profile or on mainnet.
 */
export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        profile: { type: 'string' },
        cluster: { type: 'string' },
        'rpc-url': { type: 'string' },
        owner: { type: 'string' },
        agent: { type: 'string' },
        'agent-keypair': { type: 'string' },
        'state-file': { type: 'string' },
        labels: { type: 'string' },
        'max-amount': { type: 'string' },
        'max-pays-per-minute': { type: 'string' },
        'max-calls-per-minute': { type: 'string' },
        'duplicate-window': { type: 'string' },
        'timeout-ms': { type: 'string' },
        'log-level': { type: 'string' },
        'land-denied': { type: 'boolean' },
        'unsafe-dev-sign': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }).values
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : 'bad arguments')
  }

  const profile = values['profile']
  if (typeof profile !== 'string' || !(PROFILES as readonly string[]).includes(profile)) {
    throw new ConfigError('--profile must be one of: agent, owner, observer')
  }
  const p = profile as Profile

  const cluster = (values['cluster'] as string | undefined) ?? env['AGENTAUTH_CLUSTER'] ?? 'devnet'
  if (!['localnet', 'devnet', 'mainnet-beta'].includes(cluster)) {
    throw new ConfigError('--cluster must be localnet or devnet')
  }
  const unsafeDevSign = values['unsafe-dev-sign'] === true
  const landDenied = values['land-denied'] === true
  if (unsafeDevSign && p !== 'owner') {
    throw new ConfigError('--unsafe-dev-sign exists only for --profile owner')
  }
  if (unsafeDevSign && cluster === 'mainnet-beta') {
    throw new ConfigError('--unsafe-dev-sign is refused on mainnet-beta')
  }
  if (landDenied && p !== 'agent')
    throw new ConfigError('--land-denied exists only for --profile agent')

  const owner = address(
    '--owner',
    (values['owner'] as string | undefined) ?? env['AGENTAUTH_OWNER'],
  )
  const agent = address(
    '--agent',
    (values['agent'] as string | undefined) ?? env['AGENTAUTH_AGENT'],
  )
  const agentKeypairPath =
    (values['agent-keypair'] as string | undefined) ?? env['AGENTAUTH_AGENT_KEYPAIR']
  const ownerKeypairPath = unsafeDevSign ? env['AGENTAUTH_OWNER_KEYPAIR'] : undefined

  if (p === 'agent') {
    if (!agentKeypairPath)
      throw new ConfigError('agent profile needs AGENTAUTH_AGENT_KEYPAIR (a path)')
    if (!owner)
      throw new ConfigError('agent profile needs --owner / AGENTAUTH_OWNER (the owner you trust)')
    if (env['AGENTAUTH_OWNER_KEYPAIR']) {
      throw new ConfigError(
        'AGENTAUTH_OWNER_KEYPAIR is set in the environment of an agent-profile server: refusing to start (the agent process must never see the owner key)',
      )
    }
  } else if (agentKeypairPath && values['agent-keypair'] !== undefined) {
    throw new ConfigError('--agent-keypair exists only for --profile agent')
  }
  if (p === 'owner' && !owner)
    throw new ConfigError('owner profile needs --owner / AGENTAUTH_OWNER')
  if (unsafeDevSign && !ownerKeypairPath) {
    throw new ConfigError('--unsafe-dev-sign needs AGENTAUTH_OWNER_KEYPAIR (a path)')
  }

  const level = (values['log-level'] as string | undefined) ?? env['AGENTAUTH_LOG'] ?? 'info'
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
    throw new ConfigError('--log-level must be debug, info, warn, error or silent')
  }
  const maxAmount = values['max-amount'] as string | undefined
  if (maxAmount !== undefined && !/^\d{1,30}(\.\d{1,18})?$/.test(maxAmount)) {
    throw new ConfigError('--max-amount must be a decimal number')
  }

  return {
    profile: p,
    cluster: cluster as Cluster,
    rpcUrl:
      (values['rpc-url'] as string | undefined) ?? env['AGENTAUTH_RPC_URL'] ?? env['AA_RPC_URL'],
    owner,
    agent,
    agentKeypairPath: p === 'agent' ? agentKeypairPath : undefined,
    ownerKeypairPath,
    unsafeDevSign,
    landDenied,
    stateFile: values['state-file'] as string | undefined,
    labelsFile: values['labels'] as string | undefined,
    maxAmount,
    maxPaysPerMinute: positiveInt(
      '--max-pays-per-minute',
      values['max-pays-per-minute'] as string | undefined,
      5,
      1000,
    ),
    maxCallsPerMinute: positiveInt(
      '--max-calls-per-minute',
      values['max-calls-per-minute'] as string | undefined,
      120,
      100000,
    ),
    duplicateWindowSeconds: positiveInt(
      '--duplicate-window',
      values['duplicate-window'] as string | undefined,
      60,
      86400,
    ),
    timeoutMs: positiveInt(
      '--timeout-ms',
      values['timeout-ms'] as string | undefined,
      20000,
      120000,
    ),
    logLevel: level as LogLevel,
  }
}
