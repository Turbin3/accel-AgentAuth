import { TOKEN_PROGRAM_ID, type Client } from '@agentauth-sol/sdk'
import { address, type Address } from '@solana/kit'
import type { TokenAccountInfo } from './wizard'

interface ParsedTokenAccount {
  readonly pubkey: string
  readonly account: {
    readonly data: {
      readonly parsed?: {
        readonly info?: {
          readonly mint?: string
          readonly delegate?: string
          readonly delegatedAmount?: { readonly amount?: string }
          readonly tokenAmount?: { readonly amount?: string; readonly decimals?: number }
        }
      }
    }
  }
}

/** The owner's classic SPL token accounts with balance and current delegate (jsonParsed RPC). */
export async function loadOwnerTokenAccounts(
  client: Client,
  owner: Address,
  signal?: AbortSignal,
): Promise<TokenAccountInfo[]> {
  const res = await client.rpc
    .getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' })
    .send({ abortSignal: signal })
  const out: TokenAccountInfo[] = []
  for (const item of res.value as unknown as ParsedTokenAccount[]) {
    const info = item.account.data.parsed?.info
    const mint = info?.mint
    const amount = info?.tokenAmount?.amount
    const decimals = info?.tokenAmount?.decimals
    if (!mint || amount === undefined || decimals === undefined) continue
    out.push({
      address: address(item.pubkey),
      mint: address(mint),
      decimals,
      amount: BigInt(amount),
      delegate: info?.delegate ? address(info.delegate) : null,
      delegatedAmount: BigInt(info?.delegatedAmount?.amount ?? '0'),
    })
  }
  return out.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
}

/** Public addresses of the bootstrapped localnet demo, as served by /api/demo. */
export interface DemoInfo {
  readonly available: boolean
  readonly reason: string | null
  readonly problems: readonly string[]
  readonly wallets?: Readonly<
    Record<'owner' | 'agent' | 'attacker' | 'recipient' | 'harness' | 'hot', Address>
  >
  readonly mints?: {
    readonly dusd: { readonly address: Address; readonly symbol: string; readonly decimals: number }
    readonly dout: { readonly address: Address; readonly symbol: string; readonly decimals: number }
  }
  readonly tokenAccounts?: Readonly<Record<string, Address>>
  readonly pool?: {
    readonly state: Address
    readonly authority: Address
    readonly config: Address
    readonly observation: Address
    readonly vaultDusd: Address
    readonly vaultDout: Address
  }
}

export async function fetchDemoInfo(signal?: AbortSignal): Promise<DemoInfo> {
  const res = await fetch('/api/demo', { cache: 'no-store', ...(signal ? { signal } : {}) })
  if (!res.ok)
    return { available: false, reason: 'No demo environment on this cluster.', problems: [] }
  return (await res.json()) as DemoInfo
}

/** Browser-local labels for addresses ("Alice"): a per-viewer convenience, never sent anywhere. */
const LABEL_KEY = 'aa.labels.v1'

export function readLabels(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LABEL_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function saveLabels(labels: Readonly<Record<string, string>>): void {
  try {
    window.localStorage.setItem(LABEL_KEY, JSON.stringify({ ...readLabels(), ...labels }))
  } catch {
    // labels are a convenience; losing them changes nothing on chain
  }
}
