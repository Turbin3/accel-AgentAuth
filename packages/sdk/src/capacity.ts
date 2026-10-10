import { nowSeconds, toSeconds } from './bytes'
import { SWAP_BASE_INPUT_DISC, TRANSFER_CHECKED_DISC } from './constants'
import { delegationBlocker, errName, relayBlocker, type DelegationInfo } from './explain'
import type { Mandate, RelayPolicy } from './types'

/** What limits a relay payment right now. */
export type LimitedBy = 'per_call_limit' | 'mandate_budget' | 'delegation' | 'balance'

/** Result of {@link capacity}. */
export interface Capacity {
  /** Largest raw-unit amount a relay payment could move right now; `0n` when blocked. */
  readonly maxSpendNow: bigint
  /** The binding limits (all that equal the minimum). Empty when blocked or nothing is bounded. */
  readonly limitedBy: readonly LimitedBy[]
  /** Why nothing can move at all, or `null`. */
  readonly blockedBy: {
    readonly program: string
    readonly code: number
    readonly name: string
    readonly why: string
  } | null
  /** Each bound separately (`null` = unbounded or unknown). */
  readonly bounds: {
    readonly perCall: bigint | null
    readonly mandateBudget: bigint | null
    readonly delegation: bigint | null
    readonly balance: bigint | null
  }
  /** True when the delegation or balance was not provided, so the figure may be too high. */
  readonly partial: boolean
}

/** Live facts about the source token account. */
export interface CapacityLive {
  readonly delegation?: DelegationInfo | null
  readonly balance?: bigint | null
  /** Unix seconds; defaults to the wall clock. */
  readonly now?: bigint | number
}

/**
 * Structured "how much can the agent move through the relay right now" (min of the per-call limit,
 * the remaining lifetime budget, the SPL delegated amount and the source balance), or the exact
 * error that blocks it. `action` selects the relay transfer (default) or swap slot.
 *
 * It mirrors the pre-flight order but cannot see the AMM, the destination account or other
 * transactions that race for the same budget: it is an upper bound, never a promise.
 *
 * @example
 * const c = capacity(mandate, policy, { delegation, balance })
 * if (c.blockedBy) tell(c.blockedBy.name) else console.log(c.maxSpendNow, c.limitedBy)
 */
export function capacity(
  mandate: Mandate,
  policy: RelayPolicy | null,
  live: CapacityLive = {},
  action: 'transfer' | 'swap' = 'transfer',
): Capacity {
  const empty = { perCall: null, mandateBudget: null, delegation: null, balance: null }
  const blocked = (program: string, code: number, why: string, name: string): Capacity => ({
    maxSpendNow: 0n,
    limitedBy: [],
    blockedBy: { program, code, name, why },
    bounds: empty,
    partial: false,
  })
  const now = live.now === undefined ? nowSeconds() : toSeconds(live.now, 'now')
  if (!mandate.active) {
    return blocked('agent_auth', 4, 'the mandate is paused', errName('agent_auth', 4))
  }
  if (now >= mandate.expiry) {
    return blocked('agent_auth', 5, 'the mandate has expired', errName('agent_auth', 5))
  }
  if (!policy) {
    return blocked('relay', 101, 'no relay policy exists for this mandate', errName('relay', 101))
  }
  if (action === 'transfer' && policy.recipients.length === 0) {
    return blocked('relay', 104, 'the policy allowlists no recipient', errName('relay', 104))
  }
  if (action === 'swap' && !policy.swap) {
    return blocked('relay', 110, 'swaps are disabled in this policy', errName('relay', 110))
  }
  const slotProgram =
    action === 'swap'
      ? (policy.swap as { ammProgram: typeof policy.owner }).ammProgram
      : policy.tokenProgram
  const disc = action === 'swap' ? SWAP_BASE_INPUT_DISC : TRANSFER_CHECKED_DISC
  const delegation = live.delegation === undefined ? undefined : live.delegation
  const sameAccount = action === 'transfer' || policy.swap?.inAccount === policy.sourceAccount
  const dBlock = sameAccount ? delegationBlocker(policy, delegation) : undefined
  const b = relayBlocker(mandate, policy, mandate.address, slotProgram, disc, dBlock ?? null)
  if (b) return blocked(b.program, b.code, b.why, errName(b.program, b.code))

  const slot = mandate.permissions.find((p) => p.program === slotProgram)
  const perCall = slot && !slot.perTxUnlimited ? slot.perTxLimit : null
  const budget =
    slot && !slot.spendUnlimited
      ? slot.spendLimit - (slot.spendTotal < slot.spendLimit ? slot.spendTotal : slot.spendLimit)
      : null
  const delegated = sameAccount && delegation ? delegation.delegatedAmount : null
  const balance = live.balance ?? null
  const bounds = { perCall, mandateBudget: budget, delegation: delegated, balance }
  const entries: [LimitedBy, bigint][] = []
  if (perCall !== null) entries.push(['per_call_limit', perCall])
  if (budget !== null) entries.push(['mandate_budget', budget])
  if (delegated !== null) entries.push(['delegation', delegated])
  if (balance !== null) entries.push(['balance', balance])
  let min: bigint | null = null
  for (const [, v] of entries) if (min === null || v < min) min = v
  const U64 = (1n << 64n) - 1n
  return {
    maxSpendNow: min ?? U64,
    limitedBy: min === null ? [] : entries.filter(([, v]) => v === min).map(([k]) => k),
    blockedBy: null,
    bounds,
    partial: (sameAccount && delegation === undefined) || live.balance === undefined,
  }
}
