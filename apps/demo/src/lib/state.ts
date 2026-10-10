import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isAddress, type Address } from '@solana/kit'
import { WALLET_ROLES, type WalletRole } from './keys'
import { stateFile } from './paths'

/** Public description of a demo mint. */
export interface MintInfo {
  readonly address: Address
  readonly symbol: string
  readonly name: string
  readonly decimals: number
  /** Always the `harness` wallet. */
  readonly mintAuthority: Address
}

/**
 * Everything `bootstrap` creates, by public address. This is the content of `.demo/state.json`
 * and contains NO secret: keys live in `.demo/keys/*.json` and are loaded with `loadSigner`.
 */
export interface DemoState {
  readonly version: 1
  readonly network: 'localnet'
  readonly rpcUrl: string
  readonly wsUrl: string
  /** Genesis hash of the validator bootstrapped against; a new ledger changes it. */
  readonly genesisHash: string
  readonly wallets: Readonly<Record<WalletRole, Address>>
  readonly mints: { readonly dusd: MintInfo; readonly dout: MintInfo }
  /** Token accounts; ATAs except `attackerDusdB` (a plain keypair account, see the control beat). */
  readonly tokenAccounts: {
    /** Owner's DUSD account: the relay `source_account`, also the swap `in_account`. */
    readonly ownerDusd: Address
    /** Owner's DOUT account: the swap `out_account`. */
    readonly ownerDout: Address
    /** Alice's DUSD account: the allowlisted recipient. */
    readonly recipientDusd: Address
    readonly attackerDusd: Address
    /** A second attacker DUSD account, used only by the control beat (keeps `attackerDusd` at 0). */
    readonly attackerDusdB: Address
    readonly attackerDout: Address
    readonly hotDusd: Address
    readonly harnessDusd: Address
    readonly harnessDout: Address
    /**
     * A second DUSD account owned by the owner (a plain keypair account), used only by the dashboard
     * simulator so its mandates never replace the SPL delegate of `ownerDusd`. Absent in state files
     * written before it existed: run bootstrap again.
     */
    readonly simulatorDusd?: Address
  }
  /** The mock-AMM pool (Raydium CP-Swap ABI, constant product, mode NORMAL). Test/demo only. */
  readonly pool: {
    readonly state: Address
    /** Pool authority PDA `["mock_amm_auth"]`: token owner of both vaults. */
    readonly authority: Address
    readonly config: Address
    readonly observation: Address
    /** DUSD vault (the input side of a DUSD -> DOUT swap). */
    readonly vaultDusd: Address
    /** DOUT vault (the output side). */
    readonly vaultDout: Address
    /** Reserves minted into the vaults when the pool was created, raw base units as decimal strings. */
    readonly initialReserves: { readonly dusd: string; readonly dout: string }
  }
  /** gated-example config PDA (initialised with `owner` as the honoured mandate owner). */
  readonly gated: { readonly config: Address }
  /** Balances minted when each account was first created, raw base units as decimal strings. */
  readonly initialBalances: {
    readonly ownerDusd: string
    readonly hotDusd: string
    readonly harnessDusd: string
  }
}

