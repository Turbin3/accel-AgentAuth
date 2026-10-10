import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Commitment,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from '@solana/kit'
import { AgentAuthError, parseProgramError, type ParseProgramErrorOptions } from './errors'
import { setComputeUnitLimitIx, setComputeUnitPriceIx } from './compute-budget'
import type { BuiltInstruction } from './ix'
import type { Plan, PlanStep } from './plans'
import { SdkError } from './sdk-errors'
import { estimateTransactionSize } from './tx-size'
import type { AgentAuthRpc } from './types'

/** A blockhash with the last block height at which it is still valid (`getLatestBlockhash().value`). */
export interface BlockhashLifetime {
  readonly blockhash: string
  readonly lastValidBlockHeight: bigint
}

/** Options of {@link buildTransactionMessage} and {@link compileUnsigned}. */
export interface BuildMessageOptions {
  readonly feePayer: Address
  readonly blockhash: BlockhashLifetime
  /** Message version. Default `0` (what Kit and wallet adapters produce). */
  readonly version?: 0 | 'legacy'
  /** Prepend SetComputeUnitLimit. */
  readonly computeUnitLimit?: number
  /** Prepend SetComputeUnitPrice (priority fee, micro-lamports per CU). */
  readonly microLamportsPerCu?: bigint
}

/** What the builders accept: a plan step or a bare instruction list. */
export type StepLike = PlanStep | readonly Instruction[]

function instructionsOf(source: StepLike): readonly Instruction[] {
  return Array.isArray(source)
    ? (source as readonly Instruction[])
    : (source as PlanStep).instructions
}

/**
 * Build a Kit transaction message (fee payer, blockhash lifetime, optional compute-budget
 * instructions first, then the step's instructions). Pure and browser-safe; no keys involved.
 *
 * @example
 * const msg = buildTransactionMessage(plan.steps[0], { feePayer: owner, blockhash })
 */
