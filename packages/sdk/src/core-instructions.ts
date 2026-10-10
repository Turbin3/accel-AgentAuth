import type { Address } from '@solana/kit'
import { concatBytes, i64ToLe, u64ToLe } from './bytes'
import { AGENT_AUTH_PROGRAM_ID, SYSTEM_PROGRAM_ID } from './constants'
import {
  addressOf,
  instruction,
  meta,
  parseDisc,
  parseDiscList,
  parseLimit,
  resolveMandate,
  signerMeta,
  type AddressOrSigner,
  type BuiltInstruction,
  type DiscInput,
  type LimitInput,
  type MandateRef,
} from './ix'
import { mandatePda } from './pda'
import { ValidationError } from './sdk-errors'
import { MILLISECOND_SUSPECT_THRESHOLD } from './time'
import { addressToBytes } from './bytes'

/** Parameters of {@link createMandateIx}. */
export interface CreateMandateParams {
  /** Owner (payer, signer). */
  readonly owner: AddressOrSigner
  /** The agent key. Not required to sign. Must differ from `owner`. */
  readonly agent: Address
  /** First unix second at which the mandate is invalid (expired iff now >= expiry). */
  readonly expiry: bigint
  /** Mandate PDA; derived when omitted. */
  readonly mandate?: Address
  readonly agentAuthProgram?: Address
}

/**
 * `create_mandate` (tag 0). Accounts `[owner S W, agent R, mandate W, system R]`, data
 * `[0] + expiry i64`. The program rejects `expiry <= now` (error 20) and `owner == agent` (19).
 *
 * Refuses an `expiry` above 1e11 (it is almost certainly milliseconds).
 *
 * @throws ValidationError `SAME_OWNER_AND_AGENT | BAD_EXPIRY`
 */
export async function createMandateIx(params: CreateMandateParams): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const owner = addressOf(params.owner)
  if (owner === params.agent) {
    throw new ValidationError(
      'SAME_OWNER_AND_AGENT',
      'owner and agent must be different keys (core error 19 InvalidAgent)',
    )
  }
  if (typeof params.expiry !== 'bigint' || params.expiry <= 0n) {
    throw new ValidationError(
      'BAD_EXPIRY',
      'expiry must be a positive unix timestamp in seconds (bigint)',
    )
  }
  if (params.expiry > MILLISECOND_SUSPECT_THRESHOLD) {
    throw new ValidationError(
      'BAD_EXPIRY',
      `expiry ${params.expiry} looks like MILLISECONDS (a year past 5138 in seconds); expiry is unix SECONDS, use expiresIn('7d')`,
    )
  }
  const mandate = params.mandate ?? (await mandatePda(owner, params.agent, program)).address
  return instruction(
    program,
    [
      signerMeta(params.owner, true),
      meta(params.agent, false),
      meta(mandate, true),
      meta(SYSTEM_PROGRAM_ID, false),
    ],
    concatBytes(new Uint8Array([0]), i64ToLe(params.expiry, 'expiry')),
  )
}

/** One permission as callers state it. Limits are explicit: a positive bigint or `"unlimited"`. */
export interface PermissionInput {
  /** Target program id the slot applies to (one slot per program). */
  readonly program: Address
  /** Lifetime cap in raw units, or `"unlimited"`. `0n` is rejected. */
  readonly spendLimit: LimitInput
  /** Per-`verify`-call cap in raw units, or `"unlimited"`. `0n` is rejected. */
  readonly perTxLimit: LimitInput
  /** 1..8 discriminators (8 bytes or 16 hex chars each). */
  readonly discriminators: readonly DiscInput[]
}

/** Parameters of {@link addPermissionIx}. */
export interface AddPermissionParams extends MandateRef, PermissionInput {}

/**
 * `add_permission` (tag 1). Accounts `[owner S, mandate W]`, data
 * `[1] + program + spend_limit u64 + per_tx_limit u64 + disc_len + discs`.
 * Validates 1..8 discriminators and refuses `0n` limits (use `"unlimited"`).
 *
 * @throws ValidationError `ZERO_LIMIT_AMBIGUOUS | BAD_LIMIT | EMPTY_DISCRIMINATORS | TOO_MANY_DISCRIMINATORS | BAD_DISCRIMINATOR | DUPLICATE_DISCRIMINATOR | MISSING_ADDRESS`
 */
export async function addPermissionIx(params: AddPermissionParams): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const spend = parseLimit(params.spendLimit, 'spendLimit')
  const perTx = parseLimit(params.perTxLimit, 'perTxLimit')
  const discs = parseDiscList(params.discriminators)
  const mandate = await resolveMandate(params, program)
  return instruction(
    program,
    [signerMeta(params.owner, false), meta(mandate, true)],
    concatBytes(
      new Uint8Array([1]),
      addressToBytes(params.program),
      u64ToLe(spend, 'spendLimit'),
      u64ToLe(perTx, 'perTxLimit'),
      new Uint8Array([discs.length]),
      ...discs,
    ),
  )
}

