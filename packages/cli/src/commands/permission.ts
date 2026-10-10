import type { Command } from 'commander'
import { addPermissionIx, type Permission } from '@agentauth-sol/sdk'
import { CliError, usageError } from '../errors'
import type { Ctx } from '../env'
import { resolveInstruction, resolveProgram } from '../registry'
import { mintMeta, resolveTarget, sendOne, stepJson } from '../resolve'
import type { Runner } from '../runner'
import { parseLimitFlag, shortAddress } from '../units'
import { finishOwnerPlan } from './mandate'

interface PermOpts {
  agent?: string
  perCall?: string
  budget?: string
  decimals?: string
  allowUnlimited?: boolean
  allowDefaultDeny?: boolean
}

/** Decimals in which a permission's limits are written: the budget mint for the Token program, else `--decimals`, else raw. */
async function limitUnits(
  ctx: Ctx,
  programId: string,
  policyTokenProgram: string | undefined,
  budgetMint: string | undefined,
  decimalsFlag: string | undefined,
) {
  if (decimalsFlag !== undefined) {
    const decimals = Number(decimalsFlag)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
      throw usageError('--decimals must be an integer from 0 to 18')
    return { decimals, symbol: undefined, label: `${decimals} decimals` }
  }
  if (budgetMint !== undefined && programId === policyTokenProgram) {
    const mint = await mintMeta(ctx, ctx.address(budgetMint))
    return { decimals: mint.decimals, symbol: mint.symbol, label: mint.symbol ?? 'the budget mint' }
  }
  return {
    decimals: 0,
    symbol: undefined,
    label: 'raw units (counters are unit-less; use --decimals to write human amounts)',
  }
}

