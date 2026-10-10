import type { Command } from 'commander'
import { activityToJson, relayPolicyPda, type ActivityItem } from '@agentauth-sol/sdk'
import { usageError } from '../errors'
import type { Ctx } from '../env'
import { resolveTarget, budgetMint, type MintMeta, type Target } from '../resolve'
import type { Runner } from '../runner'
import { formatAmount, relativeTime, shortAddress } from '../units'

interface ActivityOpts {
  owner?: string
  agent?: string
  limit: string
  follow?: boolean
  fullSignature?: boolean
  all?: boolean
  address?: string
}

function outcome(ctx: Ctx, item: ActivityItem): string {
  if (item.ok) return ctx.out.ok('ok')
  if (item.error) {
    return ctx.out.bad(`BLOCKED ${item.error.program}:${item.error.code} ${item.error.name}`)
  }
  return ctx.out.bad('FAILED')
}

function amountText(ctx: Ctx, item: ActivityItem, budget: MintMeta | undefined): string {
  if (item.amount === undefined) return '-'
  const inBudgetUnits =
    item.kind === 'relay_transfer' || item.kind === 'relay_swap' || item.kind === 'token_transfer'
  return inBudgetUnits && budget
    ? formatAmount(item.amount, budget.decimals, budget.symbol, ctx.opts.raw === true)
    : `${item.amount} (raw)`
}

/**
 * Pause and resume are the same instruction with a different flag byte. The label comes from the
 * decoded `PausedChanged` event (relay) or from the relay row of the same transaction (core
 * `set_active`), never from the instruction kind alone. A failed transaction carries no event.
 */
function pauseLabel(item: ActivityItem, siblings: readonly ActivityItem[]): string {
  const base = item.kind === 'relay_pause' ? 'relay' : 'mandate'
  const event =
    item.event ??
    siblings.find((s) => s.signature === item.signature && s.event?.type === 'PausedChanged')?.event
  if (event?.type !== 'PausedChanged') return `${base} pause or resume`
  return event.paused ? `${base} pause` : `${base} resume`
}

function row(
  ctx: Ctx,
  item: ActivityItem,
  budget: MintMeta | undefined,
  full: boolean,
  all: readonly ActivityItem[] = [],
): string[] {
  const when =
    item.blockTime === null
      ? `slot ${item.slot}`
      : relativeTime(item.blockTime, BigInt(Math.floor(ctx.deps.now() / 1000)))
  const kind =
    item.discriminatorName && item.kind === 'verify'
      ? `verify ${item.discriminatorName}`
      : item.kind === 'relay_pause' || item.kind === 'set_active'
        ? pauseLabel(item, all)
        : (KIND_LABEL[item.kind] ?? item.kind.replaceAll('_', ' '))
  return [
    when,
    kind,
    outcome(ctx, item),
    amountText(ctx, item, budget),
    full ? item.signature : shortAddress(item.signature, 6),
  ]
}

const KIND_LABEL: Record<string, string> = {
  create: 'mandate created',
  revoke: 'mandate revoked',
  relay_transfer: 'relay pay',
  relay_swap: 'relay swap',
  relay_init: 'relay policy created',
  relay_close: 'relay policy closed',
}

/** The relay row already says what its nested `verify` call says: hide the duplicate unless `--all`. */
function collapse(items: ActivityItem[], all: boolean): ActivityItem[] {
  if (all) return items
  const relayed = new Set(
    items
      .filter((i) => i.kind === 'relay_transfer' || i.kind === 'relay_swap')
      .map((i) => i.signature),
  )
  return items.filter((i) => !(i.kind === 'verify' && relayed.has(i.signature)))
}

/** A mandate address taken as given: it may be closed, in which case only the chain history is left. */
async function closedTarget(ctx: Ctx, input: string): Promise<Target> {
  const mandateAddress = ctx.address(input, '--address')
  const mandate = await ctx.client.fetchMandate(mandateAddress)
  const policy = mandate === null ? null : await ctx.client.fetchPolicy(mandateAddress)
  const policyAddress = (await relayPolicyPda(mandateAddress, ctx.client.programIds.relay)).address
  if (mandate === null)
    ctx.out.note(
      ctx.out.dim(
        'No mandate account at this address (closed or never created): showing its history.',
      ),
    )
  return {
    mandateAddress,
    policyAddress,
    owner: mandate?.owner ?? mandateAddress,
    agent: mandate?.agent ?? mandateAddress,
    mandate,
    policy,
  }
}

const HEADER = ['TIME', 'KIND', 'OUTCOME', 'AMOUNT', 'SIGNATURE']

export function registerActivity(program: Command, run: Runner): void {
  program
    .command('activity')
    .argument(
      '[agent-or-mandate]',
      'an agent or mandate address (default: the agent keypair / demo agent)',
    )
    .option('--owner <address>', "the mandate's owner when you give an agent address")
    .option('--agent <address>', 'the agent')
    .option(
      '--address <mandate>',
      'a mandate address, also one that no longer exists (the audit trail of an unwound mandate)',
    )
    .option('--limit <n>', 'how many rows', '20')
    .option('--follow', 'keep polling and print new rows (Ctrl-C to stop)')
    .option('--full-signature', 'print whole signatures')
    .option('--all', 'also show the verify call nested inside each relay action')
    .description(
      'what the agent did: successful actions and BLOCKED attempts with the decoded reason',
    )
    .action((...a) =>
      run<ActivityOpts>('activity', a, async (ctx, o, args) => {
        const limit = Number(o.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
          throw usageError('--limit must be 1..200')
        const target: Target =
          o.address === undefined
            ? await resolveTarget(ctx, args[0], o)
            : await closedTarget(ctx, o.address)
        const budget = await budgetMint(ctx, target.policy)
        const fetchRows = (until?: string): Promise<ActivityItem[]> =>
          ctx.client.activity({
            mandate: target.mandateAddress,
            ...(target.policy === null ? {} : { policy: target.policyAddress }),
            limit,
            ...(until === undefined ? {} : { until }),
          })
        const full = o.fullSignature === true
        const items = await fetchRows()
        if (items.length === 0) ctx.out.say('No activity yet.')
        else
          ctx.out.table(
            HEADER,
            collapse(items, o.all === true).map((i) => row(ctx, i, budget, full, items)),
          )
        if (o.follow !== true) {
          ctx.out.emit('activity', ctx.cluster, {
            mandate: target.mandateAddress,
            items: activityToJson(items),
          })
          return
        }
        ctx.out.emitLine('activity', ctx.cluster, {
          mandate: target.mandateAddress,
          items: activityToJson(items),
        })
        ctx.out.note(ctx.out.dim('Following; Ctrl-C to stop.'))
        let newest = items[0]?.signature
        for (
          let poll = 0;
          ctx.deps.maxFollowPolls === undefined || poll < ctx.deps.maxFollowPolls;
          poll++
        ) {
          await ctx.deps.sleep(2000)
          const fresh = await fetchRows(newest)
          if (fresh.length === 0) continue
          newest = fresh[0]?.signature ?? newest
          for (const item of collapse([...fresh].reverse(), o.all === true)) {
            ctx.out.say(row(ctx, item, budget, full, fresh).join('  '))
          }
          ctx.out.emitLine('activity', ctx.cluster, {
            mandate: target.mandateAddress,
            items: activityToJson(fresh),
          })
        }
      }),
    )
}
