import {
  AccountRole,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import { fromHex, U64_MAX } from './bytes'
import { MAX_DISCRIMINATORS } from './constants'
import { mandatePda } from './pda'
import { ValidationError } from './sdk-errors'

/** A plain address or a Kit `TransactionSigner` (the SDK never needs the secret key). */
export type AddressOrSigner = Address | TransactionSigner

/** An account entry of a built instruction (carries `signer` when a signer object was supplied). */
export type IxAccount = AccountMeta | AccountSignerMeta

/** What every builder returns: a Kit-compatible instruction with concrete accounts and data. */
export interface BuiltInstruction extends Instruction {
  readonly programAddress: Address
  readonly accounts: readonly IxAccount[]
  readonly data: Uint8Array
}

/** Address of an address-or-signer. */
export function addressOf(x: AddressOrSigner): Address {
  return typeof x === 'string' ? x : x.address
}

/** Account meta for a non-signer. */
export function meta(address: Address, writable: boolean): AccountMeta {
  return { address, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY }
}

/**
 * Account meta for a signer account. A `TransactionSigner` is attached as `signer`; a bare address
 * produces a signer-role meta without a signer object (to be signed later).
 */
export function signerMeta(x: AddressOrSigner, writable: boolean): IxAccount {
  const role = writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
  if (typeof x === 'string') return { address: x, role }
  return { address: x.address, role, signer: x } as AccountSignerMeta
}

/** Build an instruction object. */
export function instruction(
  programAddress: Address,
  accounts: readonly IxAccount[],
  data: Uint8Array,
): BuiltInstruction {
  return { programAddress, accounts, data }
}

/** A limit as callers state it: a positive bigint or the explicit string `"unlimited"`. */
export type LimitInput = bigint | 'unlimited'

/**
 * Convert a caller-facing limit to the on-chain u64. `"unlimited"` becomes the sentinel 0; a bigint
 * must be in [1, 2^64-1]. A bigint `0n` is rejected on purpose: on chain 0 means UNLIMITED, and
 * silently turning "0" into "no limit" is the classic fail-open trap.
 *
 * @throws ValidationError `ZERO_LIMIT_AMBIGUOUS | BAD_LIMIT`
 */
export function parseLimit(value: LimitInput, field: string): bigint {
  if (value === 'unlimited') return 0n
  if (typeof value !== 'bigint') {
    throw new ValidationError('BAD_LIMIT', `${field} must be a bigint or "unlimited"`)
  }
  if (value === 0n) {
    throw new ValidationError(
      'ZERO_LIMIT_AMBIGUOUS',
      `${field}: 0 means UNLIMITED on chain. Pass "unlimited" if that is what you want, or a positive bigint.`,
    )
  }
  if (value < 0n || value > U64_MAX) {
    throw new ValidationError('BAD_LIMIT', `${field} must be in [1, 2^64-1]`)
  }
  return value
}

/** A discriminator as callers state it: 8 bytes or 16 hex characters. */
export type DiscInput = Uint8Array | string

/** Parse and validate one 8-byte discriminator. @throws ValidationError `BAD_DISCRIMINATOR | BAD_HEX` */
export function parseDisc(value: DiscInput, field = 'discriminator'): Uint8Array {
  const bytes = typeof value === 'string' ? fromHex(value) : value
  if (bytes.length !== 8) {
    throw new ValidationError(
      'BAD_DISCRIMINATOR',
      `${field} must be exactly 8 bytes, got ${bytes.length}`,
    )
  }
  return new Uint8Array(bytes)
}

/**
 * Validate a discriminator list for `add_permission`: 1..8 entries, each 8 bytes, no duplicates.
 * @throws ValidationError `EMPTY_DISCRIMINATORS | TOO_MANY_DISCRIMINATORS | DUPLICATE_DISCRIMINATOR`
 */
export function parseDiscList(list: readonly DiscInput[]): Uint8Array[] {
  if (list.length === 0) {
    throw new ValidationError(
      'EMPTY_DISCRIMINATORS',
      'at least one discriminator is required (core error 22 EmptyDiscriminators)',
    )
  }
  if (list.length > MAX_DISCRIMINATORS) {
    throw new ValidationError(
      'TOO_MANY_DISCRIMINATORS',
      `at most ${MAX_DISCRIMINATORS} discriminators per permission (got ${list.length})`,
    )
  }
  const out = list.map((d, i) => parseDisc(d, `discriminators[${i}]`))
  const seen = new Set<string>()
  for (const d of out) {
    const key = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
    if (seen.has(key)) {
      throw new ValidationError('DUPLICATE_DISCRIMINATOR', `duplicate discriminator ${key}`)
    }
    seen.add(key)
  }
  return out
}

/** Validate a u64 amount > 0. @throws ValidationError `BAD_AMOUNT` */
export function positiveU64(value: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U64_MAX) {
    throw new ValidationError('BAD_AMOUNT', `${field} must be a bigint in [1, 2^64-1]`)
  }
  return value
}

/** How builders find the mandate: explicit address, or derived from owner + agent. */
export interface MandateRef {
  readonly owner: AddressOrSigner
  /** Mandate PDA. Derived from `owner` + `agent` when omitted. */
  readonly mandate?: Address
  readonly agent?: Address
  /** AgentAuth program id override (localnet / tests). */
  readonly agentAuthProgram?: Address
}

/**
 * Resolve the mandate address of a {@link MandateRef}.
 * @throws ValidationError `MISSING_ADDRESS` when neither `mandate` nor `agent` is given.
 */
export async function resolveMandate(ref: MandateRef, agentAuthProgram: Address): Promise<Address> {
  if (ref.mandate !== undefined) return ref.mandate
  if (ref.agent === undefined) {
    throw new ValidationError('MISSING_ADDRESS', 'pass either `mandate` or `agent` (to derive it)')
  }
  return (await mandatePda(addressOf(ref.owner), ref.agent, agentAuthProgram)).address
}
