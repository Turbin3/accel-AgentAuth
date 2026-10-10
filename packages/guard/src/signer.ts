import {
  compileTransaction,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  prependTransactionMessageInstructions,
  type Address,
  type Instruction,
  type Transaction,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
  type TransactionWithLifetime,
  type TransactionWithinSizeLimit,
} from '@solana/kit'
import { MAX_TRANSACTION_SIZE, verifyIx } from '@agentauth-sol/sdk'
import { GuardRefusedError } from './errors'
import { createGuard, type Guard } from './guard'
import type { GuardInstruction, GuardOptions, GuardReport } from './types'

type SignableTransaction = Transaction & TransactionWithinSizeLimit & TransactionWithLifetime

/** Options of {@link guardSigner}: the guard options plus signing behaviour. */
export interface GuardSignerOptions extends GuardOptions {
  /**
   * Prepend a `verify` instruction (program, disc8 and amount derived from the real instruction
   * bytes) for every mandate-covered instruction so the chain books the spend atomically.
   * Default true in `enforce` mode, never done in `dry-run`. Turn off for transactions whose shape
   * is fixed (for example x402 payments).
   */
  readonly injectVerify?: boolean
  /** Called with every report, allowed or refused (logging, UI, dry-run output). */
  readonly onReport?: (report: GuardReport) => void
}

/** A guarded signer plus the guard it uses. */
export interface GuardedSigner extends TransactionModifyingSigner {
  readonly guard: Guard
  /** Evaluate a transaction exactly as signing would, without signing. */
  evaluate(transaction: Transaction): Promise<GuardReport>
  /** Plain-text explanation of why a transaction would be (or was) refused. */
  explain(transaction: Transaction): Promise<string>
}

function isPartialSigner(s: TransactionSigner): s is TransactionPartialSigner {
  return 'signTransactions' in s
}
function isModifyingSigner(s: TransactionSigner): s is TransactionModifyingSigner {
  return 'modifyAndSignTransactions' in s
}

interface Decoded {
  readonly instructions: readonly Instruction[]
  readonly message: ReturnType<typeof decompileTransactionMessage> | null
  readonly notes: readonly string[]
}

function decodeTransaction(tx: Transaction, opts: GuardOptions): Decoded {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
    const lookups = (
      compiled as { addressTableLookups?: readonly { lookupTableAddress: Address }[] }
    ).addressTableLookups
    const tables = opts.addressesByLookupTableAddress
    if (lookups && lookups.length > 0 && !lookups.every((l) => tables?.[l.lookupTableAddress])) {
      return {
        instructions: [],
        message: null,
        notes: [
          'The transaction uses address lookup tables that were not supplied (`addressesByLookupTableAddress`); its instructions cannot be decoded, so it is refused.',
        ],
      }
    }
    const lastValid = (tx as Partial<TransactionWithLifetime>).lifetimeConstraint
    const message = decompileTransactionMessage(
      compiled as Parameters<typeof decompileTransactionMessage>[0],
      {
        ...(tables ? { addressesByLookupTableAddress: tables } : {}),
        ...(lastValid && 'lastValidBlockHeight' in lastValid
          ? { lastValidBlockHeight: lastValid.lastValidBlockHeight }
          : {}),
      } as Parameters<typeof decompileTransactionMessage>[1],
    )
    return { instructions: message.instructions as readonly Instruction[], message, notes: [] }
  } catch (error) {
    return {
      instructions: [],
      message: null,
      notes: [
        `The transaction could not be decoded (${error instanceof Error ? error.message : String(error)}); refused.`,
      ],
    }
  }
}

/**
 * Wrap a Kit signer so that BEFORE ANY SIGNATURE the transaction is decoded, every instruction is
 * classified against the registry and the live mandate, and signing is refused with a structured
 * {@link GuardRefusedError} (an `AgentAuthError`) if any instruction would be denied.
 *
 * COOPERATIVE CLIENT-SIDE GUARD, NOT ENFORCEMENT: it only protects transactions signed through
 * this wrapper. Anyone holding the raw key can sign without it (see `test/bypass.test.ts`). Hard
 * enforcement is the AgentAuth relay.
 *
 * Default-deny: unknown programs, unknown instructions, Token / Token-2022 `Batch` (tag 255),
 * authority-changing instructions and undecodable transactions. ComputeBudget and Memo are allowed.
 * In `dry-run` mode it only reports (via `onReport`) and signs unchanged.
 *
 * The inner signer must be a partial signer (key pair, wallet-account signer) or a modifying signer.
 * A sending-only signer is not supported.
 */
export function guardSigner(inner: TransactionSigner, options: GuardSignerOptions): GuardedSigner {
  if (!isPartialSigner(inner) && !isModifyingSigner(inner)) {
    throw new TypeError(
      'guardSigner: the inner signer must be a TransactionPartialSigner or TransactionModifyingSigner (sending-only signers are not supported)',
    )
  }
  const guard = createGuard(options)
  const mode = guard.mode
  const inject = mode === 'enforce' && options.injectVerify !== false

  async function evaluate(tx: Transaction): Promise<GuardReport> {
    const decoded = decodeTransaction(tx, options)
    return guard.evaluateInstructions(decoded.instructions as readonly GuardInstruction[], {
      signer: inner.address,
      notes: decoded.notes,
    })
  }

  async function signOne(tx: Transaction): Promise<Transaction> {
    const decoded = decodeTransaction(tx, options)
    const report = await guard.evaluateInstructions(
      decoded.instructions as readonly GuardInstruction[],
      { signer: inner.address, notes: decoded.notes },
    )
    options.onReport?.(report)
    if (!report.ok && mode === 'enforce') throw new GuardRefusedError(report)

    let target = tx
    const covered = report.verdicts.filter((v) => v.kind === 'mandate' && v.allowed)
    if (inject && covered.length > 0 && decoded.message !== null) {
      const verifies = await Promise.all(
        covered.map((v) =>
          verifyIx({
            mandate: report.mandate,
            owner: report.owner,
            agent: inner,
            targetProgram: v.programId,
            discriminator: v.disc8 as string,
            amount: v.amount ?? 0n,
            agentAuthProgram: guard.programIds.agentAuth,
          }),
        ),
      )
      const rebuilt = compileTransaction(
        prependTransactionMessageInstructions(verifies, decoded.message),
      )
      if (getTransactionEncoder().encode(rebuilt).length > MAX_TRANSACTION_SIZE) {
        throw new GuardRefusedError({
          ...report,
          ok: false,
          notes: [
            `Adding verify instructions would exceed the ${MAX_TRANSACTION_SIZE} byte transaction limit.`,
          ],
        })
      }
      target = rebuilt
    }

    if (isModifyingSigner(inner)) {
      const [signed] = await inner.modifyAndSignTransactions([
        target as unknown as SignableTransaction,
      ])
      if (signed === undefined)
        throw new Error('guardSigner: the inner signer returned no transaction')
      return signed
    }
    const [signatures] = await (inner as TransactionPartialSigner).signTransactions([
      target as SignableTransaction,
    ])
    return Object.freeze({
      ...target,
      signatures: Object.freeze({ ...target.signatures, ...signatures }),
    })
  }

  return {
    address: inner.address,
    guard,
    evaluate,
    async explain(tx) {
      return guard.explain(await evaluate(tx))
    },
    async modifyAndSignTransactions(transactions) {
      const out: SignableTransaction[] = []
      for (const tx of transactions) out.push((await signOne(tx)) as SignableTransaction)
      return out
    },
  }
}
