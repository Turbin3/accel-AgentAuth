import type { Address } from '@solana/kit'
import { nowSeconds, toSeconds } from './bytes'
import { formatUnits } from './units'
import { lookupError } from './error-tables'
import { isoOfSeconds } from './time'
import {
  DEFAULT_DENY_RISKS,
  describeInstruction,
  type InstructionInfo,
  type RegistryLike,
} from './registry'
import { SWAP_BASE_INPUT_DISC, TRANSFER_CHECKED_DISC } from './constants'
import type { Mandate, Permission, RelayPolicy } from './types'

/** Enforcement level labels used by {@link Explanation.enforcement}. */
export type EnforcementLevel = 'hard (relay)' | 'advisory (integrator must call verify)'

/** Live SPL delegation on the policy source account (read it from the token account). */
export interface DelegationInfo {
  readonly delegate: Address | null
  readonly delegatedAmount: bigint
}

/** Options of {@link explainMandate}. */
export interface ExplainOptions {
  /** The relay policy bound to this mandate, if one exists. Without it nothing is hard-enforced. */
  readonly policy?: RelayPolicy | null
  /** Registry for names and risk classes. The built-in table is used as a fallback. */
  readonly registry?: RegistryLike | null
  /** "Now" for expiry maths: unix seconds (bigint/number) or a Date. Defaults to the wall clock. */
  readonly now?: bigint | number | Date
  /** Decimals of the policy budget mint, to print token amounts in human units next to raw units. */
  readonly budgetDecimals?: number
  /**
   * Live SPL delegation on the policy source account. Without it the relay payment line is labelled
   * "unverified" because the Token program, not the mandate, is the hard cap.
   */
  readonly delegation?: DelegationInfo | null
  /** Address of the mandate account; defaults to `mandate.address`. Used to check policy bindings. */
  readonly mandateAddress?: Address
}

/** One limit row of {@link Explanation.limits}. */
export interface LimitLine {
  readonly program: Address
  readonly programName: string
  readonly spendLimit: 'unlimited' | bigint
  readonly perTxLimit: 'unlimited' | bigint
  readonly spendTotal: bigint
  readonly callCount: number
  /** Lifetime budget left, or `'unlimited'`. */
  readonly remaining: 'unlimited' | bigint
  readonly text: string
}

/** Plain-English description of a mandate. */
export interface Explanation {
  readonly headline: string
  /** What the agent can do right now (empty when paused or expired). */
  readonly can: string[]
  /** What the agent is not authorised to do. */
  readonly cannot: string[]
  /** What the permissions grant when the mandate is active (independent of status). */
  readonly grants: string[]
  readonly limits: LimitLine[]
  readonly expiry: { readonly iso: string; readonly relative: string; readonly expired: boolean }
  readonly status: 'active' | 'paused' | 'expired'
  readonly enforcement: { readonly action: string; readonly level: EnforcementLevel }[]
  readonly warnings: string[]
}

const HARD: EnforcementLevel = 'hard (relay)'
const ADVISORY: EnforcementLevel = 'advisory (integrator must call verify)'

