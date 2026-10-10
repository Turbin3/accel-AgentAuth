import { isSignerRole, isWritableRole, type Address, type Instruction } from '@solana/kit'
import { MAX_TRANSACTION_SIZE } from './constants'
import { COMPUTE_BUDGET_PROGRAM_ID } from './compute-budget'

function compactLen(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3
}

/** Options of {@link estimateTransactionSize}. */
export interface SizeOptions {
  /** `"legacy"` (default) or `0` (what Kit and wallet adapters produce by default: +2 bytes). */
  readonly version?: 0 | 'legacy'
  /** Add a `SetComputeUnitLimit` and a `SetComputeUnitPrice` instruction (+52 bytes). */
  readonly computeBudget?: boolean
  /** Extra bytes a wallet may inject (for example a Lighthouse guard instruction). */
  readonly extraBytes?: number
}

/**
 * Serialized size in bytes of a transaction built from `instructions` with `feePayer` as the first
 * signer, no address lookup tables. Exact for the default `legacy` format; `version: 0` adds the
 * version prefix and the empty lookup-table vector (2 bytes), and `computeBudget: true` adds the two
 * compute-budget instructions (52 bytes). No signatures beyond the distinct signer accounts are counted.
 *
 * Layout: compact(signatures) + 64 * signatures + 3 header bytes + compact(accounts) + 32 per
 * account + 32 blockhash + compact(instructions) + per instruction (1 program index +
 * compact(accounts) + account indexes + compact(data) + data).
 *
 * @example
 * estimateTransactionSize([ix], owner, { version: 0, computeBudget: true }) <= MAX_TRANSACTION_SIZE
 */
export function estimateTransactionSize(
  instructions: readonly Instruction[],
  feePayer: Address,
  opts: SizeOptions = {},
): number {
  const budget: Instruction[] = opts.computeBudget
    ? [
        { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: new Uint8Array(5) },
        { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: new Uint8Array(9) },
      ]
    : []
  instructions = [...budget, ...instructions]
  const keys = new Map<string, { signer: boolean; writable: boolean }>()
  const touch = (address: string, signer: boolean, writable: boolean): void => {
    const prior = keys.get(address)
    keys.set(address, {
      signer: signer || (prior?.signer ?? false),
      writable: writable || (prior?.writable ?? false),
    })
  }
  touch(feePayer, true, true)
  for (const ix of instructions) {
    for (const a of ix.accounts ?? [])
      touch(a.address, isSignerRole(a.role), isWritableRole(a.role))
    touch(ix.programAddress, false, false)
  }
  let signatures = 0
  for (const k of keys.values()) if (k.signer) signatures++
  let size = compactLen(signatures) + signatures * 64
  size += 3 + compactLen(keys.size) + keys.size * 32 + 32
  size += compactLen(instructions.length)
  for (const ix of instructions) {
    const accounts = ix.accounts?.length ?? 0
    const data = ix.data?.length ?? 0
    size += 1 + compactLen(accounts) + accounts + compactLen(data) + data
  }
  if (opts.version === 0) size += 2
  return size + (opts.extraBytes ?? 0)
}

/** True when the estimated size fits the 1232-byte transaction limit. */
export function fitsInOneTransaction(
  instructions: readonly Instruction[],
  feePayer: Address,
  opts: SizeOptions = {},
): boolean {
  return estimateTransactionSize(instructions, feePayer, opts) <= MAX_TRANSACTION_SIZE
}