const MINT_KEYS = ['address', 'symbol', 'name', 'decimals', 'mintAuthority'] as const
const TOKEN_ACCOUNT_KEYS = [
  'ownerDusd',
  'ownerDout',
  'recipientDusd',
  'attackerDusd',
  'attackerDusdB',
  'attackerDout',
  'hotDusd',
  'harnessDusd',
  'harnessDout',
] as const
const POOL_ADDRESS_KEYS = [
  'state',
  'authority',
  'config',
  'observation',
  'vaultDusd',
  'vaultDout',
] as const

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${stateFile()}: ${path} must be an object`)
  }
  return v as Record<string, unknown>
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new Error(`${stateFile()}: ${path} must be a string`)
  return v
}
function addr(v: unknown, path: string): Address {
  const s = str(v, path)
  if (!isAddress(s)) throw new Error(`${stateFile()}: ${path} is not a valid address`)
  return s
}
function uintString(v: unknown, path: string): string {
  const s = str(v, path)
  if (!/^[0-9]+$/.test(s))
    throw new Error(`${stateFile()}: ${path} must be a decimal integer string`)
  return s
}
function mint(v: unknown, path: string): MintInfo {
  const o = obj(v, path)
  for (const k of MINT_KEYS) if (!(k in o)) throw new Error(`${stateFile()}: ${path}.${k} missing`)
  const decimals = o['decimals']
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    throw new Error(`${stateFile()}: ${path}.decimals must be an integer 0..9`)
  }
  return {
    address: addr(o['address'], `${path}.address`),
    symbol: str(o['symbol'], `${path}.symbol`),
    name: str(o['name'], `${path}.name`),
    decimals,
    mintAuthority: addr(o['mintAuthority'], `${path}.mintAuthority`),
  }
}

/** Validate untrusted JSON as a {@link DemoState} (throws a message naming the bad field). */
export function parseDemoState(json: unknown): DemoState {
  const o = obj(json, 'state')
  if (o['version'] !== 1)
    throw new Error(`${stateFile()}: unsupported state version ${String(o['version'])}`)
  if (o['network'] !== 'localnet') throw new Error(`${stateFile()}: network must be "localnet"`)

  const wallets = obj(o['wallets'], 'wallets')
  const tokenAccounts = obj(o['tokenAccounts'], 'tokenAccounts')
  const mints = obj(o['mints'], 'mints')
  const pool = obj(o['pool'], 'pool')
  const reserves = obj(pool['initialReserves'], 'pool.initialReserves')
  const gated = obj(o['gated'], 'gated')
  const balances = obj(o['initialBalances'], 'initialBalances')

  return {
    version: 1,
    network: 'localnet',
    rpcUrl: str(o['rpcUrl'], 'rpcUrl'),
    wsUrl: str(o['wsUrl'], 'wsUrl'),
    genesisHash: str(o['genesisHash'], 'genesisHash'),
    wallets: Object.fromEntries(
      WALLET_ROLES.map((r) => [r, addr(wallets[r], `wallets.${r}`)]),
    ) as Record<WalletRole, Address>,
    mints: { dusd: mint(mints['dusd'], 'mints.dusd'), dout: mint(mints['dout'], 'mints.dout') },
    tokenAccounts: {
      ...(Object.fromEntries(
        TOKEN_ACCOUNT_KEYS.map((k) => [k, addr(tokenAccounts[k], `tokenAccounts.${k}`)]),
      ) as Omit<DemoState['tokenAccounts'], 'simulatorDusd'>),
      ...(tokenAccounts['simulatorDusd'] === undefined
        ? {}
        : { simulatorDusd: addr(tokenAccounts['simulatorDusd'], 'tokenAccounts.simulatorDusd') }),
    },
    pool: {
      ...(Object.fromEntries(POOL_ADDRESS_KEYS.map((k) => [k, addr(pool[k], `pool.${k}`)])) as Pick<
        DemoState['pool'],
        (typeof POOL_ADDRESS_KEYS)[number]
      >),
      initialReserves: {
        dusd: uintString(reserves['dusd'], 'pool.initialReserves.dusd'),
        dout: uintString(reserves['dout'], 'pool.initialReserves.dout'),
      },
    },
    gated: { config: addr(gated['config'], 'gated.config') },
    initialBalances: {
      ownerDusd: uintString(balances['ownerDusd'], 'initialBalances.ownerDusd'),
      hotDusd: uintString(balances['hotDusd'], 'initialBalances.hotDusd'),
      harnessDusd: uintString(balances['harnessDusd'], 'initialBalances.harnessDusd'),
    },
  }
}

/** Read and validate `.demo/state.json`. */
export async function readState(): Promise<DemoState> {
  let text: string
  try {
    text = await readFile(stateFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `no demo environment at ${stateFile()}; run scripts/localnet.sh start, then \`pnpm --filter @agentauth-sol/demo bootstrap\``,
      )
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${stateFile()} is not valid JSON; delete it and bootstrap again`)
  }
  return parseDemoState(json)
}

/** Write `.demo/state.json` atomically (temp file + rename). */
export async function writeState(state: DemoState): Promise<void> {
  const path = stateFile()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}
