import type { Command } from 'commander'
import {
  explanationToJson,
  preflightFailureToError,
  relaySwapIx,
  relayTransferIx,
  relayAuthorityPda,
  TOKEN_PROGRAM_ID,
  type BuiltInstruction,
} from '@agentauth-sol/sdk'
import { CliError, usageError } from '../errors'
import type { Ctx } from '../env'
import { UNAUDITED } from '../env'
import { mintMeta, resolveTarget, sendOne, stepJson } from '../resolve'
import type { Runner } from '../runner'
import { formatAmount, parseHumanAmount } from '../units'
import { loadView, printCapacity, printRelay, statusLine } from '../view'

interface AgentSideOpts {
  owner?: string
  /** commander stores `--no-preflight` as `preflight: false`. */
  preflight?: boolean
}

/** Send (or simulate, or fail) one agent instruction and report it the same way for pay and swap. */
async function sendAgentIx(
  ctx: Ctx,
  ix: BuiltInstruction,
  label: string,
  preflight: boolean,
): Promise<{ signature: string; simulated: boolean }> {
  const agent = await ctx.agentSigner()
  if (ctx.opts.simulate === true) {
    const sim = await ctx.client.simulate([ix], {
      feePayer: agent.address,
      programIds: ctx.client.programIds,
    })
    if (!sim.ok) {
      throw new CliError(
        'denied',
        `simulation of ${label} failed (nothing was sent)`,
        sim.error ? { program: sim.error } : {},
      )
    }
    ctx.out.say(
      `${ctx.out.ok('ok')} simulated ${label}, ${sim.unitsConsumed ?? '?'} compute units. Nothing was sent (--simulate).`,
    )
    return { signature: '', simulated: true }
  }
  const res = await sendOne(ctx, [ix], label, [agent], { skipPreflight: !preflight })
  if (!res.ok) {
    throw new CliError(
      'onchain',
      res.signature === undefined
        ? `${label} was rejected by the RPC before landing`
        : `${label} landed and FAILED on chain (the fee is paid, nothing moved)`,
      {
        ...(res.error ? { program: res.error } : {}),
        ...(res.signature === undefined ? {} : { hint: `Explorer: ${res.explorer}` }),
        data: { step: stepJson(res) },
      },
    )
  }
  return { signature: res.signature as string, simulated: false }
}

