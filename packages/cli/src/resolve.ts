import type { Address, TransactionSigner } from '@solana/kit'
import {
  parseProgramError,
  relayPolicyPda,
  type AgentAuthError,
  type Mandate,
  type Plan,
  type PlanStep,
  type RelayPolicy,
  type StepLike,
} from '@agentauth-sol/sdk'
import { CliError, usageError } from './errors'
import type { Ctx } from './env'

export interface Target {
  readonly mandateAddress: Address
  readonly policyAddress: Address
  readonly owner: Address
  readonly agent: Address
  readonly mandate: Mandate | null
  readonly policy: RelayPolicy | null
}

export interface TargetFlags {
  readonly owner?: string | undefined
  readonly agent?: string | undefined
}

/**
 * Find the mandate a command is about. `arg` may be a mandate address, or an agent address (then
 * the owner comes from `--owner`, the owner keypair or the demo owner). Without `arg` the agent
 * comes from `--agent`, the agent keypair or the demo agent.
 */
export async function resolveTarget(
  ctx: Ctx,
  arg: string | undefined,
  flags: TargetFlags,
  opts: { requireMandate: boolean } = { requireMandate: true },
): Promise<Target> {
  const { client } = ctx
  let owner: Address | undefined
  let agent: Address | undefined
  let mandate: Mandate | null = null
  let mandateAddress: Address | undefined

  if (arg !== undefined) {
    const addr = ctx.address(arg, 'argument')
    const direct = await client.fetchMandate(addr)
    if (direct !== null) {
      mandate = direct
      mandateAddress = addr
      owner = direct.owner
      agent = direct.agent
    } else {
      agent = addr
    }
  } else {
    agent = await ctx.agentAddress(flags.agent)
    if (agent === undefined) {
      throw usageError(
        'which agent? give an agent or mandate address',
        'Or pass --agent <address> / --agent-keypair <path>.',
      )
    }
  }

  if (mandate === null && agent !== undefined) {
    owner = await ctx.ownerAddress(flags.owner)
    if (owner === undefined) {
      const found = await client.mandatesByAgent(agent, { limit: 5 })
      if (found.length === 1 && found[0] !== undefined) {
        owner = found[0].owner
        ctx.out.note(
          ctx.out.dim(
            `owner inferred from the chain: ${owner} (anybody can create a mandate naming an agent; pass --owner to pin it)`,
          ),
        )
      } else {
        throw usageError(
          found.length === 0
            ? `no mandate names agent ${agent}`
            : `${found.length} mandates name agent ${agent}`,
          'Pass --owner <address> to say whose mandate you mean.',
        )
      }
    }
    const fetched = await client.fetchMandateFor(owner, agent)
    mandate = fetched.mandate
    mandateAddress = fetched.address
  }

  if (owner === undefined || agent === undefined || mandateAddress === undefined) {
    throw usageError('could not work out the owner and agent')
  }
  if (mandate === null && opts.requireMandate) {
    throw usageError(
      `no mandate exists for owner ${owner} and agent ${agent}`,
      'Create one with `agentauth mandate create` (or check --owner / --agent).',
    )
  }
  const policy = mandate === null ? null : await client.fetchPolicy(mandateAddress)
  const policyAddress = (await relayPolicyPda(mandateAddress, client.programIds.relay)).address
  return { mandateAddress, policyAddress, owner, agent, mandate, policy }
}

export interface MintMeta {
  readonly address: Address
  readonly decimals: number
  readonly symbol: string | undefined
}

export async function mintMeta(ctx: Ctx, mint: Address): Promise<MintMeta> {
  const view = await ctx.client.fetchMint(mint)
  if (view === null) {
    throw usageError(`mint ${mint} does not exist on ${ctx.cluster}`, 'Check --mint and --cluster.')
  }
  return { address: mint, decimals: view.decimals, symbol: ctx.symbols.symbolOf(mint) }
}

