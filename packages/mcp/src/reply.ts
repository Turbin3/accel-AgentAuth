import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toJsonSafe, type AgentAuthError } from '@agentauth-sol/sdk'
import { safeString } from './sanitize'

/** Largest tool result (serialized JSON) this server returns. */
export const MAX_RESPONSE_CHARS = 48_000

export const FAILURE_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'NOT_AVAILABLE',
  'RATE_LIMITED',
  'DUPLICATE_SUSPECTED',
  'IDEMPOTENCY_CONFLICT',
  'OUTCOME_UNKNOWN',
  'TIMEOUT',
  'RPC_ERROR',
  'CLIENT_GUARD',
  'PLAN_REFUSED',
  'INTERNAL',
  'RESPONSE_TOO_LARGE',
] as const
export type FailureCode = (typeof FAILURE_CODES)[number]

/** Server-authored text attached to every denial. The model is told what a denial means. */
export const DENIAL_GUIDANCE =
  'STOP. The mandate or the relay denied this action. Tell the user the denial name and code. Do not retry with a different recipient, amount, split or route and do not look for another way to move the funds. Only the owner can change the limits.'

export const HONESTY =
  'Unaudited devnet prototype. Only the relay transfer and the pinned swap are hard-enforced on chain; any other mandate permission is advisory (it binds only programs that call verify).'

function pack(body: Record<string, unknown>, isError: boolean): CallToolResult {
  const safe = toJsonSafe(body) as Record<string, unknown>
  const text = JSON.stringify(safe)
  if (text.length > MAX_RESPONSE_CHARS) {
    const small = {
      ok: false,
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: 'The result exceeded the size limit and was dropped. Ask for less data.',
      },
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(small) }],
      structuredContent: small,
      isError: true,
    }
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: safe,
    ...(isError ? { isError } : {}),
  }
}

/** A successful result. */
export function ok(data: Record<string, unknown>): CallToolResult {
  return pack({ ok: true, ...data }, false)
}

/** A deterministic failure that is not a policy denial. */
export function fail(
  code: FailureCode,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return pack({ ok: false, error: { code, message: safeString(message, 400), ...extra } }, true)
}

/** Which layer said no: the SDK mirror before sending, the RPC simulation, or the chain itself. */
export type DenialStage = 'preflight' | 'onchain' | 'rpc_preflight' | 'client_guard'

/**
 * A structured denial: the model sees which program refused, the code, the name and a fix for the
 * OWNER, never an invitation to retry.
 */
export function denial(
  err: AgentAuthError,
  stage: DenialStage,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return pack(
    {
      ok: false,
      denied: true,
      stage,
      program: err.program,
      code: err.code,
      name: err.name,
      message: safeString(err.message, 400),
      hint: safeString(err.hint, 400),
      enforcement: 'hard (relay)',
      can_retry: false,
      guidance: DENIAL_GUIDANCE,
      ...extra,
    },
    true,
  )
}

/** A denial raised by this server's own guard (no program involved). */
export function guardDenial(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return pack(
    {
      ok: false,
      denied: true,
      stage: 'client_guard',
      program: 'agentauth_mcp',
      code: 0,
      name,
      message: safeString(message, 400),
      hint: 'Ask the owner to change the limit if this payment is intended.',
      enforcement: 'client-side guard of this MCP server (not on chain)',
      can_retry: false,
      guidance: DENIAL_GUIDANCE,
      ...extra,
    },
    true,
  )
}
