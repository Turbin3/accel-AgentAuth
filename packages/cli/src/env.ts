import { createInterface } from 'node:readline/promises'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from '@solana/kit'
import {
  createClient,
  parseAddress,
  type Client,
  type Cluster,
  type CreateClientOptions,
} from '@agentauth-sol/sdk'
import { CliError, usageError } from './errors'
import { Out, type Sink } from './output'

export interface GlobalOpts {
  cluster?: Cluster
  url?: string
  keypair?: string
  agentKeypair?: string
  json?: boolean
  yes?: boolean
  simulate?: boolean
  /** commander stores `--no-color` as `color: false`. */
  color?: boolean
  raw?: boolean
  iUnderstandThisIsUnaudited?: boolean
}

/** Everything the CLI takes from the machine. Tests replace it; production uses {@link defaultDeps}. */
export interface Deps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly stdout: Sink
  readonly stderr: Sink
  readonly stdinIsTTY: boolean
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly readFile: (path: string) => Promise<string>
  readonly readStdin: () => Promise<string>
  readonly loadKeypair: (path: string) => Promise<KeyPairSigner>
  readonly createClient: (opts: CreateClientOptions) => Client
  readonly confirm: (question: string) => Promise<boolean>
  /** Upper bound of polls for `activity --follow` (undefined = until Ctrl-C). */
  readonly maxFollowPolls?: number
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readFile: (path) => readFile(path, 'utf8'),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks).toString('utf8')
    },
    loadKeypair: loadKeypairFile,
    createClient: (opts) => createClient(opts),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = await rl.question(`${question} [y/N] `)
        return /^y(es)?$/i.test(answer.trim())
      } finally {
        rl.close()
      }
    },
  }
}

/** Load a Solana CLI keypair file (JSON array of 64 bytes). Error messages never contain key bytes. */
export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    throw usageError(
      missing ? `keypair file not found: ${path}` : `cannot read keypair file: ${path}`,
      'Pass --keypair <path> (a Solana CLI keypair JSON file). Read-only commands do not need one.',
    )
  }
  let bytes: Uint8Array
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error('shape')
    }
    bytes = Uint8Array.from(parsed as number[])
  } catch {
    throw usageError(`${path} is not a Solana keypair file (expected a JSON array of 64 bytes)`)
  }
  try {
    return await createKeyPairSignerFromBytes(bytes)
  } catch {
    throw usageError(`${path} does not contain a valid ed25519 keypair`)
  } finally {
    bytes.fill(0)
  }
}

// ---------------------------------------------------------------------------------------------
// Demo state (written by `pnpm --filter @agentauth-sol/demo bootstrap`)
// ---------------------------------------------------------------------------------------------

export interface DemoState {
  readonly rpcUrl: string
  readonly wallets: Readonly<Record<string, string>>
  readonly mints: Readonly<Record<string, { address: string; symbol: string; decimals: number }>>
  readonly tokenAccounts: Readonly<Record<string, string>>
  readonly pool: Readonly<Record<string, string>>
}

