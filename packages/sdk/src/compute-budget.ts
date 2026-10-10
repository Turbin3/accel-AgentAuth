import { address, type Address } from '@solana/kit'
import { concatBytes, u64ToLe, u32ToLe } from './bytes'
import { instruction, type BuiltInstruction } from './ix'

/** The Compute Budget program. */
export const COMPUTE_BUDGET_PROGRAM_ID: Address = address(
  'ComputeBudget111111111111111111111111111111',
)

/**
 * `SetComputeUnitLimit` (tag 2, u32 LE units). Without it a transaction gets 200,000 CU per
 * instruction (capped at 1.4M); set it to bound the fee and to guarantee headroom for the relay swap.
 *
 * @example
 * const ix = setComputeUnitLimitIx(400_000)
 * @throws ValidationError `U32_RANGE`
 */
export function setComputeUnitLimitIx(units: number): BuiltInstruction {
  return instruction(
    COMPUTE_BUDGET_PROGRAM_ID,
    [],
    concatBytes(new Uint8Array([2]), u32ToLe(units, 'units')),
  )
}

/**
 * `SetComputeUnitPrice` (tag 3, u64 LE micro-lamports per CU): the priority fee. Priority fee in
 * lamports = ceil(units * microLamports / 1e6). Use it on kill-switch transactions during congestion.
 *
 * @example
 * const ix = setComputeUnitPriceIx(50_000n)
 * @throws ValidationError `U64_RANGE`
 */
export function setComputeUnitPriceIx(microLamports: bigint): BuiltInstruction {
  return instruction(
    COMPUTE_BUDGET_PROGRAM_ID,
    [],
    concatBytes(new Uint8Array([3]), u64ToLe(microLamports, 'microLamports')),
  )
}
