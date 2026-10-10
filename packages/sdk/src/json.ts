import { isSignerRole, isWritableRole } from '@solana/kit'
import { toHex } from './bytes'
import { AgentAuthError } from './errors'
import type { ActivityItem } from './activity'
import type { Explanation } from './explain'
import type { Plan } from './plans'
import type { Mandate, RelayPolicy } from './types'

/** Any JSON value. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const MAX_DEPTH = 32

/**
 * Convert any SDK value into plain JSON. Rules, fixed so every consumer agrees:
 *
 * - `bigint` becomes a DECIMAL STRING (u64 does not fit a JSON number; never a float).
 * - `Uint8Array` becomes lower-case hex.
 * - `Address` stays a base58 string.
 * - `AgentAuthError` / `Error` become `{ name, message, program?, code?, hint?, retryable? }`.
 * - `Date` becomes an ISO string; `Map` becomes an object; `undefined` and functions are omitted.
 * - A `signer` key (a `TransactionSigner` embedded in an instruction meta) is dropped.
 *
 * @example
 * JSON.stringify(toJsonSafe(await client.fetchMandate(address)))
 */
export function toJsonSafe(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return '[max depth]'
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'bigint':
      return value.toString()
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'function':
    case 'symbol':
      return null
    default:
      break
  }
  if (value instanceof Uint8Array) return toHex(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof AgentAuthError) {
    return {
      name: value.name,
      message: value.message,
      program: value.program,
      code: value.code,
      hint: value.hint,
      retryable: value.retryable,
      ...(value.programId ? { programId: value.programId } : {}),
    }
  }
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1))
  if (value instanceof Map) {
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of value) out[String(k)] = toJsonSafe(v, depth + 1)
    return out
  }
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || typeof v === 'function' || k === 'signer') continue
    out[k] = toJsonSafe(v, depth + 1)
  }
  return out
}

/** JSON form of a mandate: bigints as decimal strings, discriminators as hex. */
export function mandateToJson(mandate: Mandate): JsonValue {
  return toJsonSafe({
    ...mandate,
    permissions: mandate.permissions.map((p) => ({
      ...p,
      discriminators: undefined,
    })),
  })
}

/** JSON form of a relay policy. */
export function policyToJson(policy: RelayPolicy): JsonValue {
  return toJsonSafe(policy)
}

/** JSON form of an explanation (`can`, `cannot`, `limits`, `enforcement`, `warnings`, ...). */
export function explanationToJson(explanation: Explanation): JsonValue {
  return toJsonSafe(explanation)
}

/** JSON form of activity rows (amounts as decimal strings, errors as `{name, code, ...}`). */
export function activityToJson(items: readonly ActivityItem[]): JsonValue {
  return toJsonSafe(items)
}

/**
 * JSON form of a plan: instructions are `{ programAddress, accounts: [{ address, isSigner,
 * isWritable }], dataHex }` and never contain signer objects.
 */
export function planToJson(plan: Plan): JsonValue {
  return toJsonSafe({
    summary: plan.summary,
    warnings: plan.warnings,
    steps: plan.steps.map((s) => ({
      label: s.label,
      description: s.description,
      expectedOutcome: s.expectedOutcome,
      signers: s.signers,
      estimatedSizeBytes: s.estimatedSizeBytes,
      worstCaseSizeBytes: s.worstCaseSizeBytes,
      fitsInOneTx: s.fitsInOneTx,
      dependsOn: s.dependsOn,
      awaitConfirmation: s.awaitConfirmation,
      instructions: s.instructions.map((ix) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts.map((a) => ({
          address: a.address,
          isSigner: isSignerRole(a.role),
          isWritable: isWritableRole(a.role),
        })),
        dataHex: toHex(ix.data),
      })),
    })),
  })
}