function short(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

function relativeTime(delta: bigint): string {
  const past = delta < 0n
  let s = past ? -delta : delta
  const days = s / 86400n
  s -= days * 86400n
  const hours = s / 3600n
  s -= hours * 3600n
  const minutes = s / 60n
  const seconds = s - minutes * 60n
  const parts: string[] = []
  if (days > 0n) parts.push(plural(Number(days), 'day'))
  if (hours > 0n) parts.push(plural(Number(hours), 'hour'))
  if (days === 0n && minutes > 0n) parts.push(plural(Number(minutes), 'minute'))
  if (days === 0n && hours === 0n && minutes === 0n) parts.push(plural(Number(seconds), 'second'))
  const text = parts.slice(0, 2).join(' ')
  return past ? `${text} ago` : `in ${text}`
}

function toNow(now: ExplainOptions['now']): bigint {
  if (now === undefined) return nowSeconds()
  if (now instanceof Date) return BigInt(Math.floor(now.getTime() / 1000))
  return toSeconds(now, 'now')
}

interface Ctx {
  readonly registry: RegistryLike | null | undefined
  readonly policy: RelayPolicy | null
  readonly decimals: number | undefined
}

function amountText(raw: bigint, program: Address, ctx: Ctx): string {
  if (ctx.decimals !== undefined && ctx.policy && program === ctx.policy.tokenProgram) {
    return `${formatUnits(raw, ctx.decimals)} (${raw} raw units)`
  }
  return `${raw} raw units`
}

function programLabel(permission: Permission, ctx: Ctx): string {
  const info = describeInstruction(permission.program, '00', ctx.registry)
  return info.programName
    ? `${info.programName} (${short(permission.program)})`
    : `program ${short(permission.program)}`
}

function limitsText(p: Permission, ctx: Ctx): string {
  const perCall = p.perTxUnlimited
    ? 'no per-call limit'
    : `at most ${amountText(p.perTxLimit, p.program, ctx)} per call`
  const total = p.spendUnlimited
    ? 'no lifetime limit'
    : `${amountText(p.spendLimit - minBig(p.spendTotal, p.spendLimit), p.program, ctx)} of ${amountText(p.spendLimit, p.program, ctx)} lifetime budget left`
  return `${perCall}; ${total}`
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function actionLabel(info: InstructionInfo, discHex: string): string {
  return info.title ?? `instruction 0x${discHex} (not in the registry)`
}

export interface Blocker {
  readonly program: 'relay' | 'agent_auth' | 'token'
  readonly code: number
  readonly why: string
}

export function errName(program: 'relay' | 'agent_auth' | 'token', code: number): string {
  return lookupError(program, code)?.name ?? `code ${code}`
}

/**
 * Why the relay would reject an action of this mandate right now, or `null`. Mirrors the relay
 * check order (bindings 102, paused 116, stale 118) and the `verify` outcome (6/7/9) for the slot
 * the action draws on. `delegationOk` is `undefined` when the delegation was not read.
 */
export function relayBlocker(
  mandate: Mandate,
  policy: RelayPolicy,
  mandateAddress: Address | undefined,
  slotProgram: Address,
  disc: string,
  delegationOk: Blocker | null | undefined,
): Blocker | null {
  if (
    (mandateAddress !== undefined && policy.mandate !== mandateAddress) ||
    policy.owner !== mandate.owner ||
    policy.agent !== mandate.agent
  ) {
    return {
      program: 'relay',
      code: 102,
      why: 'the relay policy belongs to a different mandate, owner or agent',
    }
  }
  if (policy.mandateExpiry !== mandate.expiry) {
    return {
      program: 'relay',
      code: 118,
      why: `the relay policy is stale (policy expiry ${policy.mandateExpiry}, mandate expiry ${mandate.expiry})`,
    }
  }
  if (policy.paused) return { program: 'relay', code: 116, why: 'the relay policy is paused' }
  const slot = mandate.permissions.find((q) => q.program === slotProgram)
  if (!slot) {
    return {
      program: 'agent_auth',
      code: 6,
      why: `the mandate has no permission for program ${short(slotProgram)}`,
    }
  }
  if (!slot.discriminatorsHex.includes(disc)) {
    return {
      program: 'agent_auth',
      code: 7,
      why: `the ${short(slotProgram)} permission does not include the discriminator 0x${disc.slice(0, 2)}…`,
    }
  }
  if (!slot.spendUnlimited && slot.spendTotal >= slot.spendLimit) {
    return { program: 'agent_auth', code: 9, why: 'the lifetime budget is used up' }
  }
  if (delegationOk) return delegationOk
  return null
}

export function delegationBlocker(
  policy: RelayPolicy,
  delegation: DelegationInfo | null | undefined,
): Blocker | null | undefined {
  if (delegation === undefined || delegation === null) return undefined
  if (delegation.delegate !== policy.authority) {
    return {
      program: 'relay',
      code: 105,
      why: `the source account's SPL delegate (${delegation.delegate ? short(delegation.delegate) : 'none'}) is not the relay authority ${short(policy.authority)}`,
    }
  }
  if (delegation.delegatedAmount <= 0n) {
    return { program: 'relay', code: 105, why: 'the SPL delegated amount is 0' }
  }
  return null
}

/**
 * Explain a mandate in plain English: what the agent can and cannot do, the limits, the expiry, and
 * above all WHICH of it is hard-enforced and which is advisory.
 *
 * Honesty rules baked in: only the relay's two typed actions (a `TransferChecked` to an allowlisted
 * token account, and one pinned-pool swap) are labelled hard; everything else depends on whichever
 * program the agent calls actually calling `verify`, and is labelled advisory. With no relay policy,
 * nothing is hard.
 *
 * @example
 * const e = explainMandate(mandate, { policy, budgetDecimals: 6 })
 * console.log(e.headline, e.warnings)
 */
export function explainMandate(mandate: Mandate, opts: ExplainOptions = {}): Explanation {
  const ctx: Ctx = {
    registry: opts.registry,
    policy: opts.policy ?? null,
    decimals: opts.budgetDecimals,
  }
  const now = toNow(opts.now)
  const expired = now >= mandate.expiry
  const status: Explanation['status'] = expired ? 'expired' : mandate.active ? 'active' : 'paused'
  const policy = ctx.policy
  const warnings: string[] = []

  const expiry = {
    iso: isoOfSeconds(mandate.expiry),
    relative: relativeTime(mandate.expiry - now),
    expired,
  }

  // Per-permission grants, limits, warnings.
  const grants: string[] = []
  const advisoryGrants: string[] = []
  const limits: LimitLine[] = []
  const enforcement: Explanation['enforcement'] = []
  let anyLimited = false
  const policyBound =
    policy !== null &&
    policy.owner === mandate.owner &&
    policy.agent === mandate.agent &&
    (opts.mandateAddress ?? mandate.address) !== undefined
      ? policy.mandate === (opts.mandateAddress ?? mandate.address)
      : policy !== null && policy.owner === mandate.owner && policy.agent === mandate.agent

  for (const p of mandate.permissions) {
    const label = programLabel(p, ctx)
    const limitSentence = limitsText(p, ctx)
    limits.push({
      program: p.program,
      programName: label,
      spendLimit: p.spendUnlimited ? 'unlimited' : p.spendLimit,
      perTxLimit: p.perTxUnlimited ? 'unlimited' : p.perTxLimit,
      spendTotal: p.spendTotal,
      callCount: p.callCount,
      remaining: p.spendUnlimited ? 'unlimited' : p.spendLimit - minBig(p.spendTotal, p.spendLimit),
      text: `${label}: ${limitSentence}; ${plural(p.callCount, 'call')} so far`,
    })
    if (!p.spendUnlimited || !p.perTxUnlimited) anyLimited = true
    if (p.spendUnlimited) {
      warnings.push(
        `${label}: lifetime limit is UNLIMITED (0 on chain). Nothing in the mandate caps total spend for this program.`,
      )
    }
    if (p.perTxUnlimited) {
      warnings.push(`${label}: per-call limit is UNLIMITED (0 on chain).`)
    }
    if (!p.spendUnlimited && p.spendTotal >= p.spendLimit) {
      warnings.push(
        `${label}: the lifetime budget is fully used; further verify calls fail with SpendLimitExceeded.`,
      )
    }
    if (p.discriminators.length === 0) {
      warnings.push(`${label}: the discriminator list is empty, so this permission allows nothing.`)
    }
    for (const discHex of p.discriminatorsHex) {
      const info = describeInstruction(p.program, discHex, ctx.registry)
      const action = actionLabel(info, discHex)
      const hardTransfer =
        policy !== null &&
        policyBound &&
        p.program === policy.tokenProgram &&
        discHex === TRANSFER_CHECKED_DISC &&
        policy.recipients.length > 0
      const hardSwap =
        policy?.swap != null &&
        policyBound &&
        p.program === policy.swap.ammProgram &&
        discHex === SWAP_BASE_INPUT_DISC
      const hard = hardTransfer || hardSwap
      const grant = `Call "${action}" on ${label} (${limitSentence}) [${
        hard ? 'hard: enforced by the relay' : 'advisory: binds only programs that call verify'
      }]`
      grants.push(grant)
      if (!hard) advisoryGrants.push(grant)
      enforcement.push({
        action: hardTransfer
          ? `${action} on ${label} (only via relay transfer, to allowlisted token accounts)`
          : hardSwap
            ? `${action} on ${label} (only via relay swap, on the pinned pool)`
            : `${action} on ${label}`,
        level: hard ? HARD : ADVISORY,
      })
      if (info.defaultDeny || (info.risk !== null && DEFAULT_DENY_RISKS.includes(info.risk))) {
        warnings.push(
          `${label}: "${action}" is classified ${info.risk ?? 'default-deny'} (default-deny in the registry). It can hand over control of accounts or close them; check you really want this.`,
        )
      }
    }
  }

  // Relay policy: hard-enforced capabilities, cross-checked against the mandate.
  const mandateAddress = opts.mandateAddress ?? mandate.address
  const delegationKnown = opts.delegation !== undefined && opts.delegation !== null
  const transferBlocker: Blocker | null = policy
    ? policy.recipients.length === 0
      ? { program: 'relay', code: 104, why: 'the policy allowlists no recipient' }
      : relayBlocker(
          mandate,
          policy,
          mandateAddress,
          policy.tokenProgram,
          TRANSFER_CHECKED_DISC,
          delegationBlocker(policy, opts.delegation) ?? null,
        )
    : null
  const swapDelegation =
    policy?.swap && policy.swap.inAccount === policy.sourceAccount
      ? delegationBlocker(policy, opts.delegation)
      : undefined
  const swapBlocker: Blocker | null =
    policy?.swap != null
      ? relayBlocker(
          mandate,
          policy,
          mandateAddress,
          policy.swap.ammProgram,
          SWAP_BASE_INPUT_DISC,
          swapDelegation ?? null,
        )
      : null
  const relayLines: string[] = []
  const relayBlocked: string[] = []
  if (policy) {
    if (policy.recipients.length > 0) {
      const line = `Pay token ${short(policy.budgetMint)} from the owner's account ${short(policy.sourceAccount)} to ${plural(policy.recipients.length, 'allowlisted token account')} (${policy.recipients.map(short).join(', ')}) through the relay`
      if (transferBlocker) {
        relayBlocked.push(
          `${line}: would be rejected with ${errName(transferBlocker.program, transferBlocker.code)} (${transferBlocker.code}) because ${transferBlocker.why}.`,
        )
      } else {
        relayLines.push(
          `${line} (hard-enforced${delegationKnown ? '' : '; unverified: the SPL delegation was not read'})`,
        )
      }
    }
    if (policy.swap) {
      const s = policy.swap
      const line = `Swap ${short(s.inMint)} for ${short(s.outMint)} on the ONE pinned pool ${short(s.poolState)} at no worse than ${s.floorOut}/${s.floorIn} (out per in, raw units), output forced into the owner's own account, deadline at most ${plural(s.maxDeadlineSlots, 'slot')} ahead`
      if (swapBlocker) {
        relayBlocked.push(
          `${line}: would be rejected with ${errName(swapBlocker.program, swapBlocker.code)} (${swapBlocker.code}) because ${swapBlocker.why}.`,
        )
      } else {
        relayLines.push(
          `${line} (hard-enforced by the relay; the floor is a static price guard, not MEV protection${swapDelegation === undefined ? '; unverified: the SPL delegation was not read' : ''})`,
        )
      }
    }
  }

  // can / cannot
  const can: string[] = []
  const cannot: string[] = []
  if (status === 'active') {
    can.push(...relayLines)
    cannot.push(...relayBlocked)
    can.push(...advisoryGrants)
  } else {
    cannot.push(
      status === 'paused'
        ? 'Anything right now: the mandate is paused, so verify fails with NotActive until the owner resumes it.'
        : 'Anything: the mandate has expired, so verify fails with Expired. Expiry cannot be extended; the owner must create a new mandate.',
    )
  }
  cannot.push(
    'Call any program or instruction not listed in a permission (verify returns ProgramNotAllowed or DiscriminatorNotAllowed, if the program calls verify).',
    'Change the mandate, its permissions or the relay policy (owner-only instructions).',
  )
  if (policy) {
    cannot.push(
      'Pay any token account that is not on the allowlist (relay error 104).',
      "Take custody: the relay's only token authority is a per-mandate PDA, and the agent key holds none (assuming the owner followed the setup flow).",
    )
    if (opts.delegation) {
      cannot.push(
        `Move more than ${amountText(opts.delegation.delegatedAmount, policy.tokenProgram, ctx)} from the source account through the relay: the SPL delegation is a hard cap enforced by the Token program.`,
      )
    }
  }

  // Enforcement summary / status warnings.
  if (!policy) {
    warnings.push(
      'No relay policy was supplied or found for this mandate: nothing here is hard-enforced. Every permission is advisory and only binds programs that call verify.',
    )
  } else {
    if (policy.paused)
      warnings.push('The relay policy is paused: relay transfers and swaps fail with Paused (116).')
    if (!policy.strictTopLevel) {
      warnings.push(
        'STRICT_TOP_LEVEL is off: relay calls made through another program (CPI) are accepted.',
      )
    }
    if (policy.mandateExpiry !== mandate.expiry) {
      warnings.push(
        `The relay policy was created for an earlier mandate generation (policy expiry ${policy.mandateExpiry}, mandate expiry ${mandate.expiry}): relay actions fail with StalePolicy (118) until the owner closes and re-inits it.`,
      )
    }
    if (policy.recipients.length > 0) {
      warnings.push(
        "Recipients are token accounts, not wallets: the relay pins the account, not its owner. Whoever controls an allowlisted account's owner field can redirect future payments.",
      )
    }
    if (policy.swap) {
      warnings.push(
        'The swap floor price is static: it can go stale as the market moves, and sandwiching inside the floor is possible. It is not MEV protection.',
      )
    }
    const tokenPerm = mandate.permissions.find((q) => q.program === policy.tokenProgram)
    if (opts.delegation) {
      const d = opts.delegation
      if (policy.authority !== d.delegate) {
        warnings.push(
          `The source account's SPL delegate (${d.delegate ? short(d.delegate) : 'none'}) is not the relay authority ${short(policy.authority)}: relay transfers fail with TokenAccountState (105).`,
        )
      } else if (tokenPerm) {
        if (tokenPerm.spendUnlimited) {
          warnings.push(
            `The mandate's lifetime limit for ${short(policy.tokenProgram)} is unlimited, so the SPL delegation (${amountText(d.delegatedAmount, policy.tokenProgram, ctx)}) is the only hard cap.`,
          )
        } else {
          const remaining =
            tokenPerm.spendLimit - minBig(tokenPerm.spendTotal, tokenPerm.spendLimit)
          if (d.delegatedAmount > remaining) {
            warnings.push(
              `The SPL delegation (${amountText(d.delegatedAmount, policy.tokenProgram, ctx)}) is larger than the remaining mandate budget (${amountText(remaining, policy.tokenProgram, ctx)}): the mandate stops the agent first, but the delegation stays open beyond the budget you intended.`,
            )
          }
        }
      }
    } else if (policy.recipients.length > 0) {
      warnings.push(
        'The live SPL delegation was not provided: the hard cap is min(remaining mandate budget, delegated_amount). Read the source token account to confirm it.',
      )
    }
  }
  if (anyLimited) {
    warnings.push(
      'Spend counters are per target program and unit-less: every mint and decimal of the same program shares one raw-unit counter. Only the relay pins a single mint; elsewhere use one mandate per asset.',
    )
  }
  if (mandate.version === 0) {
    warnings.push(
      'This is a legacy (pre-hardening, version 0) mandate: no stored bump, and its expiry was not validated when it was created.',
    )
  }
  if (!expired && mandate.expiry - now > 365n * 86400n) {
    warnings.push(
      'The mandate expires in more than a year. Consider a shorter lifetime and renew it.',
    )
  }
  if (mandate.owner === mandate.agent) {
    warnings.push(
      'The agent key equals the owner key: the agent holds full authority and no mandate can limit it.',
    )
  }

  const permissionsText = plural(mandate.permissions.length, 'permission')
  const statusText = status === 'active' ? 'active' : status === 'paused' ? 'PAUSED' : 'EXPIRED'
  const headline = `Agent ${short(mandate.agent)} acts for owner ${short(mandate.owner)} with ${permissionsText} (${statusText}); ${
    expired ? 'expired' : 'expires'
  } ${expiry.iso} (${expiry.relative}). ${
    policy
      ? 'A relay policy hard-enforces transfers' + (policy.swap ? ' and one pinned swap' : '') + '.'
      : 'Nothing is hard-enforced (no relay policy).'
  }`

  return { headline, can, cannot, grants, limits, expiry, status, enforcement, warnings }
}
