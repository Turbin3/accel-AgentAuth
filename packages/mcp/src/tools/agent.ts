import {
  isAddress,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Address,
} from '@solana/kit'
import {
  AgentAuthError,
  AGENT_AUTH_ERRORS,
  RELAY_ERRORS,
  TOKEN_ERRORS,
  SYSTEM_ERRORS,
  checkVerify,
  errorFromCode,
  formatUnits,
  isoOfSeconds,
  mandatePda,
  parseProgramError,
  parseUnits,
  preflightFailureToError,
  relaySwapIx,
  relayTransferIx,
  SdkError,
  ValidationError,
  type ActivityItem,
  type ErrorSpec,
  type RelayPolicy,
  type SendResult,
  type TableProgram,
} from '@agentauth-sol/sdk'
import { z } from 'zod'
import type { Context } from '../context'
import { buildReport, recipientLabel, resolveRecipient } from '../report'
import { DENIAL_GUIDANCE, denial, fail, guardDenial, ok } from '../reply'
import { safeString, untrusted } from '../sanitize'
import { DATA_NOTE, READ_ONLY, defineTool, strict, type ToolDef } from './define'

const DECIMAL = /^\d{1,20}(\.\d{1,18})?$/
const amountField = z.string().regex(DECIMAL, 'a decimal number such as "2.5"')
const keyField = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,64}$/, '8 to 64 characters from A-Z a-z 0-9 _ . : -')
  .describe(
    'A fresh unique id for THIS intended payment (for example a UUID). Reuse the same id only to retry the same payment after a network error: then the server returns the first result instead of paying twice.',
  )

function agentIdentity(ctx: Context): {
  owner: Address
  agent: NonNullable<Context['agentSigner']>
} {
  const owner = ctx.config.owner
  const agent = ctx.agentSigner
  if (!owner || !agent) throw new Error('agent profile is not configured')
  return { owner, agent }
}

async function loadPolicy(
  ctx: Context,
  owner: Address,
  agent: Address,
): Promise<{ mandate: Address; policy: RelayPolicy | null }> {
  const mandate = (await mandatePda(owner, agent, ctx.client.programIds.agentAuth)).address
  const policy = await ctx.withTimeout(ctx.client.fetchPolicy(mandate), 'reading the relay policy')
  return { mandate, policy }
}

const NO_POLICY =
  'No relay policy exists for this mandate (it was never set up or the owner closed it). Nothing can be paid or swapped.'

function sdkMessage(e: unknown): string {
  return e instanceof SdkError ? e.message : 'invalid input'
}

/** Wait for / replay / reject according to the idempotency store. `null` means: go ahead and send. */
async function idempotencyGate(
  ctx: Context,
  key: string,
  fingerprint: string,
): Promise<ReturnType<typeof ok> | null> {
  for (;;) {
    const b = ctx.idempotency.begin(key, fingerprint, ctx.now())
    if (b.kind === 'new') return null
    if (b.kind === 'conflict') {
      return fail(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency_key was already used for a different request. Use a new key for a new payment.',
      )
    }
    if (b.kind === 'inflight') {
      await b.wait
      continue
    }
    if (b.state === 'indeterminate') {
      return fail(
        'OUTCOME_UNKNOWN',
        'The first attempt with this idempotency_key may or may not have landed. Nothing is sent again. Check agentauth_activity before doing anything else.',
        { first_attempt: b.result },
      )
    }
    return ok({ ...b.result, replayed: true })
  }
}

/** Rate limit and duplicate-window checks; releases the key when it refuses. */
function sendGuards(
  ctx: Context,
  key: string,
  fingerprint: string,
  allowRepeat: boolean,
): ReturnType<typeof fail> | null {
  if (!ctx.payLimiter.tryAcquire(ctx.now())) {
    ctx.idempotency.release(key)
    return fail(
      'RATE_LIMITED',
      `At most ${ctx.config.maxPaysPerMinute} payments per minute from this server. Wait, then ask the user before continuing.`,
    )
  }
  if (
    !allowRepeat &&
    ctx.idempotency.isRecentDuplicate(
      fingerprint,
      ctx.now(),
      ctx.config.duplicateWindowSeconds * 1000,
      key,
    )
  ) {
    ctx.idempotency.release(key)
    return fail(
      'DUPLICATE_SUSPECTED',
      `An identical request was sent in the last ${ctx.config.duplicateWindowSeconds} seconds. If the user explicitly wants the same payment again, repeat the call with allow_repeat=true.`,
    )
  }
  return null
}

