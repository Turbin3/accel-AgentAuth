import type { Address } from '@solana/kit'
import {
  describeInstruction,
  type Capacity,
  type Explanation,
  type Mandate,
  type MandateView,
  type Permission,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import type { Ctx } from './env'
import type { Out } from './output'
import { mintMeta, type MintMeta, type Target } from './resolve'
import { formatAmount, relativeTime, shortAddress } from './units'

/** Print an explanation: warnings first, then what the agent can and cannot do and what is hard. */
export function printExplanation(
  out: Out,
  ex: Explanation,
  extraWarnings: readonly string[] = [],
): void {
  // The plan and the explainer sometimes say the same thing, one of them with an extra sentence.
  const all = [...new Set([...extraWarnings, ...ex.warnings])]
  const warnings = all.filter((w) => !all.some((other) => other !== w && other.startsWith(w)))
  if (warnings.length > 0) {
    out.say(out.warn(out.bold('Warnings')))
    for (const w of warnings) out.say(`  ${out.warn('!')} ${w}`)
    out.say()
  }
  out.say(out.bold(ex.headline))
  out.say(
    `${out.dim('status')}  ${statusText(out, ex)}   ${out.dim('expires')} ${ex.expiry.iso} (${ex.expiry.relative})`,
  )
  out.say()
  if (ex.can.length > 0)
    out.section(
      'The agent can',
      ex.can.map((c) => `${out.ok('+')} ${c}`),
    )
  if (ex.cannot.length > 0) {
    if (ex.can.length > 0) out.say()
    out.section(
      'The agent cannot',
      ex.cannot.map((c) => `${out.bad('-')} ${c}`),
    )
  }
  if (ex.limits.length > 0) {
    out.say()
    out.section(
      'Limits',
      ex.limits.map((l) => l.text),
    )
  }
  if (ex.enforcement.length > 0) {
    out.say()
    out.say(out.bold('Enforcement'))
    for (const e of ex.enforcement) {
      const hard = e.level.startsWith('hard')
      out.say(`  ${hard ? out.ok('HARD    ') : out.warn('ADVISORY')}  ${e.action}`)
    }
  }
}

function statusText(out: Out, ex: Explanation): string {
  return ex.status === 'active' ? out.ok('active') : out.warn(ex.status)
}

export interface LoadedView {
  readonly target: Target
  readonly view: MandateView
  readonly budget: MintMeta | undefined
  readonly swapIn: MintMeta | undefined
}

/** Fetch the mandate view (3 round trips at most) with human decimals for the budget mint. */
export async function loadView(ctx: Ctx, target: Target): Promise<LoadedView> {
  const budget = target.policy === null ? undefined : await mintMeta(ctx, target.policy.budgetMint)
  const swapIn =
    target.policy?.swap == null
      ? undefined
      : target.policy.swap.inMint === target.policy.budgetMint
        ? budget
        : await mintMeta(ctx, target.policy.swap.inMint)
  const view = await ctx.client.inspect(target.mandateAddress, {
    ...(target.mandate === null ? {} : { mandate: target.mandate }),
    ...(budget === undefined ? {} : { budgetDecimals: budget.decimals }),
  })
  return { target, view, budget, swapIn }
}

/** Decimals/symbol of the mint a permission's counter is in, or undefined when it is unit-less/unknown. */
function unitsOf(p: Permission, loaded: LoadedView): MintMeta | undefined {
  const policy = loaded.target.policy
  if (policy === null) return undefined
  if (p.program === policy.tokenProgram) return loaded.budget
  if (policy.swap !== null && p.program === policy.swap.ammProgram) return loaded.swapIn
  return undefined
}

export function fmtLimit(
  ctx: Ctx,
  value: bigint,
  unlimited: boolean,
  unit: MintMeta | undefined,
): string {
  if (unlimited) return ctx.out.warn('unlimited')
  return unit === undefined
    ? `${value} (raw)`
    : formatAmount(value, unit.decimals, unit.symbol, ctx.opts.raw === true)
}

export function instructionNames(ctx: Ctx, p: Permission): string {
  return p.discriminatorsHex
    .map((d) => describeInstruction(p.program, d, ctx.client.registry).name ?? d)
    .join(', ')
}

export function programName(ctx: Ctx, program: Address): string {
  return (
    describeInstruction(program, '0000000000000000', ctx.client.registry).programName ??
    shortAddress(program)
  )
}

export function printPermissions(ctx: Ctx, mandate: Mandate, loaded: LoadedView): void {
  const rows = mandate.permissions.map((p) => {
    const unit = unitsOf(p, loaded)
    return [
      programName(ctx, p.program),
      instructionNames(ctx, p),
      `${fmtLimit(ctx, p.spendTotal, false, unit)} / ${fmtLimit(ctx, p.spendLimit, p.spendUnlimited, unit)}`,
      fmtLimit(ctx, p.perTxLimit, p.perTxUnlimited, unit),
      String(p.callCount),
    ]
  })
  if (rows.length === 0)
    ctx.out.say(`  ${ctx.out.dim('(no permissions: the agent may call nothing)')}`)
  else ctx.out.table(['PROGRAM', 'INSTRUCTIONS', 'SPENT / BUDGET', 'PER-CALL', 'CALLS'], rows)
}

export function printRelay(ctx: Ctx, policy: RelayPolicy, loaded: LoadedView): void {
  const { out } = ctx
  const { view, budget } = loaded
  const unit = (v: bigint): string =>
    budget === undefined
      ? String(v)
      : formatAmount(v, budget.decimals, budget.symbol, ctx.opts.raw === true)
  const delegation = view.delegation
  const delegated =
    delegation === null
      ? 'unknown'
      : delegation.delegate === policy.authority
        ? `${unit(delegation.delegatedAmount)} to the relay authority`
        : delegation.delegate === null
          ? out.warn('none (the relay cannot move funds)')
          : out.warn(`delegated to ${delegation.delegate}, NOT the relay authority`)
  out.keyValues([
    ['paused', policy.paused ? out.warn('yes') : 'no'],
    ['top-level only', policy.strictTopLevel ? 'yes' : 'no (relay calls inside CPIs are allowed)'],
    [
      'source account',
      `${policy.sourceAccount}  ${out.dim(view.balance === null ? '' : `balance ${unit(view.balance)}`)}`.trimEnd(),
    ],
    ['SPL delegation', delegated],
    [
      'recipients',
      policy.recipients.length === 0
        ? out.warn('none: every relay transfer is refused (RecipientNotAllowed)')
        : policy.recipients.join('\n' + ' '.repeat(18)),
    ],
    [
      'swap',
      policy.swap === null
        ? 'disabled'
        : `pool ${policy.swap.poolState} via ${shortAddress(policy.swap.ammProgram)}, floor ${policy.swap.floorOut}/${policy.swap.floorIn} (raw), output to ${shortAddress(policy.swap.outAccount)}`,
    ],
  ])
}

export function printCapacity(
  ctx: Ctx,
  capacity: Capacity | null,
  budget: MintMeta | undefined,
): void {
  const { out } = ctx
  if (capacity === null) return
  const amount = formatAmount(
    capacity.maxSpendNow,
    budget?.decimals,
    budget?.symbol,
    ctx.opts.raw === true,
  )
  if (capacity.blockedBy !== null) {
    out.say(
      `${out.bold('Right now')} the agent is blocked: ${capacity.blockedBy.program}:${capacity.blockedBy.code} ${capacity.blockedBy.name} (${capacity.blockedBy.why})`,
    )
  } else {
    out.say(
      `${out.bold('Right now')} the agent can move at most ${amount} in one call (limited by ${capacity.limitedBy.join(', ') || 'nothing'}).`,
    )
  }
}

export function statusLine(ctx: Ctx, mandate: Mandate, nowSeconds: bigint): string {
  const { out } = ctx
  const expired = nowSeconds >= mandate.expiry
  const status = expired
    ? out.bad('expired')
    : mandate.active
      ? out.ok('active')
      : out.warn('paused')
  return `${status} ${out.dim('·')} ${expired ? 'expired' : 'expires'} ${relativeTime(mandate.expiry, nowSeconds)}`
}