export function registerPermission(program: Command, run: Runner): void {
  const perm = program
    .command('permission')
    .description('change what the agent may call, live (owner side)')

  perm
    .command('add')
    .argument('<program>', 'registry slug or program id')
    .argument('<instructions...>', 'instruction names from the registry, or 16-hex disc8 values')
    .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
    .option('--per-call <amount>', 'per-call cap')
    .option('--budget <amount>', 'lifetime budget')
    .option(
      '--decimals <n>',
      'decimals the limits are written in (default: the budget mint for the Token program, else raw)',
    )
    .option('--allow-unlimited', 'accept "unlimited"')
    .option('--allow-default-deny', 'accept authority_change / account_close / admin instructions')
    .description('add a permission slot (counters start at 0; one slot per program)')
    .action((...a) =>
      run<PermOpts>('permission add', a, async (ctx, o, args) => {
        const owner = await ctx.ownerSigner()
        const target = await resolveTarget(ctx, undefined, o)
        const mandate = target.mandate
        if (mandate === null) throw usageError('no mandate to change')
        const prog = resolveProgram(args[0] as string, ctx.client, ctx.cluster)
        const names = args.slice(1).flat() as string[]
        const instrs = names.map((n) => resolveInstruction(prog, n, ctx.client))
        const denied = instrs.filter((i) => i.defaultDeny)
        if (denied.length > 0 && o.allowDefaultDeny !== true) {
          throw usageError(
            `${denied.map((d) => d.name ?? d.disc8).join(', ')} is default-deny (${denied.map((d) => d.risk).join(', ')}): it can hand control of the owner funds to someone else`,
            'Pass --allow-default-deny only if you are sure.',
          )
        }
        if (mandate.permissions.some((p: Permission) => p.program === prog.id)) {
          throw usageError(
            `${prog.name} already has a permission slot`,
            'Change limits with `permission update`, or take instructions away with `permission remove`.',
          )
        }
        if (o.perCall === undefined || o.budget === undefined)
          throw usageError('both --per-call and --budget are required (a limit is never guessed)')
        const units = await limitUnits(
          ctx,
          prog.id,
          target.policy?.tokenProgram,
          target.policy?.budgetMint,
          o.decimals,
        )
        const amountCtx = (field: string) => ({
          decimals: units.decimals,
          symbol: units.symbol,
          raw: ctx.opts.raw === true,
          field,
        })
        const perTxLimit = parseLimitFlag(o.perCall, amountCtx('--per-call'))
        const spendLimit = parseLimitFlag(o.budget, amountCtx('--budget'))
        if (
          (perTxLimit === 'unlimited' || spendLimit === 'unlimited') &&
          o.allowUnlimited !== true
        ) {
          throw usageError('unlimited limits need --allow-unlimited (on chain 0 means unlimited)')
        }
        const ix = await addPermissionIx({
          owner,
          agent: target.agent,
          mandate: target.mandateAddress,
          program: ctx.address(prog.id),
          spendLimit,
          perTxLimit,
          discriminators: instrs.map((i) => i.disc8),
          agentAuthProgram: ctx.client.programIds.agentAuth,
        })
        const { out } = ctx
        out.say(out.bold(`Add permission on ${prog.name} for agent ${shortAddress(target.agent)}`))
        out.keyValues([
          ['instructions', instrs.map((i) => i.name ?? i.disc8).join(', ')],
          ['per call', String(o.perCall)],
          ['budget', String(o.budget)],
          ['units', units.label],
          [
            'enforcement',
            'advisory unless the target program calls verify (hard only for the relay transfer and pinned swap)',
          ],
        ])
        out.say()
        if (ctx.opts.simulate === true) {
          const sim = await ctx.client.simulate([ix], {
            feePayer: owner.address,
            programIds: ctx.client.programIds,
          })
          out.say(
            sim.ok
              ? `${out.ok('ok')} simulated, nothing sent (--simulate)`
              : `${out.bad('FAIL')} ${sim.error?.describe() ?? 'simulation failed'}`,
          )
          if (!sim.ok)
            throw new CliError(
              'denied',
              'simulation failed',
              sim.error ? { program: sim.error } : {},
            )
          out.emit('permission add', ctx.cluster, { simulated: true })
          return
        }
        if (!(await ctx.confirm('Send this transaction?')))
          throw new CliError('usage', 'cancelled: nothing was sent', { exitCode: 1 })
        const res = await sendOne(ctx, [ix], 'add_permission', [owner])
        if (!res.ok)
          throw new CliError(
            'onchain',
            'add_permission failed',
            res.error ? { program: res.error } : {},
          )
        out.say(`${out.ok('Done.')} ${res.signature}`)
        out.say(`  ${out.link(String(res.explorer))}`)
        out.emit('permission add', ctx.cluster, { step: stepJson(res) })
      }),
    )

  perm
    .command('update')
    .argument('<program>', 'registry slug or program id')
    .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
    .option('--per-call <amount>', 'new per-call cap')
    .option(
      '--budget <amount>',
      'new lifetime budget (counters are kept: this is not a fresh budget)',
    )
    .option('--decimals <n>', 'decimals the limits are written in')
    .option('--allow-unlimited', 'accept "unlimited"')
    .description('change the limits of an existing permission, keeping counters and instructions')
    .action((...a) =>
      run<PermOpts>('permission update', a, async (ctx, o, args) => {
        const owner = await ctx.ownerSigner()
        const target = await resolveTarget(ctx, undefined, o)
        const prog = resolveProgram(args[0] as string, ctx.client, ctx.cluster)
        const existing = target.mandate?.permissions.find((p) => p.program === prog.id)
        if (existing === undefined)
          throw usageError(`${prog.name} has no permission slot`, 'Add one with `permission add`.')
        if (o.perCall === undefined || o.budget === undefined)
          throw usageError('both --per-call and --budget are required')
        const units = await limitUnits(
          ctx,
          prog.id,
          target.policy?.tokenProgram,
          target.policy?.budgetMint,
          o.decimals,
        )
        const amountCtx = (field: string) => ({
          decimals: units.decimals,
          symbol: units.symbol,
          raw: ctx.opts.raw === true,
          field,
        })
        const plan = await ctx.client.plan.updateLimits({
          owner,
          agent: target.agent,
          program: ctx.address(prog.id),
          perTxLimit: parseLimitFlag(o.perCall, amountCtx('--per-call')),
          spendLimit: parseLimitFlag(o.budget, amountCtx('--budget')),
          ...(o.allowUnlimited === true ? { allowUnlimited: true } : {}),
        })
        await finishOwnerPlan(ctx, 'permission update', plan, owner)
      }),
    )

  perm
    .command('remove')
    .argument('<program>', 'registry slug or program id')
    .argument(
      '[instructions...]',
      'take only these instructions away (default: remove the whole slot)',
    )
    .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
    .description('remove a permission (the whole program slot), or just some of its instructions')
    .action((...a) =>
      run<PermOpts>('permission remove', a, async (ctx, o, args) => {
        const owner = await ctx.ownerSigner()
        const target = await resolveTarget(ctx, undefined, o)
        const prog = resolveProgram(args[0] as string, ctx.client, ctx.cluster)
        const names = args.slice(1).flat() as string[]
        const programAddress = ctx.address(prog.id)
        if (!target.mandate?.permissions.some((p) => p.program === prog.id)) {
          throw usageError(`${prog.name} has no permission slot on this mandate`)
        }
        const slot = target.mandate.permissions.find((p) => p.program === prog.id)
        const removed = names.map((n) => resolveInstruction(prog, n, ctx.client).disc8)
        // Predict from the LIVE permission: the slot goes when no instruction would remain.
        const remaining =
          slot === undefined
            ? 0
            : slot.discriminatorsHex.filter((d) => !removed.includes(d.toLowerCase())).length
        const wholeSlot = names.length === 0 || remaining === 0
        const plan =
          names.length === 0
            ? await ctx.client.plan.revokePermission({
                owner,
                agent: target.agent,
                program: programAddress,
              })
            : await ctx.client.plan.revokeDiscriminator({
                owner,
                agent: target.agent,
                program: programAddress,
                discriminators: removed,
              })
        await finishOwnerPlan(
          ctx,
          'permission remove',
          plan,
          owner,
          wholeSlot
            ? 'No instruction of this program remains in the permission, so the whole permission is removed and the next call fails with ProgramNotAllowed (agent_auth 6).'
            : 'The agent loses the right to call the removed instructions; its other instructions and the remaining budget are kept. The next call to a removed instruction fails with DiscriminatorNotAllowed (agent_auth 7).',
        )
      }),
    )
}