export interface DemoInfo {
  readonly dir: string
  readonly state: DemoState
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Find the demo directory: `AA_DEMO_DIR`, else the nearest `.demo` above the working directory. */
export async function findDemo(deps: Deps): Promise<DemoInfo | null> {
  const override = deps.env['AA_DEMO_DIR']
  const candidates: string[] = []
  if (override !== undefined && override.length > 0) candidates.push(resolve(deps.cwd, override))
  else {
    let dir = resolve(deps.cwd)
    for (let i = 0; i < 12; i++) {
      candidates.push(join(dir, '.demo'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const dir of candidates) {
    const file = join(dir, 'state.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await deps.readFile(file))
    } catch {
      continue
    }
    if (!isRecord(parsed) || !isRecord(parsed['wallets']) || typeof parsed['rpcUrl'] !== 'string') {
      continue
    }
    return {
      dir,
      state: {
        rpcUrl: parsed['rpcUrl'],
        wallets: parsed['wallets'] as Record<string, string>,
        mints: (isRecord(parsed['mints']) ? parsed['mints'] : {}) as DemoState['mints'],
        tokenAccounts: (isRecord(parsed['tokenAccounts']) ? parsed['tokenAccounts'] : {}) as Record<
          string,
          string
        >,
        pool: (isRecord(parsed['pool']) ? parsed['pool'] : {}) as Record<string, string>,
      },
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Mint symbols
// ---------------------------------------------------------------------------------------------

export interface KnownMint {
  readonly address: string
  readonly symbol: string
  readonly decimals: number | undefined
}

/** Symbols of well-known mints (the registry's mints.json for the cluster, plus the demo mints). */
export class SymbolBook {
  private readonly byAddress = new Map<string, KnownMint>()
  private readonly bySymbol = new Map<string, KnownMint>()

  add(mint: KnownMint): void {
    this.byAddress.set(mint.address, mint)
    this.bySymbol.set(mint.symbol.toLowerCase(), mint)
  }
  symbolOf(address: string): string | undefined {
    return this.byAddress.get(address)?.symbol
  }
  decimalsOf(address: string): number | undefined {
    return this.byAddress.get(address)?.decimals
  }
  resolve(symbol: string): KnownMint | undefined {
    return this.bySymbol.get(symbol.toLowerCase())
  }
  all(): KnownMint[] {
    return [...this.byAddress.values()]
  }
}

async function registryMints(cluster: Cluster, deps: Deps): Promise<KnownMint[]> {
  if (cluster === 'localnet') return []
  try {
    const pkg = createRequire(import.meta.url).resolve('@agentauth-sol/registry/package.json')
    const parsed: unknown = JSON.parse(
      await deps.readFile(join(dirname(pkg), 'data', 'mints.json')),
    )
    if (!isRecord(parsed) || !Array.isArray(parsed['mints'])) return []
    const out: KnownMint[] = []
    for (const m of parsed['mints'] as unknown[]) {
      if (!isRecord(m) || typeof m['symbol'] !== 'string' || !isRecord(m['clusters'])) continue
      const entry = m['clusters'][cluster]
      if (!isRecord(entry) || typeof entry['address'] !== 'string') continue
      out.push({
        address: entry['address'],
        symbol: m['symbol'],
        decimals: typeof entry['decimals'] === 'number' ? entry['decimals'] : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export interface Ctx {
  readonly deps: Deps
  readonly out: Out
  readonly opts: GlobalOpts
  readonly cluster: Cluster
  readonly rpcUrl: string | undefined
  readonly client: Client
  readonly demo: DemoInfo | null
  /** True when the cluster is localnet and a bootstrapped demo environment was found. */
  readonly demoMode: boolean
  readonly symbols: SymbolBook
  /** Parse an address; `@name` resolves a demo-environment alias (`@owner`, `@recipientDusd`, ...). */
  address(input: string, field?: string): Address
  ownerSigner(): Promise<KeyPairSigner>
  agentSigner(): Promise<KeyPairSigner>
  /** Owner address: explicit flag, else the owner keypair, else the demo owner. */
  ownerAddress(explicit?: string): Promise<Address | undefined>
  agentAddress(explicit?: string): Promise<Address | undefined>
  explorerTx(signature: string): string
  explorerAddress(address: string): string
  /** Ask for confirmation. `--yes` skips; a non-interactive terminal without `--yes` refuses. */
  confirm(question: string): Promise<boolean>
  nowSeconds(): Promise<bigint>
}

export const UNAUDITED =
  'AgentAuth is an unaudited prototype. Hard enforcement exists only for the relay transfer and the pinned swap; everything else is advisory.'

/** Resolve the global options into a ready context. */
export async function makeCtx(deps: Deps, opts: GlobalOpts): Promise<Ctx> {
  const json = opts.json === true
  const tty = deps.stdout.isTTY === true
  const color =
    opts.color !== false && !json && tty && !deps.env['NO_COLOR'] && deps.env['TERM'] !== 'dumb'
  const out = new Out(deps.stdout, deps.stderr, { json, color })

  const demo = await findDemo(deps)
  const cluster: Cluster = opts.cluster ?? (demo !== null ? 'localnet' : 'devnet')
  if (cluster === 'mainnet-beta') {
    if (opts.iUnderstandThisIsUnaudited !== true) {
      throw usageError(
        'mainnet-beta is refused: AgentAuth is an unaudited prototype and is not deployed on mainnet',
        'Pass --i-understand-this-is-unaudited to proceed anyway (read-only inspection of your own program ids).',
      )
    }
    out.note(
      out.warn(
        'MAINNET: AgentAuth is an UNAUDITED prototype and is not deployed on mainnet-beta. Do not put real funds behind it.',
      ),
    )
  }
  const demoMode = cluster === 'localnet' && demo !== null

  let rpcUrl = opts.url
  if (rpcUrl === undefined && cluster === 'localnet') {
    rpcUrl = deps.env['AA_RPC_URL'] ?? demo?.state.rpcUrl ?? 'http://127.0.0.1:8899'
  }
  // Built on first use: commands that never touch the chain (lint, registry) need no client.
  let cachedClient: Client | undefined
  const clientOf = (): Client =>
    (cachedClient ??= deps.createClient({
      cluster,
      ...(rpcUrl === undefined ? {} : { rpcUrl }),
      commitment: 'confirmed',
      ...(cluster === 'mainnet-beta' ? { acknowledgeNoMainnet: true } : {}),
    }))

  const symbols = new SymbolBook()
  for (const m of await registryMints(cluster, deps)) symbols.add(m)
  if (demoMode) {
    for (const m of Object.values(demo.state.mints)) symbols.add({ ...m })
  }

  const aliasTable = new Map<string, string>()
  if (demoMode) {
    for (const group of [demo.state.wallets, demo.state.tokenAccounts, demo.state.pool]) {
      for (const [k, v] of Object.entries(group)) if (typeof v === 'string') aliasTable.set(k, v)
    }
    for (const [k, m] of Object.entries(demo.state.mints)) aliasTable.set(k, m.address)
  }

  const signerCache = new Map<string, KeyPairSigner>()
  const load = async (path: string): Promise<KeyPairSigner> => {
    const cached = signerCache.get(path)
    if (cached) return cached
    const signer = await deps.loadKeypair(path)
    signerCache.set(path, signer)
    return signer
  }
  const ownerPath = (): string | undefined =>
    opts.keypair ??
    (demoMode
      ? join(demo.dir, 'keys', 'owner.json')
      : join(homedir(), '.config', 'solana', 'id.json'))
  const agentPath = (): string | undefined =>
    opts.agentKeypair ?? (demoMode ? join(demo.dir, 'keys', 'agent.json') : undefined)

  const address = (input: string, field = 'address'): Address => {
    let value = input
    if (input.startsWith('@')) {
      const alias = aliasTable.get(input.slice(1))
      if (alias === undefined) {
        throw usageError(
          `${field}: unknown alias "${input}"`,
          aliasTable.size === 0
            ? 'Aliases exist only on localnet after `pnpm --filter @agentauth-sol/demo bootstrap`.'
            : `Known aliases: ${[...aliasTable.keys()].map((k) => `@${k}`).join(', ')}`,
        )
      }
      value = alias
    }
    try {
      return parseAddress(value)
    } catch {
      throw usageError(`${field}: "${input}" is not a valid Solana address`)
    }
  }

  return {
    deps,
    out,
    opts,
    cluster,
    rpcUrl,
    get client() {
      return clientOf()
    },
    demo,
    demoMode,
    symbols,
    address,
    async ownerSigner() {
      const path = ownerPath()
      if (path === undefined) throw usageError('no owner keypair: pass --keypair <path>')
      return load(path)
    },
    async agentSigner() {
      const path = agentPath()
      if (path === undefined) {
        throw usageError(
          'this command signs as the agent: pass --agent-keypair <path>',
          'The agent key is the one named in the mandate (never your owner key).',
        )
      }
      return load(path)
    },
    async ownerAddress(explicit) {
      if (explicit !== undefined) return address(explicit, '--owner')
      const path = ownerPath()
      if (path !== undefined) {
        try {
          return (await load(path)).address
        } catch (error) {
          if (opts.keypair !== undefined) throw error
        }
      }
      return undefined
    },
    async agentAddress(explicit) {
      if (explicit !== undefined) return address(explicit, '--agent')
      const path = agentPath()
      if (path !== undefined) {
        try {
          return (await load(path)).address
        } catch (error) {
          if (opts.agentKeypair !== undefined) throw error
        }
      }
      return undefined
    },
    explorerTx(signature) {
      return `https://explorer.solana.com/tx/${signature}${clusterQuery(cluster, rpcUrl)}`
    },
    explorerAddress(a) {
      return `https://explorer.solana.com/address/${a}${clusterQuery(cluster, rpcUrl)}`
    },
    async confirm(question) {
      if (opts.yes === true) return true
      if (!deps.stdinIsTTY) {
        throw new CliError(
          'usage',
          'confirmation required but this is not an interactive terminal',
          {
            hint: 'Re-run with --yes to confirm, or --dry-run (where available) to only preview.',
          },
        )
      }
      return deps.confirm(question)
    },
    async nowSeconds() {
      return clientOf().getClusterTime()
    },
  }
}

function clusterQuery(cluster: Cluster, rpcUrl: string | undefined): string {
  if (cluster === 'mainnet-beta') return ''
  if (cluster === 'devnet') return '?cluster=devnet'
  return `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl ?? 'http://127.0.0.1:8899')}`
}
