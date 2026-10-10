import type { Address } from '@solana/kit'
import {
  formatUnits,
  isoOfSeconds,
  mandatePda,
  type Capacity,
  type Mandate,
  type MandateView,
  type Permission,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import type { Context } from './context'
import { HONESTY } from './reply'
import { tidy } from './sanitize'

/** `recipient-1`, `recipient-2`, ... or the operator's label (escaped and capped). */
export function recipientLabel(ctx: Context, policy: RelayPolicy | null, token: string): string {
  const configured = ctx.labels.get(token)
  if (configured) return configured
  const i = policy ? policy.recipients.findIndex((r) => r === token) : -1
  return i >= 0 ? `recipient-${i + 1}` : 'not-on-allowlist'
}

/** Resolve a label (`recipient-2`, an operator label) or a base58 address to an address string. */
export function resolveRecipient(ctx: Context, policy: RelayPolicy, input: string): string {
  const n = /^recipient-(\d{1,2})$/.exec(input)
  if (n) {
    const found = policy.recipients[Number(n[1]) - 1]
    if (found) return found
  }
  for (const [address, label] of ctx.labels) if (label === input) return address
  return input
}

function human(value: bigint | 'unlimited' | null, decimals: number): string | null {
  if (value === null) return null
  return value === 'unlimited' ? 'unlimited' : formatUnits(value, decimals)
}

function permissionLine(p: Permission, decimals: number | null, name: string) {
  const raw = decimals === null
  const fmt = (v: bigint, unlimited: boolean): string =>
    unlimited ? 'unlimited' : raw ? `${v} raw units` : formatUnits(v, decimals)
  return {
    program: p.program,
    name,
    instructions: p.discriminatorsHex,
    per_call_limit: fmt(p.perTxLimit, p.perTxUnlimited),
    lifetime_limit: fmt(p.spendLimit, p.spendUnlimited),
    spent: raw ? `${p.spendTotal} raw units` : formatUnits(p.spendTotal, decimals),
    calls: p.callCount,
  }
}

export interface Report {
  readonly view: MandateView
  readonly mandateAddress: Address
  readonly policy: RelayPolicy | null
  readonly decimals: number | null
  readonly body: Record<string, unknown>
}

function statusOf(mandate: Mandate | null, view: MandateView, policy: RelayPolicy | null): string {
  if (!mandate) return 'not_found'
  if (view.explanation?.status === 'expired') return 'expired'
  if (view.explanation?.status === 'paused' || policy?.paused) return 'paused'
  return 'active'
}

/**
 * Mandate + policy + live delegation, as a short report in human units. `detail` adds every
 * permission slot and the sentences of the SDK explanation (owner / observer views).
 */
export async function buildReport(
  ctx: Context,
  owner: Address,
  agent: Address,
  detail: 'agent' | 'full',
): Promise<Report> {
  const mandateAddress = (await mandatePda(owner, agent, ctx.client.programIds.agentAuth)).address
  const view = await ctx.withTimeout(ctx.client.inspect(mandateAddress), 'reading the mandate')
  const { mandate, policy, explanation } = view
  const decimals = policy
    ? await ctx.withTimeout(ctx.decimalsOf(policy.budgetMint), 'reading the mint')
    : null
  const status = statusOf(mandate, view, policy)

  const tokenPerm =
    mandate && policy
      ? mandate.permissions.find((p) => p.program === policy.tokenProgram)
      : undefined
  const cap: Capacity | null = view.capacity
  const budget =
    policy && decimals !== null
      ? {
          token_mint: policy.budgetMint,
          decimals,
          per_call_limit: tokenPerm
            ? tokenPerm.perTxUnlimited
              ? 'unlimited'
              : formatUnits(tokenPerm.perTxLimit, decimals)
            : null,
          lifetime_limit: tokenPerm
            ? tokenPerm.spendUnlimited
              ? 'unlimited'
              : formatUnits(tokenPerm.spendLimit, decimals)
            : null,
          spent: tokenPerm ? formatUnits(tokenPerm.spendTotal, decimals) : null,
          remaining: tokenPerm
            ? tokenPerm.spendUnlimited
              ? 'unlimited'
              : formatUnits(tokenPerm.spendLimit - tokenPerm.spendTotal, decimals)
            : null,
          max_spend_now: cap ? formatUnits(cap.maxSpendNow, decimals) : null,
          limited_by: cap ? [...cap.limitedBy] : [],
          blocked_by: cap?.blockedBy
            ? { program: cap.blockedBy.program, code: cap.blockedBy.code, name: cap.blockedBy.name }
            : null,
          spl_delegation: view.delegation ? human(view.delegation.delegatedAmount, decimals) : null,
        }
      : null

  const recipients = policy
    ? policy.recipients.map((token, i) => ({
        label: ctx.labels.get(token) ?? `recipient-${i + 1}`,
        token_account: token,
      }))
    : []

  const swap = policy?.swap
    ? {
        enabled: true,
        amm_program: policy.swap.ammProgram,
        pool: policy.swap.poolState,
        floor_price: `${policy.swap.floorOut} out per ${policy.swap.floorIn} in (raw units)`,
        max_deadline_slots: policy.swap.maxDeadlineSlots,
        output_goes_to: policy.swap.outAccount,
      }
    : { enabled: false }

  const body: Record<string, unknown> = {
    mandate: {
      address: mandateAddress,
      owner,
      agent,
      status,
      relay_paused: policy?.paused ?? null,
      expires_at: mandate ? isoOfSeconds(mandate.expiry) : null,
      expires_in: explanation?.expiry.relative ?? null,
    },
    budget,
    allowed_recipients: recipients,
    swap,
    enforcement: explanation
      ? explanation.enforcement.map((e) => ({ action: tidy(e.action, 160), level: e.level }))
      : [],
    warnings: explanation ? explanation.warnings.map((w) => tidy(w, 300)).slice(0, 12) : [],
    honesty: HONESTY,
  }
  if (!mandate) {
    body['note'] =
      'No mandate exists for this owner and agent pair: it was never created, or the owner revoked it. Nothing is authorised.'
  }
  if (detail === 'full' && mandate) {
    body['headline'] = tidy(explanation?.headline ?? '', 300)
    body['can'] = (explanation?.can ?? []).slice(0, 12).map((s) => tidy(s, 300))
    body['cannot'] = (explanation?.cannot ?? []).slice(0, 12).map((s) => tidy(s, 300))
    body['permissions'] = mandate.permissions.map((p) => {
      const line = explanation?.limits.find((l) => l.program === p.program)
      const isBudget = policy !== null && p.program === policy.tokenProgram
      return permissionLine(
        p,
        isBudget ? decimals : null,
        tidy(line?.programName ?? 'unknown program', 80),
      )
    })
    body['spl_delegate'] = view.delegation?.delegate ?? null
  }
  return { view, mandateAddress, policy, decimals, body }
}
