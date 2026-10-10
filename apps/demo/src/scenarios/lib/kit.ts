/**
 * Beats that several scenarios share: onboarding (two owner transactions), the plain-English
 * explanation of the result, and the one-transaction unwind.
 */
import { mandatePda, revokeDelegateIx, type Mandate, type RelayPolicy } from '@agentauth-sol/sdk'
import type { Address, KeyPairSigner } from '@solana/kit'
import { fetchTokenAccount } from '../../lib/env'
import { c, short, wrapText } from './ui'
import { planOnboarding, type Ctx, type OnboardParams } from './ctx'

export interface Onboarded {
  readonly mandate: Address
  readonly policy: RelayPolicy
  readonly mandateAccount: Mandate
}

/** Run the onboarding plan as two narrated owner transactions and print the explanation. */
export async function onboardBeats(ctx: Ctx, p: OnboardParams, idPrefix = 'S'): Promise<Onboarded> {
  const plan = await planOnboarding(ctx, p)
  const { run } = ctx
  run.say(plan.summary)
  for (const w of plan.warnings) run.say(`plan note: ${w}`)
  let i = 1
  for (const step of plan.steps) {
    await run.attempt({
      id: `${idPrefix}${i}`,
      title: `Onboarding transaction ${i} of ${plan.steps.length}: ${step.label}`,
      doing: `${step.description} (${step.instructions.length} instructions, ${step.estimatedSizeBytes} bytes of ${1232} allowed)`,
      who: `OWNER ${short(p.owner.address)} (the human; the only party that signs onboarding)`,
      actor: 'owner',
      signers: [p.owner],
      build: () => step.instructions,
      expect: { ok: true },
    })
    i++
  }
  const mandate = (await mandatePda(p.owner.address, p.agent, ctx.env.programIds.agentAuth)).address
  const view = await ctx.client.inspect(mandate, { budgetDecimals: 6 })
  if (view.mandate === null || view.policy === null || view.explanation === null) {
    throw new Error('onboarding finished but the mandate or the relay policy is not readable')
  }
  run.out()
  run.out(c.bold('  What the owner just granted, in plain English (SDK explainMandate):'))
  run.out(`    ${view.explanation.headline}`)
  for (const [title, list] of [
    ['can', view.explanation.can],
    ['cannot', view.explanation.cannot],
    ['warnings', view.explanation.warnings],
  ] as const) {
    for (const line of list) for (const w of wrapText(`${title}: ${line}`, 92)) run.out(`    ${w}`)
  }
  for (const e of view.explanation.enforcement) {
    for (const w of wrapText(`enforcement: ${e.action} -> ${e.level}`, 92)) run.out(`    ${w}`)
  }
  return { mandate, policy: view.policy, mandateAccount: view.mandate }
}

/** The one-transaction unwind of DEMO-SCRIPT beat 8.1 (Revoke, revoke_mandate, close_policy). */
export async function unwindBeat(
  ctx: Ctx,
  owner: KeyPairSigner,
  agent: Address,
  id: string,
): Promise<void> {
  const plan = await ctx.client.plan.unwind({ owner, agent })
  if (plan.steps.length !== 1)
    throw new Error(`unwind should be one transaction, got ${plan.steps.length}`)
  const step = plan.steps[0]
  if (step === undefined) throw new Error('empty unwind plan')
  await ctx.run.attempt({
    id,
    title: 'One-transaction unwind',
    doing: `${step.description} (${step.estimatedSizeBytes} bytes of 1232 allowed)`,
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: () => step.instructions,
    expect: { ok: true },
  })
}

/** Delegate and balance of a token account, for a one-line fact. */
export async function delegationLine(ctx: Ctx, account: Address): Promise<string> {
  const t = await fetchTokenAccount(ctx.chain, account)
  if (t === null) return `${short(account)} does not exist`
  return `balance ${t.amount} raw, delegate ${t.delegate === null ? 'none' : short(t.delegate)}, delegated ${t.delegatedAmount} raw`
}

/**
 * An aborted earlier run can leave an SPL delegation on the owner's account. The SDK refuses to
 * silently replace one, so clear it first (a setup step, printed as a fact).
 */
export async function clearStaleDelegation(
  ctx: Ctx,
  owner: KeyPairSigner,
  source: Address,
): Promise<void> {
  const t = await fetchTokenAccount(ctx.chain, source)
  if (t === null || t.delegate === null) return
  await ctx.chain.send([revokeDelegateIx({ source, owner })], owner)
  ctx.run.fact(
    `setup: revoked a leftover delegation to ${short(t.delegate)} from an earlier aborted run`,
  )
}

/** Onboard without narration (fixtures of the attack suite). Throws if a step does not land. */
export async function onboardQuiet(ctx: Ctx, p: OnboardParams): Promise<Onboarded> {
  const plan = await planOnboarding(ctx, p)
  for (const step of plan.steps) {
    const res = await ctx.client.sendAndConfirm(step, { signers: [p.owner] })
    if (!res.ok)
      throw new Error(
        `fixture onboarding step "${step.label}" failed: ${res.error?.describe() ?? 'unknown'}`,
      )
  }
  const mandate = (await mandatePda(p.owner.address, p.agent, ctx.env.programIds.agentAuth)).address
  const mandateAccount = await ctx.client.fetchMandate(mandate)
  const policy = await ctx.client.fetchPolicy(mandate)
  if (mandateAccount === null || policy === null)
    throw new Error('fixture onboarding left no mandate or policy')
  return { mandate, policy, mandateAccount }
}
