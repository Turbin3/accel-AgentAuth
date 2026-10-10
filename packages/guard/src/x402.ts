import { address, type Address } from '@solana/kit'
import { TOKEN_PROGRAM_ID, u64ToLe } from '@agentauth-sol/sdk'
import type { Guard } from './guard'
import type { GuardReport } from './types'

/** The slice of the x402 `PaymentCreationContext` this hook reads (`@x402/core@2.28.0`). */
export interface X402PaymentContext {
  readonly selectedRequirements: {
    readonly amount: string
    readonly asset: string
    readonly network: string
    readonly payTo: string
  }
}

export type X402HookResult = void | { abort: true; reason: string }

export interface AgentAuthX402HookOptions {
  readonly guard: Guard
  /** Token program of the payment asset. Default: SPL Token (use the Token-2022 id for 2022 assets). */
  readonly tokenProgram?: Address
  /** Called with every report. */
  readonly onReport?: (report: GuardReport) => void
}

/** TransferChecked instruction data for `amount` (decimals are not part of the mandate check). */
function transferCheckedData(amount: bigint): Uint8Array {
  const data = new Uint8Array(10)
  data[0] = 12
  data.set(u64ToLe(amount), 1)
  return data
}

/**
 * `onBeforePaymentCreation` hook for the x402 client (`client.onBeforePaymentCreation(hook)`,
 * verified against `@x402/core@2.28.0`). It treats the payment as a Token `TransferChecked` of
 * `selectedRequirements.amount` and aborts, before anything is signed, when the live mandate (or a
 * guard default) would deny it. Fails closed on unreadable mandates and malformed amounts.
 *
 * COOPERATIVE CLIENT-SIDE GUARD, NOT ENFORCEMENT. Limits you must know:
 *  - x402's own spend controls (default `maxAmountPerPayment` "$1") run BEFORE this hook.
 *  - A mandate permission is per program, not per mint: the amount is compared as a raw number.
 *  - The hook CHECKS; it does not book the spend (a `verify` instruction cannot ride in a default
 *    exact-SVM payment transaction), so the lifetime counter does not move.
 * The relay is the enforcement tier.
 */
export function agentAuthX402Hook(opts: AgentAuthX402HookOptions) {
  const tokenProgram = opts.tokenProgram ?? TOKEN_PROGRAM_ID
  return async (context: X402PaymentContext): Promise<X402HookResult> => {
    const { amount, asset, payTo } = context.selectedRequirements
    try {
      if (!/^\d+$/.test(amount)) {
        return {
          abort: true,
          reason: `AgentAuth guard: payment amount "${amount}" is not a raw integer`,
        }
      }
      const report = await opts.guard.evaluateInstructions([
        { programAddress: address(tokenProgram), data: transferCheckedData(BigInt(amount)) },
      ])
      opts.onReport?.(report)
      if (report.ok || opts.guard.mode === 'dry-run') return undefined
      const first = report.refusals[0]
      return {
        abort: true,
        reason: `AgentAuth guard (cooperative client-side check) refused to pay ${amount} of ${asset} to ${payTo}: ${first?.reason ?? report.notes.join(' ')}`,
      }
    } catch (error) {
      return {
        abort: true,
        reason: `AgentAuth guard could not check the payment and fails closed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}