/** Parameters of {@link removePermissionIx}. */
export interface RemovePermissionParams extends MandateRef {
  /** Program whose WHOLE slot (all discriminators) is removed. */
  readonly program: Address
}

/**
 * `remove_permission` (tag 2). Accounts `[owner S, mandate W]`, data `[2] + program`.
 * Removes the whole slot; re-adding it later resets `spend_total` and `call_count`.
 */
export async function removePermissionIx(
  params: RemovePermissionParams,
): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const mandate = await resolveMandate(params, program)
  return instruction(
    program,
    [signerMeta(params.owner, false), meta(mandate, true)],
    concatBytes(new Uint8Array([2]), addressToBytes(params.program)),
  )
}

/** Parameters of {@link updatePermissionIx}. */
export interface UpdatePermissionParams extends MandateRef {
  readonly program: Address
  readonly spendLimit: LimitInput
  readonly perTxLimit: LimitInput
}

/**
 * `update_permission` (tag 6). Accounts `[owner S, mandate W]`, data
 * `[6] + program + spend_limit u64 + per_tx_limit u64` (49 bytes). Counters and the discriminator
 * list are preserved: changing a limit does not grant a fresh budget.
 */
export async function updatePermissionIx(
  params: UpdatePermissionParams,
): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const spend = parseLimit(params.spendLimit, 'spendLimit')
  const perTx = parseLimit(params.perTxLimit, 'perTxLimit')
  const mandate = await resolveMandate(params, program)
  return instruction(
    program,
    [signerMeta(params.owner, false), meta(mandate, true)],
    concatBytes(
      new Uint8Array([6]),
      addressToBytes(params.program),
      u64ToLe(spend, 'spendLimit'),
      u64ToLe(perTx, 'perTxLimit'),
    ),
  )
}

/** Parameters of {@link setActiveIx}. */
export interface SetActiveParams extends MandateRef {
  /** `true` resumes, `false` pauses (reversible; counters and permissions are kept). */
  readonly active: boolean
}

/** `set_active` (tag 5). Accounts `[owner S, mandate W]`, data `[5, active]`. */
export async function setActiveIx(params: SetActiveParams): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const mandate = await resolveMandate(params, program)
  return instruction(
    program,
    [signerMeta(params.owner, false), meta(mandate, true)],
    new Uint8Array([5, params.active ? 1 : 0]),
  )
}

/**
 * `revoke_mandate` (tag 4). Accounts `[owner S W, mandate W, system R]`, data `[4]`. Closes the
 * mandate account and returns its lamports to the owner. Destructive; `set_active(false)` pauses.
 */
export async function revokeMandateIx(params: MandateRef): Promise<BuiltInstruction> {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const mandate = await resolveMandate(params, program)
  return instruction(
    program,
    [signerMeta(params.owner, true), meta(mandate, true), meta(SYSTEM_PROGRAM_ID, false)],
    new Uint8Array([4]),
  )
}

/** Parameters of {@link verifyIx}. */
export interface VerifyParams {
  readonly mandate: Address
  /** The mandate owner (read-only, need not sign). */
  readonly owner: Address
  /** The agent: must equal `mandate.agent` and sign. */
  readonly agent: AddressOrSigner
  /** Target program id being reported. */
  readonly targetProgram: Address
  /** Canonical 8-byte discriminator being reported (see packages/registry SCHEMA.md). */
  readonly discriminator: DiscInput
  /** Amount being reported, raw units. */
  readonly amount: bigint
  readonly agentAuthProgram?: Address
}

/**
 * `verify` (tag 3, 49 bytes). Accounts `[mandate W, owner R, agent R+S]`, data
 * `[3] + target_program + disc8 + amount u64`.
 *
 * ADVISORY: `verify` trusts the program id, discriminator and amount the caller reports, and any
 * program may call it. It only protects an action when the integrator derives those values from the
 * action it is about to perform and gates that action on the result (as the relay does). Use this
 * builder for tests and integrations, not as proof that an agent behaved.
 */
export function verifyIx(params: VerifyParams): BuiltInstruction {
  const program = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  return instruction(
    program,
    [meta(params.mandate, true), meta(params.owner, false), signerMeta(params.agent, false)],
    concatBytes(
      new Uint8Array([3]),
      addressToBytes(params.targetProgram),
      parseDisc(params.discriminator),
      u64ToLe(params.amount, 'amount'),
    ),
  )
}
