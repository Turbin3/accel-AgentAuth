/**
 * The ten consumer recipes of API.md. They are real, typechecked code (tsc runs over test/), and
 * test/recipes.test.ts proves that every `// #region` block below appears verbatim in API.md and
 * executes the offline-capable ones against stub data.
 */
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  assertMandateAuthorises,
  createClient,
  expiresIn,
  mandatePda,
  parseAddress,
  parseLimitInput,
  parseProgramError,
  parseUnits,
  planToJson,
  planToUnsignedTransactions,
  preflightFailureToError,
  relayTransferIx,
  toJsonSafe,
  type ActivityItem,
  type Client,
} from '../src/index'

// #region recipe-1
/** 1. CLI: `agentauth create-mandate` - string inputs in, signed and confirmed transactions out. */
export async function cliCreateMandate(args: {
  owner: KeyPairSigner
  agent: string
  mint: string
  source: string
  recipients: string[]
  max: string // "250" tokens, or "unlimited"
  perTx: string // "25"
  cap: string // SPL delegation cap in tokens, e.g. "250"
  lifetime: string // "7d"
}): Promise<string[]> {
  const client = createClient({ cluster: 'devnet' })
  const mint = parseAddress(args.mint)
  const mintInfo = await client.fetchMint(mint)
  if (!mintInfo) throw new Error(`mint ${args.mint} does not exist`)
  const decimals = mintInfo.decimals

  const plan = await client.plan.onboarding({
    owner: args.owner,
    agent: parseAddress(args.agent),
    expiry: expiresIn(args.lifetime), // unix SECONDS, never milliseconds
    fundAgentLamports: 5_000_000n, // 0.005 SOL for the agent's fees
    token: { mint, source: parseAddress(args.source), delegateCap: parseUnits(args.cap, decimals) },
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: parseLimitInput(args.max, decimals),
        perTxLimit: parseLimitInput(args.perTx, decimals),
        discriminators: [TRANSFER_CHECKED_DISC],
      },
    ],
    recipients: args.recipients.map(parseAddress), // token ACCOUNTS, not wallets
  })
  console.log(plan.summary, plan.warnings) // PlanRefusedError is thrown for unsafe input

  const signatures: string[] = []
  for (const step of plan.steps) {
    // Steps run in order; each sendAndConfirm returns only once its step is confirmed, which is
    // what step N+1 (`dependsOn: [N]`) needs.
    const res = await client.sendAndConfirm(step, { signers: [args.owner] })
    if (!res.ok) throw res.error ?? new Error(`step "${step.label}" failed`)
    signatures.push(res.signature)
  }
  return signatures
}
// #endregion recipe-1

// #region recipe-2
/** 2. MCP owner profile: a plan as unsigned base64 transactions + a JSON-safe summary. */
export async function mcpOwnerPlan(client: Client, owner: Address, agent: Address) {
  const plan = await client.plan.pause({ owner, agent }) // reads chain state itself
  const { value: blockhash } = await client.rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send()
  const transactions = planToUnsignedTransactions(plan, {
    feePayer: owner,
    blockhash,
    computeUnitLimit: 200_000,
    microLamportsPerCu: 20_000n, // priority fee
  })
  return toJsonSafe({
    summary: plan.summary,
    warnings: plan.warnings,
    transactions: transactions.map((t) => ({
      label: t.label,
      base64: t.base64, // hand to the wallet to sign
      requiredSigners: t.requiredSigners,
      dependsOn: t.dependsOn, // submit only after these step indexes are confirmed
      awaitConfirmation: t.awaitConfirmation,
    })),
  })
}
// #endregion recipe-2

// #region recipe-3
/** 3. MCP agent profile: relay transfer with a pre-flight that explains a denial. */
export async function mcpAgentPay(
  client: Client,
  agent: KeyPairSigner,
  owner: Address,
  destination: Address,
  amount: bigint, // raw units
) {
  // Pre-flight against live chain data and the CLUSTER clock (no transaction, no fee).
  const pre = await client.preflightTransfer({ owner, agent: agent.address, destination, amount })
  if (!pre.ok) {
    const error = preflightFailureToError(pre) // same shape as an on-chain failure
    return { sent: false as const, error: toJsonSafe(error) }
  }
  const mandate = (await mandatePda(owner, agent.address)).address
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('no relay policy')
  const ix = await relayTransferIx({ agent, policy, destination, amount })
  const res = await client.sendAndConfirm([ix], { signers: [agent], computeUnitLimit: 200_000 })
  return res.ok
    ? { sent: true as const, signature: res.signature }
    : { sent: true as const, signature: res.signature, error: toJsonSafe(res.error) }
}
// #endregion recipe-3

// #region recipe-4
/** 4. MCP agent profile: "what may I do?" and "why was I denied?". */
export async function mcpAgentStatus(client: Client, agent: Address, trustedOwners: Address[]) {
  // Anybody can create a mandate naming your agent: only trust owners you know.
  const mandates = await client.mandatesByAgent(agent, { owners: trustedOwners, limit: 20 })
  const rows = []
  for (const m of mandates) {
    const c = await client.capacityFor(m.owner, agent)
    rows.push({
      owner: m.owner,
      maxSpendNow: c.maxSpendNow, // raw units; bigint becomes a string via toJsonSafe
      limitedBy: c.limitedBy, // 'per_call_limit' | 'mandate_budget' | 'delegation' | 'balance'
      blockedBy: c.blockedBy, // { program, code, name, why } or null
    })
  }
  return toJsonSafe(rows)
}