export function buildTransactionMessage(source: StepLike, opts: BuildMessageOptions) {
  const budget: Instruction[] = []
  if (opts.computeUnitLimit !== undefined) budget.push(setComputeUnitLimitIx(opts.computeUnitLimit))
  if (opts.microLamportsPerCu !== undefined) {
    budget.push(setComputeUnitPriceIx(opts.microLamportsPerCu))
  }
  return pipe(
    createTransactionMessage({ version: opts.version ?? 0 }),
    (m) => setTransactionMessageFeePayer(opts.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: opts.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: opts.blockhash.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions([...budget, ...instructionsOf(source)], m),
  )
}

/** An unsigned, serialized transaction ready to hand to a wallet. */
export interface UnsignedTransaction {
  /** Base64 of the wire transaction with all-zero signature slots (wallets fill them in). */
  readonly base64: string
  /** The compiled message bytes the signers sign. */
  readonly messageBytes: Uint8Array
  /** Serialized size in bytes. */
  readonly sizeBytes: number
  /** Addresses that must sign, fee payer first. */
  readonly requiredSigners: readonly Address[]
}

/**
 * Compile a step into an unsigned base64 wire transaction (for MCP "unsigned transaction" output,
 * wallet adapters and hardware wallets). Signer objects inside the instructions are ignored.
 *
 * @throws SdkError `TX_TOO_LARGE` when the compiled transaction exceeds 1232 bytes
 */
export function compileUnsigned(source: StepLike, opts: BuildMessageOptions): UnsignedTransaction {
  const message = buildTransactionMessage(source, opts)
  const tx = compileTransaction(message)
  const base64 = getBase64EncodedWireTransaction(tx)
  const sizeBytes = getTransactionEncoder().encode(tx).length
  if (sizeBytes > 1232) {
    throw new SdkError('TX_TOO_LARGE', `compiled transaction is ${sizeBytes} bytes, limit is 1232`)
  }
  return {
    base64,
    messageBytes: new Uint8Array(tx.messageBytes),
    sizeBytes,
    requiredSigners: Object.keys(tx.signatures) as Address[],
  }
}

/** One element of {@link planToUnsignedTransactions}. */
export interface UnsignedPlanStep extends UnsignedTransaction {
  readonly label: string
  readonly description: string
  readonly expectedOutcome: string
  readonly dependsOn: readonly number[]
  readonly awaitConfirmation: boolean
}

/**
 * Turn a whole plan into unsigned transactions in order, each with its dependency metadata. A
 * consumer must not submit step N before every step in `dependsOn` is confirmed, and must wait for
 * confirmation of steps with `awaitConfirmation`.
 *
 * The blockhash is shared by all steps: re-compile with a fresh blockhash before submitting a later
 * step if more than ~60 seconds passed.
 */
export function planToUnsignedTransactions(
  plan: Plan,
  opts: BuildMessageOptions,
): UnsignedPlanStep[] {
  return plan.steps.map((step) => ({
    ...compileUnsigned(step, opts),
    label: step.label,
    description: step.description,
    expectedOutcome: step.expectedOutcome,
    dependsOn: step.dependsOn,
    awaitConfirmation: step.awaitConfirmation,
  }))
}

function stripIx(ix: BuiltInstruction): BuiltInstruction {
  return {
    ...ix,
    accounts: ix.accounts.map((a) => {
      if (!('signer' in a)) return a
      const { signer: _signer, ...rest } = a as typeof a & { signer?: unknown }
      void _signer
      return rest
    }),
  }
}

/**
 * Remove any `TransactionSigner` objects embedded in instruction account metas (so a plan can be
 * logged or serialized without touching key material). Addresses and roles are kept.
 */
export function stripSigners(value: Plan): Plan
export function stripSigners(value: PlanStep): PlanStep
export function stripSigners(value: BuiltInstruction): BuiltInstruction
export function stripSigners(value: Plan | PlanStep | BuiltInstruction): unknown {
  if ('steps' in value) return { ...value, steps: value.steps.map((s) => stripSigners(s)) }
  if ('instructions' in value) return { ...value, instructions: value.instructions.map(stripIx) }
  return stripIx(value)
}

// ---------------------------------------------------------------------------------------------
// RPC helpers: simulate, send, confirm
// ---------------------------------------------------------------------------------------------

/** Result of {@link simulateStep}. */
export interface SimulationResult {
  /** The raw `TransactionError` (`null` on success). */
  readonly err: unknown
  readonly logs: readonly string[]
  readonly unitsConsumed: bigint | null
  /** Decoded program/runtime error (agent_auth, relay, token, system, runtime) or null. */
  readonly error: AgentAuthError | null
  readonly ok: boolean
}

/** Options of {@link simulateStep}. */
export interface SimulateOptions extends ParseProgramErrorOptions {
  readonly feePayer: Address
  readonly version?: 0 | 'legacy'
  readonly computeUnitLimit?: number
  readonly microLamportsPerCu?: bigint
  readonly commitment?: Commitment
  readonly abortSignal?: AbortSignal
}

/**
 * Simulate a step WITHOUT signing: the RPC runs it with `sigVerify: false` and a replaced recent
 * blockhash, returning logs, compute units and the decoded error. A step that depends on an
 * unconfirmed earlier step will fail here exactly as it would on chain (for example 117).
 */
export async function simulateStep(
  rpc: AgentAuthRpc,
  source: StepLike,
  opts: SimulateOptions,
): Promise<SimulationResult> {
  const placeholder: BlockhashLifetime = {
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 0n,
  }
  const { base64 } = compileUnsigned(source, { ...opts, blockhash: placeholder })
  const res = await rpc
    .simulateTransaction(base64 as Parameters<typeof rpc.simulateTransaction>[0], {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: opts.commitment ?? 'confirmed',
    })
    .send({ abortSignal: opts.abortSignal })
  const value = res.value
  const logs = value.logs ?? []
  const err = value.err ?? null
  const error = err === null ? null : parseProgramError({ err, logs }, opts)
  return {
    err,
    logs,
    unitsConsumed: value.unitsConsumed === undefined ? null : BigInt(value.unitsConsumed),
    error,
    ok: err === null,
  }
}

/** Result of {@link sendAndConfirmStep}. */
export interface SendResult {
  readonly signature: string
  /** True when the transaction landed and succeeded. */
  readonly ok: boolean
  /** The raw `TransactionError` of a landed-but-failed transaction. */
  readonly err: unknown
  readonly slot: bigint | null
  /** Decoded error of a failed transaction (fetched from the transaction logs). */
  readonly error: AgentAuthError | null
  readonly logs: readonly string[]
}

/** Options of {@link sendAndConfirmStep}. */
export interface SendOptions extends ParseProgramErrorOptions {
  /** Signers: the fee payer first, then everyone else the step needs (owner, agent). */
  readonly signers: readonly TransactionSigner[]
  /** Defaults to `signers[0].address`. */
  readonly feePayer?: Address
  readonly version?: 0 | 'legacy'
  readonly computeUnitLimit?: number
  readonly microLamportsPerCu?: bigint
  /** Skip the RPC preflight simulation so a blocked attempt lands on chain (attack demos). Default false. */
  readonly skipPreflight?: boolean
  /** Confirmation level to wait for. Default `confirmed`. */
  readonly commitment?: Exclude<Commitment, 'processed'>
  /** Give up after this many milliseconds. Default 60000. */
  readonly timeoutMs?: number
  readonly abortSignal?: AbortSignal
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sign with the given partial signers, send, and poll until the transaction reaches `commitment`,
 * the blockhash expires, or the timeout elapses. A transaction that lands and FAILS does not throw:
 * the result has `ok: false` with the decoded `error` and logs (so blocked agent attempts can be
 * shown). Expiry/timeouts throw `SdkError`.
 *
 * @throws SdkError `TX_SIGNER_UNSUPPORTED | TX_EXPIRED | TX_TIMEOUT | TX_TOO_LARGE`
 */
export async function sendAndConfirmStep(
  rpc: AgentAuthRpc,
  source: StepLike,
  opts: SendOptions,
): Promise<SendResult> {
  const feePayer = opts.feePayer ?? opts.signers[0]?.address
  if (!feePayer)
    throw new SdkError(
      'MISSING_ADDRESS',
      'sendAndConfirmStep needs a fee payer or at least one signer',
    )
  const commitment = opts.commitment ?? 'confirmed'
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send({ abortSignal: opts.abortSignal })
  const message = buildTransactionMessage(source, { ...opts, feePayer, blockhash })
  let tx = compileTransaction(message)
  for (const signer of opts.signers) {
    if (!('signTransactions' in signer)) {
      throw new SdkError(
        'TX_SIGNER_UNSUPPORTED',
        `signer ${signer.address} cannot sign transactions (partial signers only)`,
      )
    }
    if (!(signer.address in tx.signatures)) continue
    const [dict] = await signer.signTransactions([tx] as unknown as Parameters<
      typeof signer.signTransactions
    >[0])
    tx = { ...tx, signatures: { ...tx.signatures, ...dict } }
  }
  const wire = getBase64EncodedWireTransaction(tx)
  const signature = getSignatureFromTransaction(tx) as Signature
  await rpc
    .sendTransaction(wire as Parameters<typeof rpc.sendTransaction>[0], {
      encoding: 'base64',
      skipPreflight: opts.skipPreflight === true,
      preflightCommitment: 'confirmed',
    })
    .send({ abortSignal: opts.abortSignal })

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
  const rank = { processed: 0, confirmed: 1, finalized: 2 } as const
  while (Date.now() < deadline) {
    const statuses = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .send({ abortSignal: opts.abortSignal })
    const status = statuses.value[0]
    if (
      status &&
      status.confirmationStatus &&
      rank[status.confirmationStatus] >= rank[commitment]
    ) {
      const slot = BigInt(status.slot)
      if (status.err === null)
        return { signature, ok: true, err: null, slot, error: null, logs: [] }
      const logs = await fetchLogs(rpc, signature, opts.abortSignal)
      return {
        signature,
        ok: false,
        err: status.err,
        slot,
        error: parseProgramError({ err: status.err, logs }, opts),
        logs,
      }
    }
    const height = await rpc
      .getBlockHeight({ commitment: 'confirmed' })
      .send({ abortSignal: opts.abortSignal })
    if (!status && BigInt(height) > blockhash.lastValidBlockHeight) {
      throw new SdkError(
        'TX_EXPIRED',
        `transaction ${signature} expired before landing; safe to rebuild and retry`,
      )
    }
    await sleep(400)
  }
  throw new SdkError(
    'TX_TIMEOUT',
    `transaction ${signature} was not confirmed within the timeout; check its status before retrying`,
  )
}

async function fetchLogs(
  rpc: AgentAuthRpc,
  signature: Signature,
  abortSignal: AbortSignal | undefined,
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await rpc
      .getTransaction(signature, {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      .send({ abortSignal })
    if (res) return res.meta?.logMessages ?? []
    await sleep(300)
  }
  return []
}