/** Mint metadata of the policy budget mint, or `undefined` when there is no policy (then raw units). */
export async function budgetMint(
  ctx: Ctx,
  policy: RelayPolicy | null,
): Promise<MintMeta | undefined> {
  return policy === null ? undefined : mintMeta(ctx, policy.budgetMint)
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface StepOutcome {
  readonly label: string
  readonly signature: string | undefined
  readonly ok: boolean
  readonly error: AgentAuthError | null
  readonly explorer: string | undefined
}

/** Send one step. A failure that the RPC rejects before landing is decoded like a landed one. */
export async function sendOne(
  ctx: Ctx,
  step: StepLike,
  label: string,
  signers: readonly TransactionSigner[],
  opts: { skipPreflight?: boolean; computeUnitLimit?: number } = {},
): Promise<StepOutcome> {
  try {
    const res = await ctx.client.sendAndConfirm(step, {
      signers,
      ...(opts.skipPreflight === true ? { skipPreflight: true } : {}),
      ...(opts.computeUnitLimit === undefined ? {} : { computeUnitLimit: opts.computeUnitLimit }),
      programIds: ctx.client.programIds,
    })
    return {
      label,
      signature: res.signature,
      ok: res.ok,
      error: res.error,
      explorer: ctx.explorerTx(res.signature),
    }
  } catch (error) {
    const decoded = parseProgramError(error, { programIds: ctx.client.programIds })
    if (decoded === null) throw error
    return { label, signature: undefined, ok: false, error: decoded, explorer: undefined }
  }
}

export interface PlanResult {
  readonly simulated: boolean
  readonly steps: StepOutcome[]
}

/** Run an owner-signed plan in order: simulate (`--simulate`) or send, printing each step. */
export async function runPlan(
  ctx: Ctx,
  plan: Plan,
  signers: readonly TransactionSigner[],
): Promise<PlanResult> {
  const out = ctx.out
  const total = plan.steps.length
  const feePayer = signers[0]?.address
  if (feePayer === undefined) throw usageError('no signer for this plan')

  if (ctx.opts.simulate === true) {
    const steps: StepOutcome[] = []
    for (const [i, step] of plan.steps.entries()) {
      if (step.dependsOn.length > 0) {
        out.say(
          `  ${out.dim('-')} step ${i + 1}/${total} ${step.label}: not simulated (needs step ${step.dependsOn.map((d) => d + 1).join(', ')} to land first)`,
        )
        steps.push({
          label: step.label,
          signature: undefined,
          ok: true,
          error: null,
          explorer: undefined,
        })
        continue
      }
      const sim = await ctx.client.simulate(step, { feePayer, programIds: ctx.client.programIds })
      const units = sim.unitsConsumed === null ? '' : `, ${sim.unitsConsumed} compute units`
      out.say(
        `  ${sim.ok ? out.ok('ok') : out.bad('FAIL')} step ${i + 1}/${total} ${step.label}: simulated${sim.ok ? units : ` -> ${sim.error?.describe() ?? 'failed'}`}`,
      )
      steps.push({
        label: step.label,
        signature: undefined,
        ok: sim.ok,
        error: sim.error,
        explorer: undefined,
      })
      if (!sim.ok) {
        throw new CliError(
          'denied',
          `simulation of step ${i + 1}/${total} (${step.label}) failed`,
          {
            ...(sim.error ? { program: sim.error } : {}),
            data: { simulated: true },
          },
        )
      }
    }
    out.say(out.dim('Simulation only: nothing was sent (--simulate).'))
    return { simulated: true, steps }
  }

  const done: StepOutcome[] = []
  for (const [i, step] of plan.steps.entries()) {
    const res = await sendOne(ctx, step, step.label, signers)
    done.push(res)
    if (!res.ok) {
      const landed = done.slice(0, -1).filter((s) => s.signature !== undefined)
      throw new CliError('onchain', `step ${i + 1}/${total} (${step.label}) failed`, {
        ...(res.error ? { program: res.error } : {}),
        ...(landed.length > 0
          ? {
              hint: `${landed.length} earlier step(s) already landed; inspect with \`agentauth mandate show\` before retrying.`,
            }
          : {}),
        data: { steps: done.map(stepJson) },
      })
    }
    out.say(
      `  ${out.ok('ok')} step ${i + 1}/${total} ${step.label}  ${out.dim(String(res.signature))}`,
    )
    out.say(`     ${out.link(String(res.explorer))}`)
  }
  return { simulated: false, steps: done }
}

export function stepJson(s: StepOutcome): Record<string, unknown> {
  return {
    label: s.label,
    ok: s.ok,
    signature: s.signature ?? null,
    explorer: s.explorer ?? null,
    error: s.error,
  }
}

export function describeSteps(plan: Plan): string[] {
  return plan.steps.map(
    (s: PlanStep, i) =>
      `${i + 1}. ${s.label}: ${s.estimatedSizeBytes} B${s.fitsInOneTx ? '' : ' (TOO LARGE with compute budget)'}${s.dependsOn.length > 0 ? `, after step ${s.dependsOn.map((d) => d + 1).join(',')}` : ''}`,
  )
}
