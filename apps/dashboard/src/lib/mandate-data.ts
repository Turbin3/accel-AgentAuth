import {
  mandatePda,
  type Client,
  type Mandate,
  type MandateView,
  type MintView,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'

/** A mandate as the pages show it: the SDK view plus the decimals needed for human units. */
export interface MandateDetail {
  readonly address: Address
  readonly mandate: Mandate
  readonly view: MandateView
  readonly budgetMint: MintView | null
  /** Decimals of a permission slot's unit, or null when the unit is unknown (raw units are shown). */
  readonly decimalsFor: (program: Address) => number | null
}

export async function loadMandateDetail(
  client: Client,
  address: Address,
  known?: Mandate,
): Promise<MandateDetail | null> {
  const view = await client.inspect(address, known ? { mandate: known } : undefined)
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
  return { address, mandate: view.mandate, view, budgetMint, decimalsFor }
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