type Outcome =
  | { kind: 'sent'; res: SendResult }
  | { kind: 'rejected'; error: AgentAuthError }
  | { kind: 'not_landed'; message: string }
  | { kind: 'unknown' }

/** Sign and send one instruction as the agent and classify what happened. */
async function sendAsAgent(
  ctx: Context,
  ix: Awaited<ReturnType<typeof relayTransferIx>>,
): Promise<Outcome> {
  const { agent } = agentIdentity(ctx)
  try {
    const res = await ctx.client.sendAndConfirm([ix], {
      signers: [agent],
      computeUnitLimit: 400_000,
      skipPreflight: ctx.config.landDenied,
      timeoutMs: 45_000,
    })
    return { kind: 'sent', res }
  } catch (e) {
    if (e instanceof SdkError && e.code === 'TX_EXPIRED') {
      return {
        kind: 'not_landed',
        message: 'The transaction expired before it landed. Nothing was paid.',
      }
    }
    const decoded = parseProgramError(e)
    if (decoded) return { kind: 'rejected', error: decoded }
    if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
      return {
        kind: 'not_landed',
        message:
          'The RPC simulation rejected the transaction, so nothing was sent or paid (for example the agent has no SOL left for fees).',
      }
    }
    ctx.log.warn('send_outcome_unknown', { error: e instanceof Error ? e.name : typeof e })
    return { kind: 'unknown' }
  }
}

/**
 * Relay 105 covers several account-state problems. When the payment is larger than the SPL
 * allowance (or the source balance) that is left, say so instead of blaming the owner's setup.
 */
async function transferHint(
  ctx: Context,
  mandate: Address,
  err: AgentAuthError,
  amount: bigint,
  decimals: number,
): Promise<Record<string, unknown>> {
  if (err.program !== 'relay' || err.code !== 105) return {}
  try {
    const view = await ctx.withTimeout(ctx.client.inspect(mandate), 'reading the allowance')
    const left = view.delegation
    if (left && left.delegate !== null && amount > left.delegatedAmount) {
      return {
        hint: `amount is larger than the SPL allowance left (${formatUnits(left.delegatedAmount, decimals)}). The owner would have to delegate more to the relay for this payment.`,
      }
    }
    if (view.balance !== null && amount > view.balance) {
      return {
        hint: `amount is larger than the source account balance (${formatUnits(view.balance, decimals)}).`,
      }
    }
  } catch {
    // keep the generic hint
  }
  return {}
}

function settle(
  ctx: Context,
  key: string,
  fingerprint: string,
  outcome: Outcome,
  success: Record<string, unknown>,
  denialExtra: Record<string, unknown> = {},
): ReturnType<typeof ok> {
  if (outcome.kind === 'unknown') {
    ctx.idempotency.markSent(fingerprint, ctx.now())
    ctx.idempotency.finish(key, 'indeterminate', { note: 'send outcome unknown' }, ctx.now())
    return fail(
      'OUTCOME_UNKNOWN',
      'The transaction was submitted but its result could not be confirmed. Do NOT pay again. Check agentauth_activity, then tell the user.',
    )
  }
  if (outcome.kind === 'not_landed') {
    ctx.idempotency.release(key)
    return fail('RPC_ERROR', outcome.message, {
      retry: 'You may repeat the same request with the same idempotency_key.',
    })
  }
  if (outcome.kind === 'rejected') {
    ctx.idempotency.release(key)
    return denial(outcome.error, 'rpc_preflight', denialExtra)
  }
  const { res } = outcome
  if (res.ok) {
    ctx.idempotency.markSent(fingerprint, ctx.now())
    const body = { ...success, signature: res.signature }
    ctx.idempotency.finish(key, 'done', body, ctx.now())
    return ok(body)
  }
  ctx.idempotency.release(key)
  if (res.error) return denial(res.error, 'onchain', { signature: res.signature, ...denialExtra })
  return fail('RPC_ERROR', 'The transaction failed without a decodable program error.', {
    signature: res.signature,
  })
}

// ---------------------------------------------------------------------------------------------