/** Explain any failure (simulation logs, Kit error, TransactionError) to the agent. */
export function explainDenial(failure: unknown) {
  const e = parseProgramError(failure)
  return e
    ? { what: `${e.program}:${e.name}`, why: e.message, fix: e.hint, retryable: e.retryable }
    : { what: 'unknown', why: String(failure), fix: 'inspect the logs', retryable: false }
}
// #endregion recipe-4

// #region recipe-5
/** 5. Dashboard: one call for the whole mandate page (3 RPC round trips at most). */
export async function dashboardMandateView(client: Client, mandateAddress: Address) {
  const view = await client.inspect(mandateAddress) // mint decimals and cluster time are read for you
  if (!view.mandate || !view.explanation) return null
  return {
    headline: view.explanation.headline,
    can: view.explanation.can, // already cross-checked against the policy and the live delegation
    cannot: view.explanation.cannot,
    enforcement: view.explanation.enforcement, // 'hard (relay)' vs 'advisory (...)'
    warnings: view.explanation.warnings,
    capacity: view.capacity, // structured numbers for gauges
  }
}
// #endregion recipe-5

// #region recipe-6
/** 6. Dashboard: live activity feed that only fetches what is new. */
export function createActivityFeed(client: Client, mandate: Address, policy: Address) {
  const cache = new Map<string, ActivityItem[]>() // confirmed transactions are immutable
  let newest: string | undefined
  let rows: ActivityItem[] = []
  return {
    /** Call every few seconds. Returns all rows, newest first. */
    async poll(): Promise<ActivityItem[]> {
      const page = await client.activityPage({
        mandate,
        policy,
        limit: 50,
        until: newest, // only signatures newer than the last poll
        cache,
      })
      if (page.items.length > 0) {
        newest = page.items[0]!.signature
        rows = [...page.items, ...rows]
      }
      return rows
    },
    /** "Load more": older history with the cursor. */
    async older(before: string): Promise<ActivityItem[]> {
      const page = await client.activityPage({ mandate, policy, limit: 50, before, cache })
      return page.items // page.nextBefore is the next cursor, or null at the end
    },
  }
  // Each row: kind, ok, amount, recipient, error (decoded), feePayer, signers, and `viaProgram` for
  // verify calls made by another program (CPI). `fetchError` marks a row whose fetch failed.
}
// #endregion recipe-6

// #region recipe-7
/** 7. Per-instruction revoke: take ONE discriminator away, keep the rest and the budget. */
export async function revokeOneInstruction(
  client: Client,
  owner: KeyPairSigner,
  agent: Address,
  program: Address,
  discriminatorHex: string, // 16 hex chars, e.g. TRANSFER_CHECKED_DISC
) {
  const plan = await client.plan.revokeDiscriminator({
    owner,
    agent,
    program,
    discriminators: [discriminatorHex],
  })
  // Nothing left? It became a plain remove_permission. A paused mandate is resumed, edited and
  // re-paused inside the same transaction. Show planToJson(plan) for review, then send:
  const res = await client.sendAndConfirm(plan.steps[0]!, { signers: [owner] })
  return { ok: res.ok, preview: planToJson(plan), error: res.error }
}
// #endregion recipe-7

// #region recipe-8
/** 8. The kill switch: one transaction, priority fee, decoded result. */
export async function killSwitch(client: Client, owner: KeyPairSigner, agent: Address) {
  // Reads the chain: revokes the SPL delegation (also after the policy is gone), revoke_mandate,
  // close_policy. If the chain state cannot be read the plan is split so the kill switch is alone.
  const plan = await client.plan.unwind({ owner, agent })
  const results = []
  for (const step of plan.steps) {
    results.push(
      await client.sendAndConfirm(step, {
        signers: [owner],
        computeUnitLimit: 100_000,
        microLamportsPerCu: 200_000n, // pay up: this must land
        commitment: 'confirmed',
      }),
    )
  }
  return { summary: plan.summary, results }
}
// #endregion recipe-8

// #region recipe-9
/** 9. Seller-side authorisation check (advisory pre-check; your program still calls verify). */
export async function sellerCheck(
  client: Client,
  trustedOwner: Address, // the wallet that owns THIS asset: never take it from the request
  agent: Address,
  targetProgram: Address,
  discriminator: string,
  amount: bigint,
) {
  const { mandate } = await client.fetchMandateFor(trustedOwner, agent)
  const now = await client.getClusterTime()
  const r = assertMandateAuthorises(mandate, {
    expectedOwner: trustedOwner,
    agent,
    targetProgram,
    discriminator,
    amount,
    now,
  })
  // An off-chain read cannot reserve budget: two sellers can both pass this and the second
  // on-chain verify can still fail. Treat `ok` as "likely", never as "paid".
  return r.ok ? { allow: true } : { allow: false, name: r.error.name, hint: r.error.hint }
}
// #endregion recipe-9

// #region recipe-10
/** 10. Attack simulator: let a blocked attempt land on chain so it shows in the feed. */
export async function blockedAttempt(
  client: Client,
  agent: KeyPairSigner,
  owner: Address,
  attackerTokenAccount: Address,
  amount: bigint,
) {
  const mandate = (await mandatePda(owner, agent.address)).address
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('no relay policy')
  const ix = await relayTransferIx({ agent, policy, destination: attackerTokenAccount, amount })
  const res = await client.sendAndConfirm([ix], { signers: [agent], skipPreflight: true })
  // res.ok === false; res.error is e.g. relay:104 RecipientNotAllowed (decoded from the logs).
  return { signature: res.signature, landed: true, ok: res.ok, error: res.error?.describe() }
}
// #endregion recipe-10
