import type { Address } from '@solana/kit'
import {
  checkVerify,
  preflightFailureToError,
  type PreflightFailure,
  type VerifyOk,
} from './preflight'
import type { AgentAuthError } from './errors'
import { SdkError } from './sdk-errors'
import type { Mandate } from './types'

/** Input of {@link assertMandateAuthorises}. */
export interface AuthoriseInput {
  /**
   * The owner YOU trust for this asset (the wallet whose funds or resources the agent would spend).
   * REQUIRED, and never read from the mandate or from the caller's request: a mandate created by
   * anybody who names the agent verifies fine against itself.
   */
  readonly expectedOwner: Address
  /** The agent that signed your instruction. */
  readonly agent: Address
  /** Your program id, as the mandate permission lists it. */
  readonly targetProgram: Address
  /** The canonical disc8 of the action (8 bytes or 16 hex chars). */
  readonly discriminator: Uint8Array | string
  /** Raw-unit amount the action would book. */
  readonly amount: bigint
  /** Cluster unix seconds. */
  readonly now: bigint | number
}

/** Result of {@link assertMandateAuthorises}. */
export type AuthoriseResult =
  | (VerifyOk & { readonly advisory: true })
  | {
      readonly ok: false
      readonly failure: PreflightFailure
      readonly error: AgentAuthError
      readonly advisory: true
    }

/**
 * Seller-side authorisation check (off-chain pre-check of what the core `verify` would decide),
 * with the trap closed: `expectedOwner` must be supplied by you, so a mandate created by a stranger
 * for the agent is rejected with `NotOwner (2)`.
 *
 * This is ADVISORY: an off-chain read cannot reserve budget (two sellers can both pass it and the
 * second on-chain `verify` can still fail), and only your program calling `verify` (CPI) enforces
 * anything on chain. Use it for UX and early rejection, not as the gate.
 *
 * @example
 * const r = assertMandateAuthorises(mandate, { expectedOwner, agent, targetProgram, discriminator, amount: 5n, now })
 * if (!r.ok) throw r.error
 */
export function assertMandateAuthorises(
  mandate: Mandate | null,
  input: AuthoriseInput,
): AuthoriseResult {
  if (typeof input.expectedOwner !== 'string' || input.expectedOwner.length === 0) {
    throw new SdkError(
      'MISSING_ADDRESS',
      'expectedOwner is required (never take it from the caller)',
    )
  }
  const res = checkVerify(
    mandate,
    {
      owner: input.expectedOwner,
      agent: input.agent,
      targetProgram: input.targetProgram,
      discriminator: input.discriminator,
      amount: input.amount,
    },
    { now: input.now },
  )
  if (res.ok) return { ...res, advisory: true }
  return { ok: false, failure: res, error: preflightFailureToError(res), advisory: true }
}