const status = defineTool({
  name: 'agentauth_status',
  title: 'Mandate status',
  description: `Call this first. Shows your on-chain mandate: status, expiry, remaining budget in token units, the allowed recipients (token accounts, with labels) and which actions are hard-enforced by the relay versus advisory. ${DATA_NOTE}`,
  input: strict({}),
  annotations: READ_ONLY,
  profiles: ['agent'],
  async handler(_args, ctx) {
    const { owner, agent } = agentIdentity(ctx)
    const report = await buildReport(ctx, owner, agent.address, 'agent')
    return ok(report.body)
  },
})

const checkAction = defineTool({
  name: 'agentauth_check_action',
  title: 'Check an action (dry run)',
  description: `Asks "would this be allowed?" without sending anything. Mirrors the on-chain checks for the current chain state and says whether the action is hard-enforced (relay pay or swap) or advisory. It is a prediction, not a guarantee. ${DATA_NOTE}`,
  input: strict({
    action: z.enum(['pay', 'swap', 'other_program']),
    recipient: z
      .string()
      .max(64)
      .optional()
      .describe('pay: a label from agentauth_status or a token account address'),
    amount: amountField.optional().describe('pay: token units. swap: input token units'),
    min_out: amountField
      .optional()
      .describe('swap: minimum output in output-token units (default 0)'),
    program: z.string().max(64).optional().describe('other_program: program id'),
    instruction: z
      .string()
      .regex(/^[0-9a-fA-F]{16}$/)
      .optional()
      .describe('other_program: 8-byte discriminator, 16 hex characters'),
    raw_amount: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe('other_program: amount in the program raw units'),
  }),
  annotations: READ_ONLY,
  profiles: ['agent'],
  async handler(a, ctx) {
    const { owner, agent } = agentIdentity(ctx)
    const { policy } = await loadPolicy(ctx, owner, agent.address)
    const answer = (
      err: AgentAuthError | null,
      enforcement: string,
      extra: Record<string, unknown> = {},
    ) =>
      ok({
        would_be_allowed: err === null,
        ...(err
          ? {
              error: {
                program: err.program,
                code: err.code,
                name: err.name,
                message: safeString(err.message, 300),
                hint: safeString(err.hint, 300),
              },
              guidance: DENIAL_GUIDANCE,
            }
          : {}),
        enforcement,
        note: 'Pre-flight is a prediction from current chain state. The chain decides.',
        ...extra,
      })

    if (a.action === 'pay') {
      if (!policy) return fail('NOT_AVAILABLE', NO_POLICY)
      if (!a.recipient || !a.amount) return fail('INVALID_INPUT', 'pay needs recipient and amount')
      const decimals = await ctx.decimalsOf(policy.budgetMint)
      let amount: bigint
      try {
        amount = parseUnits(a.amount, decimals)
      } catch (e) {
        return fail('INVALID_INPUT', sdkMessage(e))
      }
      const destination = resolveRecipient(ctx, policy, a.recipient)
      if (!isAddress(destination))
        return fail('INVALID_INPUT', 'recipient is not a label or an address')
      const pre = await ctx.withTimeout(
        ctx.client.preflightTransfer({ owner, agent: agent.address, destination, amount }),
        'pre-flight',
      )
      return answer(pre.ok ? null : preflightFailureToError(pre), 'hard (relay)')
    }
    if (a.action === 'swap') {
      if (!policy?.swap) return fail('NOT_AVAILABLE', 'The policy does not enable swaps.')
      if (!a.amount) return fail('INVALID_INPUT', 'swap needs amount')
      try {
        const amountIn = parseUnits(a.amount, await ctx.decimalsOf(policy.swap.inMint))
        const minOut = parseUnits(a.min_out ?? '0', await ctx.decimalsOf(policy.swap.outMint))
        const slot = await ctx.withTimeout(
          ctx.client.rpc.getSlot({ commitment: 'confirmed' }).send(),
          'reading the slot',
        )
        const pre = await ctx.withTimeout(
          ctx.client.preflightSwap({
            owner,
            agent: agent.address,
            amountIn,
            minOut,
            deadlineSlot: slot + BigInt(deadlineWindow(policy)),
          }),
          'pre-flight',
        )
        return answer(
          pre.ok ? null : preflightFailureToError(pre),
          'hard (relay)',
          pre.ok ? { effective_min_out_raw: pre.effectiveMinOut } : {},
        )
      } catch (e) {
        if (e instanceof ValidationError) return fail('INVALID_INPUT', e.message)
        throw e
      }
    }
    // other_program: advisory
    if (!a.program || !isAddress(a.program) || !a.instruction || !a.raw_amount) {
      return fail('INVALID_INPUT', 'other_program needs program, instruction and raw_amount')
    }
    const { mandate } = await ctx.client.fetchMandateFor(owner, agent.address)
    const now = await ctx.withTimeout(ctx.client.getClusterTime(), 'reading the cluster clock')
    const r = checkVerify(
      mandate,
      {
        owner,
        agent: agent.address,
        targetProgram: a.program,
        discriminator: a.instruction.toLowerCase(),
        amount: BigInt(a.raw_amount),
      },
      { now },
    )
    return answer(
      r.ok ? null : preflightFailureToError(r),
      'advisory (only a program that calls verify is bound by this)',
      {
        limits_unit: 'raw units of that program; counters are unit-less',
      },
    )
  },
})

