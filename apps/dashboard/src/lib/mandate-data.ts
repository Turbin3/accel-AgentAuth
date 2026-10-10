import {
  mandatePda,
  type Client,
  type Mandate,
  type MandateView,
  type MintView,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'
import { shortAddress } from './format'

let demoLabels: Promise<Readonly<Record<string, string>>> | null = null

/**
 * Display symbols of the localnet demo mints ("DUSD", "DOUT"), from /api/demo. Any other mint has no
 * symbol (a mint account carries none), so callers fall back to a shortened mint address. The
 * answer is cached once the server has answered; a network failure is retried on the next call.
 */
export function demoMintLabels(): Promise<Readonly<Record<string, string>>> {
  if (demoLabels) return demoLabels
  const load = async (): Promise<Readonly<Record<string, string>>> => {
    try {
      const res = await fetch('/api/demo', { cache: 'no-store' })
      if (!res.ok) return {}
      const json = (await res.json()) as {
        mints?: Record<string, { address?: string; symbol?: string }>
      }
      const out: Record<string, string> = {}
      for (const m of Object.values(json.mints ?? {})) {
        if (m.address && m.symbol) out[m.address] = m.symbol
      }
      return out
    } catch {
      demoLabels = null
      return {}
    }
  }
  demoLabels = load()
  return demoLabels
}

/** Symbol for a mint: the demo symbol, otherwise a shortened mint address. */
export function mintSymbol(mint: string, labels: Readonly<Record<string, string>>): string {
  return labels[mint] ?? shortAddress(mint)
}

/** A mandate as the pages show it: the SDK view plus the decimals needed for human units. */
export interface MandateDetail {
  readonly address: Address
  readonly mandate: Mandate
  readonly view: MandateView
  readonly budgetMint: MintView | null
  /** Symbol of the budget mint (DUSD for the demo mints, otherwise a shortened mint address); null without a relay policy. */
  readonly symbol: string | null
  /** Decimals of a permission slot's unit, or null when the unit is unknown (raw units are shown). */
  readonly decimalsFor: (program: Address) => number | null
  /** Symbol of a permission slot's unit, or null when the unit is unknown. */
  readonly unitFor: (program: Address) => string | null
}

export async function loadMandateDetail(
  client: Client,
  address: Address,
  known?: Mandate,
): Promise<MandateDetail | null> {
  const labels = await demoMintLabels()
  const view = await client.inspect(address, {
    mintLabels: labels,
    ...(known ? { mandate: known } : {}),
  })
  if (!view.mandate) return null
  const policy = view.policy
  const budgetMint = policy ? await client.fetchMint(policy.budgetMint) : null
  let swapInMint: MintView | null = null
  if (policy?.swap && policy.swap.inMint !== policy.budgetMint) {
    swapInMint = await client.fetchMint(policy.swap.inMint)
  }
  const decimalsFor = (program: Address): number | null => {
    if (!policy) return null
    if (program === policy.tokenProgram) return budgetMint?.decimals ?? null
    if (policy.swap && program === policy.swap.ammProgram) {
      return (swapInMint ?? budgetMint)?.decimals ?? null
    }
    return null
  }
  const symbol = policy ? mintSymbol(policy.budgetMint, labels) : null
  const unitFor = (program: Address): string | null => {
    if (!policy) return null
    if (program === policy.tokenProgram) return symbol
    if (policy.swap && program === policy.swap.ammProgram) {
      return mintSymbol(policy.swap.inMint, labels)
    }
    return null
  }
  return { address, mandate: view.mandate, view, budgetMint, symbol, decimalsFor, unitFor }
}

/** Every mandate owned by `owner`, newest first is not knowable on chain, so the order is stable by agent. */
export async function loadOwnerMandates(client: Client, owner: Address): Promise<MandateDetail[]> {
  const mandates = await client.mandatesByOwner(owner, { limit: 50 })
  const details = await Promise.all(
    mandates.map(async (m) => {
      const address =
        m.address ?? (await mandatePda(owner, m.agent, client.programIds.agentAuth)).address
      return loadMandateDetail(client, address, m)
    }),
  )
  return details
    .filter((d): d is MandateDetail => d !== null)
    .sort((a, b) => (a.mandate.agent < b.mandate.agent ? -1 : 1))
}

export function statusOf(detail: MandateDetail): 'active' | 'paused' | 'expired' {
  return detail.view.explanation?.status ?? (detail.mandate.active ? 'active' : 'paused')
}

/** The relay policy is paused independently of the mandate. */
export function relayPaused(detail: MandateDetail): boolean {
  return detail.view.policy?.paused === true
}
