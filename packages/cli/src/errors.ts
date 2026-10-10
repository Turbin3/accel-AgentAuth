import { AgentAuthError, PlanRefusedError, SdkError, ValidationError } from '@agentauth-sol/sdk'

/**
 * Exit codes of the `agentauth` binary (documented in the README):
 * 0 ok, 1 usage, 2 denied by pre-flight, 3 on-chain failure, 4 network.
 * `lint` is the one exception: it exits 1 when it finds an error-level problem (CI convention).
 */
export const EXIT = { ok: 0, usage: 1, denied: 2, onchain: 3, network: 4 } as const

export type ErrorKind = 'usage' | 'denied' | 'onchain' | 'network'

const KIND_EXIT: Record<ErrorKind, number> = {
  usage: EXIT.usage,
  denied: EXIT.denied,
  onchain: EXIT.onchain,
  network: EXIT.network,
}

export interface CliErrorInit {
  readonly hint?: string
  /** The decoded program error, when there is one. */
  readonly program?: AgentAuthError
  /** Extra machine-readable data for the `--json` envelope (for example the signature). */
  readonly data?: unknown
  readonly cause?: unknown
  /** Overrides the exit code of the kind (lint uses 1 for findings). */
  readonly exitCode?: number
}

/** An expected failure of a command. Everything else is an internal error. */
export class CliError extends Error {
  readonly kind: ErrorKind
  readonly hint: string | undefined
  readonly program: AgentAuthError | undefined
  readonly data: unknown
  readonly exitCode: number

  constructor(kind: ErrorKind, message: string, init: CliErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'CliError'
    this.kind = kind
    this.hint = init.hint
    this.program = init.program
    this.data = init.data
    this.exitCode = init.exitCode ?? KIND_EXIT[kind]
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError('usage', message, hint === undefined ? {} : { hint })
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && chain.length < 8) {
    chain.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

/** True when the failure looks like "the RPC could not be reached". */
export function isNetworkError(error: unknown): boolean {
  for (const e of causeChain(error)) {
    if (typeof e !== 'object' || e === null) continue
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true
    const message = e instanceof Error ? e.message : ''
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket hang up/i.test(message)) {
      return true
    }
  }
  return false
}

/** Map anything thrown inside a command to a {@link CliError}. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof PlanRefusedError) {
    return new CliError('denied', 'the plan was refused before anything was sent', {
      hint: error.reasons.map((r) => `- ${r}`).join('\n'),
      cause: error,
      data: { reasons: [...error.reasons] },
    })
  }
  if (error instanceof ValidationError) {
    return new CliError('usage', error.message, { cause: error })
  }
  if (error instanceof SdkError) {
    if (error.code === 'TX_TIMEOUT' || error.code === 'TX_EXPIRED') {
      return new CliError('network', error.message, {
        hint: 'The transaction may or may not have landed. Check the signature in an explorer before retrying.',
        cause: error,
      })
    }
    if (error.code === 'BAD_ADDRESS' || error.code === 'BAD_EXPIRY' || error.code === 'BAD_UNITS') {
      return new CliError('usage', error.message, { cause: error })
    }
    return new CliError(isNetworkError(error) ? 'network' : 'usage', error.message, {
      cause: error,
    })
  }
  if (error instanceof AgentAuthError) {
    return new CliError('onchain', error.message, {
      program: error,
      hint: error.hint,
      cause: error,
    })
  }
  if (isNetworkError(error)) {
    return new CliError('network', 'could not reach the RPC endpoint', {
      hint: 'Is the validator running (scripts/localnet.sh start) or the --url correct?',
      cause: error,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new CliError('usage', message, { cause: error })
}