/** Slots between "now" and the deadline of a swap: inside the policy window, with margin. */
function deadlineWindow(policy: RelayPolicy): number {
  const max = policy.swap?.maxDeadlineSlots ?? 2
  return Math.max(2, Math.min(100, Math.floor((max * 2) / 3)))
}

const pay = defineTool({
  name: 'agentauth_pay',
  title: 'Pay an allowed recipient',
  description: `Pays an allowed recipient through the relay (hard-enforced on chain: allowlisted recipient, per-call and lifetime limits, owner pause or revoke). amount is a decimal string in token units. A denial comes back as {denied:true, program, code, name, hint}: STOP and report it to the user. Never retry a denied payment with a different recipient, amount, split or route. ${DATA_NOTE}`,
  input: strict({
    recipient: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'A label from agentauth_status (for example "recipient-1") or the token account address',
      ),
    amount: amountField,
    idempotency_key: keyField,
    allow_repeat: z
      .boolean()
      .optional()
      .describe(
        'Only when the user explicitly asked for the identical payment again within the duplicate window',
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['agent'],
  async handler(a, ctx) {
    const { owner, agent } = agentIdentity(ctx)
    const { mandate, policy } = await loadPolicy(ctx, owner, agent.address)
    if (!policy) return fail('NOT_AVAILABLE', NO_POLICY)
    const decimals = await ctx.decimalsOf(policy.budgetMint)
    let amount: bigint
    try {
      amount = parseUnits(a.amount, decimals)
    } catch (e) {
      return fail('INVALID_INPUT', sdkMessage(e))
    }
    if (amount <= 0n) return fail('INVALID_INPUT', 'amount must be greater than zero')
    if (ctx.config.maxAmount !== undefined && amount > parseUnits(ctx.config.maxAmount, decimals)) {
      return guardDenial(
        'MaxAmountExceeded',
        `This server is configured with a per-payment cap of ${ctx.config.maxAmount}.`,
      )
    }
    const destination = resolveRecipient(ctx, policy, a.recipient)
    if (!isAddress(destination))
      return fail(
        'INVALID_INPUT',
        'recipient must be a label from agentauth_status or a token account address',
      )
    const fingerprint = `transfer|${destination}|${amount}`

    const early = await idempotencyGate(ctx, a.idempotency_key, fingerprint)
    if (early) return early
    const blocked = sendGuards(ctx, a.idempotency_key, fingerprint, a.allow_repeat === true)
    if (blocked) return blocked

    try {
      const pre = await ctx.withTimeout(
        ctx.client.preflightTransfer({ owner, agent: agent.address, destination, amount }),
        'pre-flight',
      )
      if (!pre.ok && !ctx.config.landDenied) {
        ctx.idempotency.release(a.idempotency_key)
        const err = preflightFailureToError(pre)
        return denial(err, 'preflight', {
          attempted: { recipient: recipientLabel(ctx, policy, destination), amount: a.amount },
          ...(await transferHint(ctx, mandate, err, amount, decimals)),
        })
      }
      const ix = await relayTransferIx({
        agent,
        policy,
        destination: destination as Address,
        amount,
        relayProgram: ctx.client.programIds.relay,
        agentAuthProgram: ctx.client.programIds.agentAuth,
      })
      const outcome = await sendAsAgent(ctx, ix)
      const failed =
        outcome.kind === 'rejected'
          ? outcome.error
          : outcome.kind === 'sent'
            ? outcome.res.error
            : undefined
      const hint = failed ? await transferHint(ctx, mandate, failed, amount, decimals) : {}
      return settle(
        ctx,
        a.idempotency_key,
        fingerprint,
        outcome,
        {
          paid: {
            amount: a.amount,
            token_mint: policy.budgetMint,
            recipient: recipientLabel(ctx, policy, destination),
            recipient_token_account: destination,
          },
          enforcement: 'hard (relay)',
          next: 'Call agentauth_status to see the remaining budget.',
        },
        hint,
      )
    } catch (e) {
      ctx.idempotency.release(a.idempotency_key)
      throw e
    }
  },
})

const swap = defineTool({
  name: 'agentauth_swap',
  title: 'Swap on the pinned pool',
  description: `Swaps token units on the ONE pool pinned in the policy; the output always goes to the owner's own account and the relay enforces a floor price (hard-enforced; a static price guard, not MEV protection). Available only when the policy enables swaps. amount_in is a decimal string. A denial means STOP and report. ${DATA_NOTE}`,
  input: strict({
    amount_in: amountField,
    min_out: amountField
      .optional()
      .describe(
        'Your minimum output in output-token units (default 0). The relay applies max(min_out, floor).',
      ),
    idempotency_key: keyField,
    allow_repeat: z.boolean().optional(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  profiles: ['agent'],
  async handler(a, ctx) {
    const { owner, agent } = agentIdentity(ctx)
    const { policy } = await loadPolicy(ctx, owner, agent.address)
    if (!policy) return fail('NOT_AVAILABLE', NO_POLICY)
    if (!policy.swap) return fail('NOT_AVAILABLE', 'The policy does not enable swaps.')
    let amountIn: bigint
    let minOut: bigint
    try {
      amountIn = parseUnits(a.amount_in, await ctx.decimalsOf(policy.swap.inMint))
      minOut = parseUnits(a.min_out ?? '0', await ctx.decimalsOf(policy.swap.outMint))
    } catch (e) {
      return fail('INVALID_INPUT', sdkMessage(e))
    }
    if (amountIn <= 0n) return fail('INVALID_INPUT', 'amount_in must be greater than zero')
    const fingerprint = `swap|${amountIn}|${minOut}`

    const early = await idempotencyGate(ctx, a.idempotency_key, fingerprint)
    if (early) return early
    const blocked = sendGuards(ctx, a.idempotency_key, fingerprint, a.allow_repeat === true)
    if (blocked) return blocked

    try {
      const slot = await ctx.withTimeout(
        ctx.client.rpc.getSlot({ commitment: 'confirmed' }).send(),
        'reading the slot',
      )
      const deadlineSlot = slot + BigInt(deadlineWindow(policy))
      const pre = await ctx.withTimeout(
        ctx.client.preflightSwap({ owner, agent: agent.address, amountIn, minOut, deadlineSlot }),
        'pre-flight',
      )
      if (!pre.ok && !ctx.config.landDenied) {
        ctx.idempotency.release(a.idempotency_key)
        return denial(preflightFailureToError(pre), 'preflight', {
          attempted: { amount_in: a.amount_in },
        })
      }
      const ix = await relaySwapIx({
        agent,
        policy,
        amountIn,
        minOut,
        deadlineSlot,
        relayProgram: ctx.client.programIds.relay,
        agentAuthProgram: ctx.client.programIds.agentAuth,
      })
      const outcome = await sendAsAgent(ctx, ix)
      return settle(ctx, a.idempotency_key, fingerprint, outcome, {
        swapped: {
          amount_in: a.amount_in,
          in_mint: policy.swap.inMint,
          out_mint: policy.swap.outMint,
          output_goes_to: policy.swap.outAccount,
        },
        enforcement: 'hard (relay)',
        next: 'Call agentauth_activity or agentauth_status to see the result.',
      })
    } catch (e) {
      ctx.idempotency.release(a.idempotency_key)
      throw e
    }
  },
})

const TABLES: Record<TableProgram, readonly ErrorSpec[]> = {
  agent_auth: AGENT_AUTH_ERRORS,
  relay: RELAY_ERRORS,
  token: TOKEN_ERRORS,
  system: SYSTEM_ERRORS,
  mock_amm: [],
}

const explainDenial = defineTool({
  name: 'agentauth_explain_denial',
  title: 'Explain a denial',
  description: `Explains an error code or transaction logs in plain language, with the fix that the OWNER can apply. It never suggests a way around a denial. Codes overlap between programs: give program when you know it. ${DATA_NOTE}`,
  input: strict({
    code: z.number().int().min(0).max(100000).optional(),
    program: z.enum(['agent_auth', 'relay', 'token', 'system', 'mock_amm']).optional(),
    logs: z
      .array(z.string().max(400))
      .max(50)
      .optional()
      .describe('Transaction log lines; the failing program is read from them'),
  }),
  annotations: READ_ONLY,
  profiles: ['agent', 'owner', 'observer'],
  async handler(a, ctx) {
    if (a.logs && a.logs.length > 0) {
      const e = parseProgramError(a.logs, { programIds: ctx.client.programIds })
      if (!e)
        return ok({
          matches: [],
          note: 'No AgentAuth, relay, token or system program error was found in these logs.',
        })
      return ok({ matches: [describe(e)], guidance: DENIAL_GUIDANCE })
    }
    if (a.code === undefined) return fail('INVALID_INPUT', 'give a code or logs')
    const programs = a.program ? [a.program] : (Object.keys(TABLES) as TableProgram[])
    const matches: Array<Record<string, unknown>> = []
    for (const program of programs) {
      if (TABLES[program].some((s) => s.code === a.code))
        matches.push(describe(errorFromCode(program, a.code)))
    }
    return ok({
      matches,
      ...(matches.length === 0 ? { note: 'No known program has this code.' } : {}),
      ...(matches.length > 1
        ? { ambiguous: 'Several programs use this code. Pass program, or the logs, to be sure.' }
        : {}),
      guidance: DENIAL_GUIDANCE,
    })
  },
})

function describe(e: AgentAuthError): Record<string, unknown> {
  return {
    program: e.program,
    code: e.code,
    name: e.name,
    meaning: safeString(e.message, 300),
    owner_fix: safeString(e.hint, 300),
  }
}

function itemView(
  ctx: Context,
  policy: RelayPolicy | null,
  decimals: number | null,
  it: ActivityItem,
): Record<string, unknown> {
  const unitsKnown = decimals !== null && (it.kind === 'relay_transfer' || it.kind === 'relay_swap')
  return {
    signature: it.signature,
    time: it.blockTime === null ? null : isoOfSeconds(it.blockTime),
    kind: it.kind,
    ok: it.ok,
    ...(it.amount !== undefined
      ? { amount: unitsKnown ? formatUnits(it.amount, decimals) : `${it.amount} raw units` }
      : {}),
    ...(it.recipient
      ? {
          recipient: recipientLabel(ctx, policy, it.recipient),
          recipient_token_account: it.recipient,
        }
      : {}),
    ...(it.error
      ? { error: { program: it.error.program, code: it.error.code, name: it.error.name } }
      : {}),
    ...(it.viaProgram ? { via_program: it.viaProgram } : {}),
    ...(it.fetchError ? { fetch_error: untrusted(it.fetchError, 120) } : {}),
  }
}

/** Shared by the agent, owner and observer activity tools. */
export async function activityRows(
  ctx: Context,
  owner: Address,
  agent: Address,
  limit: number,
): Promise<Record<string, unknown>> {
  const { mandate, policy } = await loadPolicy(ctx, owner, agent)
  const decimals = policy ? await ctx.decimalsOf(policy.budgetMint) : null
  const items = await ctx.withTimeout(
    ctx.client.activity({ mandate, ...(policy?.address ? { policy: policy.address } : {}), limit }),
    'reading the activity',
    ctx.config.timeoutMs * 2,
  )
  return {
    mandate,
    count: Math.min(items.length, limit),
    items: items.slice(0, limit).map((it) => itemView(ctx, policy, decimals, it)),
    note: 'Newest first. Failed rows are attempts that were blocked or reverted; nothing moved.',
  }
}

const activity = defineTool({
  name: 'agentauth_activity',
  title: 'Recent activity',
  description: `Lists your recent mandate activity, newest first: allowed payments and swaps, and blocked attempts with the decoded error. ${DATA_NOTE}`,
  input: strict({ limit: z.number().int().min(1).max(20).default(10) }),
  annotations: READ_ONLY,
  profiles: ['agent'],
  async handler(a, ctx) {
    const { owner, agent } = agentIdentity(ctx)
    return ok(await activityRows(ctx, owner, agent.address, a.limit))
  },
})

export const AGENT_TOOLS: readonly ToolDef[] = [
  status,
  checkAction,
  pay,
  swap,
  explainDenial,
  activity,
]
export const EXPLAIN_DENIAL_TOOL = explainDenial