export function registerRelay(program: Command, run: Runner): void {
  const relay = program
    .command('relay')
    .description('the hard-enforcement point: status, pay and swap (agent side)')

  relay
    .command('status')
    .argument(
      '[agent-or-mandate]',
      'an agent or mandate address (default: the agent keypair / demo agent)',
    )
    .option('--owner <address>', "the mandate's owner when you give an agent address")
    .option('--agent <address>', 'the agent')
    .description(
      'show the relay policy, the live SPL delegation, balances and what the agent can move right now',
    )
    .action((...a) =>
      run<{ owner?: string; agent?: string }>('relay status', a, async (ctx, o, args) => {
        const target = await resolveTarget(ctx, args[0], o)
        const loaded = await loadView(ctx, target)
        const { out } = ctx
        out.say(`${out.bold('Relay')} for mandate ${target.mandateAddress}`)
        if (target.mandate)
          out.say(
            `${out.dim('mandate')} ${statusLine(ctx, target.mandate, await ctx.nowSeconds())}`,
          )
        out.say()
        if (target.policy === null) {
          out.say(out.warn('No relay policy: nothing is hard-enforced for this mandate.'))
        } else {
          printRelay(ctx, target.policy, loaded)
          out.say()
          printCapacity(ctx, loaded.view.capacity, loaded.budget)
        }
        out.say()
        out.say(out.dim(UNAUDITED))
        out.emit('relay status', ctx.cluster, {
          mandate: target.mandateAddress,
          policy: target.policy,
          delegation: loaded.view.delegation,
          balance: loaded.view.balance,
          capacity: loaded.view.capacity,
          explanation:
            loaded.view.explanation === null ? null : explanationToJson(loaded.view.explanation),
        })
      }),
    )

  relay
    .command('pay')
    .requiredOption('--to <account>', 'recipient TOKEN ACCOUNT (must be on the policy allowlist)')
    .requiredOption('--amount <amount>', 'human amount, for example "25 DUSD"')
    .option(
      '--owner <address>',
      "the mandate's owner (default: inferred from the chain when unambiguous)",
    )
    .option(
      '--source <account>',
      'owner token account (only needed to send an attempt after the policy was closed)',
    )
    .option('--mint <address>', 'budget mint (only needed after the policy was closed)')
    .option(
      '--no-preflight',
      'skip the local check AND the RPC preflight so a blocked attempt lands on chain (scripted-attacker demos)',
    )
    .description(
      'pay an allowlisted recipient through the relay, signed by the AGENT key (hard-enforced)',
    )
    .action((...a) =>
      run<AgentSideOpts & { to: string; amount: string; source?: string; mint?: string }>(
        'relay pay',
        a,
        async (ctx, o) => {
          const agent = await ctx.agentSigner()
          const target = await resolveTarget(
            ctx,
            undefined,
            { agent: agent.address, owner: o.owner },
            { requireMandate: false },
          )
          const policy = target.policy
          const destination = ctx.address(o.to, '--to')
          const preflight = o.preflight !== false
          if (policy === null && preflight) {
            const pre = await ctx.client.preflightTransfer({
              owner: target.owner,
              agent: agent.address,
              destination,
              amount: 1n,
            })
            throw new CliError(
              'denied',
              'pre-flight: this mandate has no relay policy (revoked, closed or never created)',
              {
                ...(pre.ok ? {} : { program: preflightFailureToError(pre) }),
                hint: '--no-preflight (with --source and --mint) lands the attempt on chain anyway; a failed attempt still pays the fee.',
              },
            )
          }
          const mintAddress =
            policy?.budgetMint ?? (o.mint === undefined ? undefined : ctx.address(o.mint, '--mint'))
          if (mintAddress === undefined || (policy === null && o.source === undefined)) {
            throw usageError('the policy is gone: --no-preflight also needs --source and --mint')
          }
          const mint = await mintMeta(ctx, mintAddress)
          const amount = parseHumanAmount(o.amount, {
            decimals: mint.decimals,
            symbol: mint.symbol,
            raw: ctx.opts.raw === true,
            field: '--amount',
          })
          if (amount === 0n) throw usageError('--amount must be greater than zero')
          const shown = formatAmount(amount, mint.decimals, mint.symbol, ctx.opts.raw === true)
          if (preflight) {
            const pre = await ctx.client.preflightTransfer({
              owner: target.owner,
              agent: agent.address,
              destination,
              amount,
            })
            if (!pre.ok) {
              throw new CliError(
                'denied',
                `pre-flight: the relay would refuse ${shown} to ${destination}`,
                {
                  program: preflightFailureToError(pre),
                  hint: "Nothing was sent. The pre-flight mirrors the programs' checks against live chain data; --no-preflight lands the attempt anyway (a failed attempt still pays the fee).",
                },
              )
            }
          }
          const programs = {
            relayProgram: ctx.client.programIds.relay,
            agentAuthProgram: ctx.client.programIds.agentAuth,
          }
          const ix =
            policy !== null
              ? await relayTransferIx({ agent, policy, destination, amount, ...programs })
              : await relayTransferIx({
                  agent,
                  destination,
                  amount,
                  owner: target.owner,
                  mandate: target.mandateAddress,
                  policyAddress: target.policyAddress,
                  authority: (
                    await relayAuthorityPda(target.mandateAddress, ctx.client.programIds.relay)
                  ).address,
                  source: ctx.address(o.source as string, '--source'),
                  mint: mintAddress,
                  tokenProgram: TOKEN_PROGRAM_ID,
                  ...programs,
                })
          const sent = await sendAgentIx(ctx, ix, 'relay transfer', preflight)
          if (!sent.simulated) {
            ctx.out.say(`${ctx.out.ok('Paid')} ${shown} to ${destination}`)
            ctx.out.say(
              `  ${ctx.out.dim('relay -> AgentAuth.verify -> Token.TransferChecked (hard-enforced)')}`,
            )
            ctx.out.say(`  ${sent.signature}`)
            ctx.out.say(`  ${ctx.out.link(ctx.explorerTx(sent.signature))}`)
          }
          ctx.out.emit('relay pay', ctx.cluster, {
            mandate: target.mandateAddress,
            destination,
            amountRaw: amount,
            amount: formatAmount(amount, mint.decimals, mint.symbol),
            signature: sent.simulated ? null : sent.signature,
            explorer: sent.simulated ? null : ctx.explorerTx(sent.signature),
            simulated: sent.simulated,
          })
        },
      ),
    )

  relay
    .command('swap')
    .requiredOption('--amount-in <amount>', 'input amount, for example "5 DUSD"')
    .option('--min-out <amount>', 'minimum output ("0" lets the relay floor decide)', '0')
    .option('--deadline-slots <n>', 'deadline = current slot + n', '60')
    .option('--owner <address>', "the mandate's owner")
    .option(
      '--no-preflight',
      'skip the local check and RPC preflight so the attempt lands on chain',
    )
    .description(
      'swap through the ONE pool pinned in the policy; the relay enforces max(min-out, floor) (hard-enforced, not MEV protection)',
    )
    .action((...a) =>
      run<AgentSideOpts & { amountIn: string; minOut: string; deadlineSlots: string }>(
        'relay swap',
        a,
        async (ctx, o) => {
          const agent = await ctx.agentSigner()
          const target = await resolveTarget(
            ctx,
            undefined,
            { agent: agent.address, owner: o.owner },
            { requireMandate: false },
          )
          const policy = target.policy
          if (policy === null) {
            const slotNow = await ctx.client.rpc.getSlot().send()
            const pre = await ctx.client.preflightSwap({
              owner: target.owner,
              agent: agent.address,
              amountIn: 1n,
              minOut: 0n,
              deadlineSlot: BigInt(slotNow) + 60n,
            })
            throw new CliError(
              'denied',
              'pre-flight: this mandate has no relay policy (revoked, closed or never created)',
              pre.ok ? {} : { program: preflightFailureToError(pre) },
            )
          }
          const swap = policy.swap
          if (swap === null) throw usageError('this policy has no swap configured')
          const inMint = await mintMeta(ctx, swap.inMint)
          const outMint = await mintMeta(ctx, swap.outMint)
          const amountIn = parseHumanAmount(o.amountIn, {
            decimals: inMint.decimals,
            symbol: inMint.symbol,
            raw: ctx.opts.raw === true,
            field: '--amount-in',
          })
          const minOut = parseHumanAmount(o.minOut, {
            decimals: outMint.decimals,
            symbol: outMint.symbol,
            raw: ctx.opts.raw === true,
            field: '--min-out',
          })
          const slots = Number(o.deadlineSlots)
          if (!Number.isInteger(slots) || slots < 1)
            throw usageError('--deadline-slots must be a positive integer')
          const slot = await ctx.client.rpc.getSlot().send()
          const deadlineSlot = BigInt(slot) + BigInt(slots)
          const preflight = o.preflight !== false
          if (preflight) {
            const pre = await ctx.client.preflightSwap({
              owner: target.owner,
              agent: agent.address,
              amountIn,
              minOut,
              deadlineSlot,
            })
            if (!pre.ok) {
              throw new CliError('denied', 'pre-flight: the relay would refuse this swap', {
                program: preflightFailureToError(pre),
                hint: 'Nothing was sent. --no-preflight lands the attempt anyway.',
              })
            }
          }
          const ix = await relaySwapIx({
            agent,
            amountIn,
            minOut,
            deadlineSlot,
            policy,
            relayProgram: ctx.client.programIds.relay,
            agentAuthProgram: ctx.client.programIds.agentAuth,
          })
          const sent = await sendAgentIx(ctx, ix, 'relay swap', preflight)
          let inDelta: bigint | undefined
          let outDelta: bigint | undefined
          if (!sent.simulated) {
            // sendAndConfirm returns no logs for a successful transaction, so read the event back
            // through the activity feed (which decodes the relay's SwapExecuted log line).
            const recent = await ctx.client.activity({
              mandate: target.mandateAddress,
              policy: target.policyAddress,
              limit: 5,
            })
            for (const item of recent) {
              if (item.signature === sent.signature && item.event?.type === 'SwapExecuted') {
                inDelta = item.event.inDelta
                outDelta = item.event.outDelta
              }
            }
            const fmtIn = formatAmount(
              inDelta ?? amountIn,
              inMint.decimals,
              inMint.symbol,
              ctx.opts.raw === true,
            )
            const fmtOut =
              outDelta === undefined
                ? 'see the explorer'
                : formatAmount(outDelta, outMint.decimals, outMint.symbol, ctx.opts.raw === true)
            ctx.out.say(
              `${ctx.out.ok('Swapped')} ${fmtIn} for ${fmtOut}, output to the owner's own account`,
            )
            ctx.out.say(
              `  ${ctx.out.dim('Price floor is a static guard on the pinned pool, not MEV protection.')}`,
            )
            ctx.out.say(`  ${sent.signature}`)
            ctx.out.say(`  ${ctx.out.link(ctx.explorerTx(sent.signature))}`)
          }
          ctx.out.emit('relay swap', ctx.cluster, {
            mandate: target.mandateAddress,
            amountInRaw: inDelta ?? amountIn,
            amountOutRaw: outDelta ?? null,
            signature: sent.simulated ? null : sent.signature,
            simulated: sent.simulated,
          })
        },
      ),
    )
}
