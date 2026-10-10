import type { Command } from 'commander'
import {
  TRANSFER_CHECKED_DISC,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  assertMandateAuthorises,
} from '@agentauth-sol/sdk'
import { CliError, usageError } from '../errors'
import { resolveInstruction, resolveProgram } from '../registry'
import { mintMeta, resolveTarget } from '../resolve'
import type { Runner } from '../runner'
import { parseHumanAmount } from '../units'

interface CheckOpts {
  program: string
  instruction: string
  amount: string
  decimals?: string
  agent?: string
  owner?: string
}

export function registerCheck(program: Command, run: Runner): void {
  program
    .command('check')
    .requiredOption('--program <program>', 'registry slug or program id')
    .requiredOption(
      '--instruction <name|disc8>',
      'instruction name from the registry, or 16-hex disc8',
    )
    .option('--amount <amount>', 'amount the call would book', '0')
    .option(
      '--decimals <n>',
      'decimals of --amount (default: the budget mint for the Token program, else raw)',
    )
    .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
    .option(
      '--owner <address>',
      'the owner whose mandate counts (default: your keypair / the demo owner)',
    )
    .description(
      'pre-flight only: would this mandate authorise that call right now? (advisory; sends nothing)',
    )
    .action((...a) =>
      run<CheckOpts>('check', a, async (ctx, o) => {
        const target = await resolveTarget(ctx, undefined, o, { requireMandate: false })
        const prog = resolveProgram(o.program, ctx.client, ctx.cluster)
        const ix = resolveInstruction(prog, o.instruction, ctx.client)
        let decimals = 0
        let symbol: string | undefined
        if (o.decimals !== undefined) decimals = Number(o.decimals)
        else if (target.policy !== null && prog.id === target.policy.tokenProgram) {
          const mint = await mintMeta(ctx, target.policy.budgetMint)
          decimals = mint.decimals
          symbol = mint.symbol
        }
        if (!Number.isInteger(decimals) || decimals < 0)
          throw usageError('--decimals must be a non-negative integer')
        const amount = parseHumanAmount(o.amount, {
          decimals,
          symbol,
          raw: ctx.opts.raw === true,
          field: '--amount',
        })
        const now = await ctx.nowSeconds()
        const result = assertMandateAuthorises(target.mandate, {
          expectedOwner: target.owner,
          agent: target.agent,
          targetProgram: ctx.address(prog.id),
          discriminator: ix.disc8,
          amount,
          now,
        })
        const hard =
          target.policy !== null &&
          ((prog.id === TOKEN_PROGRAM_ID && ix.disc8 === TRANSFER_CHECKED_DISC) ||
            (target.policy.swap !== null &&
              prog.id === target.policy.swap.ammProgram &&
              ix.disc8 === SWAP_BASE_INPUT_DISC))
        const name = `${prog.name}.${ix.name ?? ix.disc8}`
        if (!result.ok) {
          throw new CliError(
            'denied',
            `denied: the mandate would refuse ${name} (amount ${o.amount})`,
            {
              program: result.error,
              data: { allowed: false, program: prog.id, disc8: ix.disc8, amountRaw: amount },
            },
          )
        }
        ctx.out.say(`${ctx.out.ok('allowed')} by the mandate: ${name}, amount ${o.amount}`)
        ctx.out.say(
          hard
            ? `  ${ctx.out.dim('Hard enforcement applies only through the relay: use `agentauth relay pay` / `relay swap`.')}`
            : `  ${ctx.out.warn('advisory')}: this is enforced only if the target program calls AgentAuth verify. An off-chain read cannot reserve budget.`,
        )
        ctx.out.emit('check', ctx.cluster, {
          allowed: true,
          advisory: true,
          hardEnforcedThroughRelay: hard,
          program: prog.id,
          disc8: ix.disc8,
          amountRaw: amount,
        })
      }),
    )
}
