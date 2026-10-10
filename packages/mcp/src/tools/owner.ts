import { randomBytes } from 'node:crypto'
import { isAddress, type Address } from '@solana/kit'
import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  expiresIn,
  mandatePda,
  parseLimitInput,
  parseUnits,
  planToUnsignedTransactions,
  stripSigners,
  type OnboardingSwap,
  type PermissionInput,
  type Plan,
} from '@agentauth-sol/sdk'
import { z } from 'zod'
import type { Context } from '../context'
import { buildReport } from '../report'
import { fail, ok } from '../reply'
import { tidy } from '../sanitize'
import { activityRows } from './agent'
import { DATA_NOTE, READ_ONLY, defineTool, strict, type ToolDef } from './define'

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const addressField = (what: string) =>
  z
    .string()
    .regex(ADDRESS_RE, 'a base58 Solana address')
    .refine(isAddress, 'not a valid address')
    .describe(what)
const decimalField = z.string().regex(/^\d{1,20}(\.\d{1,18})?$/, 'a decimal number such as "2.5"')
const agentField = addressField(
  'The agent wallet address. Defaults to the server --agent when omitted.',
).optional()

const PLAN_NOTE =
  'These transactions are UNSIGNED. Show the summary and warnings to the human owner. The owner reviews and signs in their OWN wallet; this server never sees or asks for the owner key. Submit steps in order and only after every step in depends_on is confirmed. The blockhash is valid for about 60 seconds: ask for a fresh plan if it expired.'

function resolveAgent(ctx: Context, given: string | undefined): Address {
  const agent = given ?? ctx.config.agent
  if (!agent || !isAddress(agent))
    throw new Error('no agent address: pass agent or start the server with --agent')
  return agent
}

function ownerOf(ctx: Context): Address {
  if (!ctx.config.owner) throw new Error('owner profile is not configured')
  return ctx.config.owner
}

/** Compile a plan into unsigned base64 transactions and a short human summary. */
async function planResult(
  ctx: Context,
  plan: Plan,
  urgent: boolean,
): Promise<ReturnType<typeof ok>> {
  const owner = ownerOf(ctx)
  const { value: blockhash } = await ctx.withTimeout(
    ctx.client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
    'reading the blockhash',
  )
  const clean = stripSigners(plan)
  const steps = planToUnsignedTransactions(clean, {
    feePayer: owner,
    blockhash,
    computeUnitLimit: 400_000,
    ...(urgent ? { microLamportsPerCu: 100_000n } : {}),
  })
  let planId: string | undefined
  if (ctx.ownerSigner) {
    planId = randomBytes(6).toString('hex')
    ctx.plans.set(planId, plan)
    if (ctx.plans.size > 20) {
      const first = ctx.plans.keys().next()
      if (!first.done) ctx.plans.delete(first.value)
    }
  }
  return ok({
    summary: tidy(plan.summary, 1500),
    warnings: plan.warnings.map((w) => tidy(w, 400)).slice(0, 15),
    transactions: steps.map((s, i) => ({
      step: i,
      label: tidy(s.label, 80),
      description: tidy(s.description, 300),
      expected_outcome: tidy(s.expectedOutcome, 300),
      base64: s.base64,
      size_bytes: s.sizeBytes,
      required_signers: s.requiredSigners,
      depends_on: s.dependsOn,
      await_confirmation: s.awaitConfirmation,
    })),
    fee_payer: owner,
    signing: PLAN_NOTE,
    ...(planId ? { dev_plan_id: planId } : {}),
  })
}

// ---------------------------------------------------------------------------------------------

const explainMandate = defineTool({
  name: 'owner_explain_mandate',
  title: 'Explain a mandate (owner view)',
  description: `Explains the mandate between the configured owner and an agent in plain language: status, every permission with limits, allowed recipients, and which actions are hard-enforced (relay) versus advisory. Read-only. ${DATA_NOTE}`,
  input: strict({ agent: agentField }),
  annotations: READ_ONLY,
  profiles: ['owner'],
  async handler(a, ctx) {
    const report = await buildReport(ctx, ownerOf(ctx), resolveAgent(ctx, a.agent), 'full')
    return ok(report.body)
  },
})

const swapSchema = strict({
  amm_program: addressField('AMM program id'),
  amm_authority: addressField('pool authority'),
  amm_config: addressField('AMM config account'),
  pool_state: addressField('pool state account'),
  input_vault: addressField('pool vault of the input token'),
  output_vault: addressField('pool vault of the output token'),
  observation_state: addressField('observation account'),
  in_mint: addressField('input token mint'),
  out_mint: addressField('output token mint'),
  in_account: addressField("owner's input token account"),
  out_account: addressField("owner's OWN output token account (swap output is forced here)"),
  floor_out: z
    .string()
    .regex(/^\d{1,18}$/)
    .describe('floor price numerator, raw units: at least floor_out out per floor_in in'),
  floor_in: z.string().regex(/^\d{1,18}$/),
  max_deadline_slots: z.number().int().min(1).max(9000),
  per_call_limit: decimalField.describe('swap per-call limit, input token units'),
  lifetime_limit: decimalField.describe('swap lifetime limit, input token units'),
})

const planOnboarding = defineTool({
  name: 'owner_plan_onboarding',
  title: 'Plan a new mandate (unsigned)',
  description: `Builds the UNSIGNED transactions that create a mandate for an agent: fund the agent for fees, create the mandate and its limits, delegate a bounded SPL allowance to the relay, and set the relay policy with the allowed recipients. Limits are decimal strings in token units; unlimited limits are not offered. Returns base64 transactions for the owner's wallet to sign, plus a summary and warnings that must be shown to the human. ${DATA_NOTE}`,
  input: strict({
    agent: addressField('The agent wallet address'),
    mint: addressField('Token mint the agent may pay with'),
    source_token_account: addressField("The owner's token account that pays"),
    recipients: z
      .array(addressField('Allowed recipient TOKEN ACCOUNT (not a wallet)'))
      .min(1)
      .max(8),
    per_call_limit: decimalField.describe('Largest single payment, token units'),
    lifetime_limit: decimalField.describe(
      'Total the agent may pay over the mandate lifetime, token units',
    ),
    delegate_cap: decimalField
      .optional()
      .describe('SPL allowance, token units. Default: lifetime_limit'),
    expires_in: z
      .string()
      .regex(/^\d{1,4}[smhdw]$/)
      .default('7d')
      .describe('Mandate lifetime, for example "24h" or "7d"'),
    fund_agent_sol: decimalField.default('0.005').describe('SOL sent to the agent for fees'),
    swap: swapSchema.optional().describe('Optional: enable one pinned pool swap'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const owner = ownerOf(ctx)
    const mint = a.mint as Address
    const decimals = await ctx.decimalsOf(mint)
    const perCall = parseLimitInput(a.per_call_limit, decimals)
    const lifetime = parseLimitInput(a.lifetime_limit, decimals)
    const permissions: PermissionInput[] = [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: lifetime,
        perTxLimit: perCall,
        discriminators: [TRANSFER_CHECKED_DISC],
      },
    ]
    let swap: OnboardingSwap | undefined
    if (a.swap) {
      const s = a.swap
      const inDecimals = await ctx.decimalsOf(s.in_mint as Address)
      permissions.push({
        program: s.amm_program as Address,
        spendLimit: parseLimitInput(s.lifetime_limit, inDecimals),
        perTxLimit: parseLimitInput(s.per_call_limit, inDecimals),
        discriminators: [SWAP_BASE_INPUT_DISC],
      })
      swap = {
        ammProgram: s.amm_program as Address,
        ammAuthority: s.amm_authority as Address,
        ammConfig: s.amm_config as Address,
        poolState: s.pool_state as Address,
        inputVault: s.input_vault as Address,
        outputVault: s.output_vault as Address,
        observationState: s.observation_state as Address,
        inMint: s.in_mint as Address,
        outMint: s.out_mint as Address,
        inTokenProgram: TOKEN_PROGRAM_ID,
        outTokenProgram: TOKEN_PROGRAM_ID,
        inAccount: s.in_account as Address,
        outAccount: s.out_account as Address,
        floorOut: BigInt(s.floor_out),
        floorIn: BigInt(s.floor_in),
        maxDeadlineSlots: s.max_deadline_slots,
      }
    }
    const plan = await ctx.withTimeout(
      ctx.client.plan.onboarding({
        owner: ctx.ownerSigner ?? owner,
        agent: a.agent as Address,
        expiry: expiresIn(a.expires_in),
        fundAgentLamports: parseUnits(a.fund_agent_sol, 9),
        token: {
          mint,
          source: a.source_token_account as Address,
          delegateCap: a.delegate_cap
            ? parseUnits(a.delegate_cap, decimals)
            : lifetime === 'unlimited'
              ? 0n
              : lifetime,
        },
        permissions,
        recipients: a.recipients as Address[],
        ...(swap ? { swap } : {}),
      }),
      'building the plan',
    )
    return planResult(ctx, plan, false)
  },
})

const planUnwind = defineTool({
  name: 'owner_plan_unwind',
  title: 'Plan the kill switch (unsigned)',
  description: `Builds ONE unsigned transaction that revokes the SPL delegation, revokes the mandate and closes the relay policy, so the agent can move nothing more. Past payments are not undone. Returns base64 for the owner's wallet to sign. ${DATA_NOTE}`,
  input: strict({ agent: agentField }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const plan = await ctx.withTimeout(
      ctx.client.plan.unwind({
        owner: ctx.ownerSigner ?? ownerOf(ctx),
        agent: resolveAgent(ctx, a.agent),
      }),
      'building the plan',
    )
    return planResult(ctx, plan, true)
  },
})

const scopeField = z
  .enum(['relay', 'mandate', 'both'])
  .default('both')
  .describe('relay: stop only relay actions; mandate: stop the core mandate; both (default)')

const planPause = defineTool({
  name: 'owner_plan_pause',
  title: 'Plan a pause (unsigned)',
  description: `Builds an unsigned transaction that pauses the agent (reversible). While paused, relay payments fail with relay error 116. ${DATA_NOTE}`,
  input: strict({ agent: agentField, scope: scopeField }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const plan = await ctx.withTimeout(
      ctx.client.plan.pause({
        owner: ctx.ownerSigner ?? ownerOf(ctx),
        agent: resolveAgent(ctx, a.agent),
        scope: a.scope,
      }),
      'building the plan',
    )
    return planResult(ctx, plan, true)
  },
})

const planResume = defineTool({
  name: 'owner_plan_resume',
  title: 'Plan a resume (unsigned)',
  description: `Builds an unsigned transaction that lifts a pause. ${DATA_NOTE}`,
  input: strict({ agent: agentField, scope: scopeField }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const plan = await ctx.withTimeout(
      ctx.client.plan.resume({
        owner: ctx.ownerSigner ?? ownerOf(ctx),
        agent: resolveAgent(ctx, a.agent),
        scope: a.scope,
      }),
      'building the plan',
    )
    return planResult(ctx, plan, false)
  },
})

const planRevokePermission = defineTool({
  name: 'owner_plan_revoke_permission',
  title: 'Plan a permission revoke (unsigned)',
  description: `Builds an unsigned transaction that removes one program permission from the mandate. With keep_instructions it re-adds the slot with only those instruction discriminators and the remaining budget. After a plain removal the agent gets AgentAuth error 6 for that program. ${DATA_NOTE}`,
  input: strict({
    agent: agentField,
    program: addressField('The program whose permission is removed'),
    keep_instructions: z
      .array(z.string().regex(/^[0-9a-fA-F]{16}$/))
      .min(1)
      .max(8)
      .optional()
      .describe('Instruction discriminators (16 hex characters) to keep'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const plan = await ctx.withTimeout(
      ctx.client.plan.revokePermission({
        owner: ctx.ownerSigner ?? ownerOf(ctx),
        agent: resolveAgent(ctx, a.agent),
        program: a.program as Address,
        ...(a.keep_instructions
          ? { replaceWith: { discriminators: a.keep_instructions.map((d) => d.toLowerCase()) } }
          : {}),
      }),
      'building the plan',
    )
    return planResult(ctx, plan, true)
  },
})

const ownerActivity = defineTool({
  name: 'owner_activity',
  title: 'Agent activity (owner view)',
  description: `Lists recent activity of the mandate between the configured owner and an agent, newest first, including blocked attempts with the decoded error. Read-only. ${DATA_NOTE}`,
  input: strict({ agent: agentField, limit: z.number().int().min(1).max(20).default(10) }),
  annotations: READ_ONLY,
  profiles: ['owner'],
  async handler(a, ctx) {
    return ok(await activityRows(ctx, ownerOf(ctx), resolveAgent(ctx, a.agent), a.limit))
  },
})

const devSign = defineTool({
  name: 'owner_dev_sign_and_send',
  title: 'DEV ONLY: sign and send a plan',
  description: `DEMO ONLY (server started with --unsafe-dev-sign, never on mainnet). Signs the steps of a plan built earlier in THIS process (dev_plan_id) with a local demo owner key and sends them in order. Real owners sign in their own wallet instead. ${DATA_NOTE}`,
  input: strict({ dev_plan_id: z.string().regex(/^[0-9a-f]{12}$/) }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  profiles: ['owner'],
  async handler(a, ctx) {
    const signer = ctx.ownerSigner
    const plan = ctx.plans.get(a.dev_plan_id)
    if (!signer || !plan)
      return fail('NOT_FOUND', 'No such plan in this process (or dev signing is off).')
    ctx.plans.delete(a.dev_plan_id)
    const results: Array<Record<string, unknown>> = []
    for (const [i, step] of plan.steps.entries()) {
      const res = await ctx.client.sendAndConfirm(step, { signers: [signer], timeoutMs: 45_000 })
      results.push({
        step: i,
        ok: res.ok,
        signature: res.signature,
        ...(res.error
          ? { error: { program: res.error.program, code: res.error.code, name: res.error.name } }
          : {}),
      })
      if (!res.ok) break
    }
    return ok({ results, warning: 'Signed with a local demo key. Not for real funds.' })
  },
})

export const OWNER_TOOLS: readonly ToolDef[] = [
  explainMandate,
  planOnboarding,
  planUnwind,
  planPause,
  planResume,
  planRevokePermission,
  ownerActivity,
]
export const DEV_SIGN_TOOL = devSign

// ---------------------------------------------------------------------------------------------

const ownerAgentFields = {
  owner: addressField('The mandate owner wallet'),
  agent: addressField('The agent wallet'),
}

const observerExplain = defineTool({
  name: 'observer_explain_mandate',
  title: 'Explain any mandate (read-only)',
  description: `Explains the mandate between any owner and agent pair (public chain data): status, limits, recipients, hard versus advisory enforcement. Cannot change anything. ${DATA_NOTE}`,
  input: strict(ownerAgentFields),
  annotations: READ_ONLY,
  profiles: ['observer'],
  async handler(a, ctx) {
    const report = await buildReport(ctx, a.owner as Address, a.agent as Address, 'full')
    return ok(report.body)
  },
})

const observerActivity = defineTool({
  name: 'observer_activity',
  title: 'Activity of any mandate (read-only)',
  description: `Lists recent activity of the mandate between any owner and agent pair, newest first. Cannot change anything. ${DATA_NOTE}`,
  input: strict({ ...ownerAgentFields, limit: z.number().int().min(1).max(20).default(10) }),
  annotations: READ_ONLY,
  profiles: ['observer'],
  async handler(a, ctx) {
    return ok(await activityRows(ctx, a.owner as Address, a.agent as Address, a.limit))
  },
})

export const OBSERVER_TOOLS: readonly ToolDef[] = [observerExplain, observerActivity]

/** Mandate address of a pair, for resources. */
export async function mandateAddressOf(
  ctx: Context,
  owner: Address,
  agent: Address,
): Promise<Address> {
  return (await mandatePda(owner, agent, ctx.client.programIds.agentAuth)).address
}
