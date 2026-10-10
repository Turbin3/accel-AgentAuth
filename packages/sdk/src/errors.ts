import { programIds as defaultProgramIds, type ProgramIds } from './constants'
import {
  candidatesForCode,
  lookupError,
  type ErrorProgram,
  type ErrorSpec,
  type TableProgram,
} from './error-tables'

export {
  AGENT_AUTH_ERRORS,
  MOCK_AMM_ERRORS,
  RELAY_ERRORS,
  SYSTEM_ERRORS,
  TOKEN_ERRORS,
  lookupError,
  type ErrorProgram,
  type ErrorSpec,
  type TableProgram,
} from './error-tables'

/**
 * A decoded on-chain program error.
 *
 * Custom error codes overlap between AgentAuth (1..22), the SPL Token program (0..19), the System
 * program and the relay (100..119). `program` is therefore resolved from the failing program id in
 * the transaction logs, never from the number alone.
 */
export class AgentAuthError extends Error {
  /** Program family that raised the error. */
  readonly program: ErrorProgram
  /** Failing program id as printed in the logs, when known. */
  readonly programId: string | undefined
  /** `Custom(n)` code. */
  readonly code: number
  /** Error name from the program IDL (for example `SpendLimitExceeded`). */
  override readonly name: string
  /** What to do about it. */
  readonly hint: string
  /** True only when the agent itself can fix it (smaller amount, fresh deadline). */
  readonly retryable: boolean
  /** Log lines the error was derived from (may be empty). */
  readonly logs: readonly string[]

  constructor(init: {
    program: ErrorProgram
    code: number
    name: string
    message: string
    hint: string
    retryable: boolean
    programId?: string
    logs?: readonly string[]
  }) {
    super(init.message)
    this.name = init.name
    this.program = init.program
    this.code = init.code
    this.hint = init.hint
    this.retryable = init.retryable
    this.programId = init.programId
    this.logs = init.logs ?? []
  }

  /** `program:code name` one-liner for logs and UIs. */
  describe(): string {
    return `${this.program}:${this.code} ${this.name}: ${this.message}`
  }
}

/** Options of {@link parseProgramError}. */
export interface ParseProgramErrorOptions {
  /** Override program ids (localnet / tests). Defaults to the devnet ids. */
  readonly programIds?: Partial<ProgramIds>
}

interface FailureLine {
  readonly programId: string
  readonly code: number
}

const FAILED_RE = /^Program (\S+) failed: custom program error: 0x([0-9a-fA-F]+)$/

function programFamily(programId: string, ids: ProgramIds): TableProgram | 'unknown' {
  if (programId === ids.agentAuth) return 'agent_auth'
  if (programId === ids.relay) return 'relay'
  if (programId === ids.token || programId === ids.token2022) return 'token'
  if (programId === ids.system) return 'system'
  if (programId === ids.mockAmm) return 'mock_amm'
  return 'unknown'
}

const MAX_DEPTH = 6

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string')
}

function extractLogs(x: unknown, depth = 0): string[] | undefined {
  if (depth > MAX_DEPTH || x === null || x === undefined) return undefined
  if (isStringArray(x)) return x
  if (typeof x === 'string') return x.includes('\n') ? x.split('\n') : [x]
  if (typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  for (const key of ['logs', 'logMessages']) {
    if (isStringArray(o[key])) return o[key]
  }
  for (const key of ['context', 'value', 'meta', 'data', 'cause']) {
    const found = extractLogs(o[key], depth + 1)
    if (found) return found
  }
  return undefined
}

function extractCustomCode(x: unknown, depth = 0): number | undefined {
  if (depth > MAX_DEPTH || x === null || x === undefined || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  const custom = o['Custom']
  if (typeof custom === 'number' && Number.isInteger(custom)) return custom
  const ctx = o['context']
  if (ctx && typeof ctx === 'object') {
    const c = ctx as Record<string, unknown>
    // @solana/kit: SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM carries { code, index }.
    if (typeof c['code'] === 'number' && c['index'] !== undefined) return c['code']
  }
  if (Array.isArray(x)) {
    for (const item of x) {
      const found = extractCustomCode(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const key of ['err', 'InstructionError', 'context', 'cause', 'value', 'data']) {
    const found = extractCustomCode(o[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function parseFailureLines(logs: readonly string[]): FailureLine[] {
  const out: FailureLine[] = []
  for (const line of logs) {
    const m = FAILED_RE.exec(line.trim())
    if (m) out.push({ programId: m[1] as string, code: parseInt(m[2] as string, 16) })
  }
  return out
}

function build(
  program: ErrorProgram,
  code: number,
  spec: ErrorSpec | undefined,
  programId: string | undefined,
  logs: readonly string[],
  extraMessage?: string,
): AgentAuthError {
  if (spec) {
    return new AgentAuthError({
      program,
      code,
      name: spec.name,
      message: extraMessage ? `${spec.message} ${extraMessage}` : spec.message,
      hint: spec.hint,
      retryable: spec.retryable,
      programId,
      logs,
    })
  }
  return new AgentAuthError({
    program,
    code,
    name: `Custom${code}`,
    message: `Unrecognised custom program error ${code} (0x${code.toString(16)})${
      programId ? ` from program ${programId}` : ''
    }.${extraMessage ? ` ${extraMessage}` : ''}`,
    hint: 'Look up the code in the failing program’s documentation or IDL.',
    retryable: false,
    programId,
    logs,
  })
}

/**
 * Turn a failed transaction (logs, a simulation result, an RPC/Kit error, a `TransactionError`
 * object) into an {@link AgentAuthError}, or `null` when no custom program error is present.
 *
 * Attribution rule: the failing *program id* in the logs decides which table applies. A relay call
 * that fails inside `verify` logs the AgentAuth failure first and then the relay re-reporting the
 * same code; the SDK resolves that to the AgentAuth error. When no logs are available the code is
 * resolved only if it is unambiguous (relay codes 100..119); otherwise `program` is `"unknown"`
 * and the message lists the candidates.
 *
 * @example
 * const err = parseProgramError(simulation.value.logs)
 * if (err?.program === 'agent_auth' && err.name === 'SpendLimitExceeded') { ... }
 */
export function parseProgramError(
  errOrLogs: unknown,
  opts: ParseProgramErrorOptions = {},
): AgentAuthError | null {
  const ids = { ...defaultProgramIds('devnet'), ...opts.programIds }
  const logs = extractLogs(errOrLogs) ?? []
  const failures = parseFailureLines(logs)

  if (failures.length > 0) {
    // Attribute by the ORIGIN frame: the first line of the final failure's code chain. A wrapper
    // (the relay re-reporting a CPI failure) never overrides the program that raised the code, so a
    // foreign Anchor program failing with 102 is not shown as relay 102.
    const final = failures[failures.length - 1] as FailureLine
    const origin = failures.find((f) => f.code === final.code) as FailureLine
    const family = programFamily(origin.programId, ids)
    const spec = lookupError(family, origin.code)
    if (spec) return build(family, origin.code, spec, origin.programId, logs)
    return build(family, origin.code, undefined, origin.programId, logs)
  }

  const code = extractCustomCode(errOrLogs)
  if (code === undefined) return runtimeError(errOrLogs, logs)
  if (code >= 104 && code <= 119) {
    return build(
      'relay',
      code,
      lookupError('relay', code),
      undefined,
      logs,
      '(inferred: no logs; 104..119 are relay codes)',
    )
  }
  const candidates = candidatesForCode(code)
  const list = candidates.map((c) => `${c.program}:${c.spec.name}`).join(', ')
  const anchor =
    code >= 100 && code <= 103
      ? ' Codes 100..103 are also Anchor framework errors (InstructionMissing..InstructionDidNotSerialize), so a foreign Anchor program can raise them too.'
      : ''
  return build(
    'unknown',
    code,
    undefined,
    undefined,
    logs,
    (list ? `Ambiguous without logs; candidates: ${list}.` : 'No known program uses this code.') +
      anchor,
  )
}

interface RuntimeSpec {
  readonly name: string
  readonly message: string
  readonly hint: string
  readonly retryable: boolean
}

const RUNTIME_ERRORS: Readonly<Record<string, RuntimeSpec>> = {
  NotEnoughAccountKeys: {
    name: 'NotEnoughAccountKeys',
    message: 'The instruction was sent with fewer accounts than the program requires.',
    hint: 'Use the SDK builder for this instruction; the relay checks the exact account count (transfer 10, swap 19).',
    retryable: false,
  },
  InvalidAccountData: {
    name: 'InvalidAccountData',
    message: 'An account has the wrong data, or is not writable where the program writes to it.',
    hint: 'Check that the mandate and policy accounts are the right PDAs and that writable flags match the IDL.',
    retryable: false,
  },
  MissingRequiredSignature: {
    name: 'MissingRequiredSignature',
    message: 'A required signature is missing.',
    hint: 'Sign with the agent key (relay/verify) or the owner key (owner instructions) as the IDL states.',
    retryable: false,
  },
  AccountNotFound: {
    name: 'AccountNotFound',
    message: 'The fee payer account does not exist or holds no SOL.',
    hint: 'Fund the agent key with a little SOL for fees (the onboarding plan can do it).',
    retryable: false,
  },
  InsufficientFundsForFee: {
    name: 'InsufficientFundsForFee',
    message: 'The fee payer cannot pay the transaction fee.',
    hint: 'Fund the fee payer with SOL.',
    retryable: false,
  },
  BlockhashNotFound: {
    name: 'BlockhashNotFound',
    message: 'The transaction blockhash expired or is unknown to this RPC.',
    hint: 'Fetch a fresh blockhash and retry.',
    retryable: true,
  },
  ComputationalBudgetExceeded: {
    name: 'ComputationalBudgetExceeded',
    message: 'The transaction ran out of compute units.',
    hint: 'Raise the compute-unit limit (setComputeUnitLimitIx) and retry.',
    retryable: true,
  },
  AccountInUse: {
    name: 'AccountInUse',
    message: 'An account is locked by another transaction.',
    hint: 'Retry shortly.',
    retryable: true,
  },
  AlreadyProcessed: {
    name: 'AlreadyProcessed',
    message: 'This exact transaction was already processed.',
    hint: 'Check the signature before retrying.',
    retryable: false,
  },
  InvalidArgument: {
    name: 'InvalidArgument',
    message: 'The instruction data was rejected by the program.',
    hint: 'Use the SDK builders for the instruction data.',
    retryable: false,
  },
  InvalidInstructionData: {
    name: 'InvalidInstructionData',
    message: 'The instruction data was rejected by the program.',
    hint: 'Use the SDK builders for the instruction data.',
    retryable: false,
  },
  IncorrectProgramId: {
    name: 'IncorrectProgramId',
    message: 'An account is owned by a different program than the instruction expects.',
    hint: 'Check program ids and cluster.',
    retryable: false,
  },
  ProgramFailedToComplete: {
    name: 'ProgramFailedToComplete',
    message: 'The program aborted (panic, stack or heap overflow).',
    hint: 'Report this with the logs.',
    retryable: false,
  },
}

const RUNTIME_LOG_HINTS: readonly (readonly [RegExp, string])[] = [
  [
    /exceeded CUs meter|exceeded maximum number of instructions|ComputationalBudgetExceeded/i,
    'ComputationalBudgetExceeded',
  ],
  [/insufficient account keys|not enough account keys/i, 'NotEnoughAccountKeys'],
  [/Attempt to debit an account but found no record of a prior credit/i, 'AccountNotFound'],
  [/Blockhash not found/i, 'BlockhashNotFound'],
  [/missing required signature|signature verification failed/i, 'MissingRequiredSignature'],
]

function runtimeName(x: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH || x === null || x === undefined) return undefined
  if (typeof x === 'string') return RUNTIME_ERRORS[x] ? x : undefined
  if (typeof x !== 'object') return undefined
  if (Array.isArray(x)) {
    for (const item of x) {
      const found = runtimeName(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  const o = x as Record<string, unknown>
  for (const key of ['err', 'InstructionError', 'context', 'cause', 'value', 'data']) {
    const found = runtimeName(o[key], depth + 1)
    if (found) return found
  }
  for (const key of Object.keys(o)) {
    if (RUNTIME_ERRORS[key]) return key
  }
  return undefined
}

function runtimeError(x: unknown, logs: readonly string[]): AgentAuthError | null {
  let name = runtimeName(x)
  if (!name) {
    const text = [...logs, typeof x === 'string' ? x : x instanceof Error ? x.message : ''].join(
      '\n',
    )
    name = RUNTIME_LOG_HINTS.find(([re]) => re.test(text))?.[1]
  }
  if (!name && x instanceof Error) {
    const m =
      /\b(NotEnoughAccountKeys|InvalidAccountData|MissingRequiredSignature|AccountNotFound|BlockhashNotFound)\b/.exec(
        x.message,
      )
    name = m?.[1]
  }
  const spec = name ? RUNTIME_ERRORS[name] : undefined
  if (!spec) return null
  return new AgentAuthError({
    program: 'runtime',
    code: -1,
    name: spec.name,
    message: spec.message,
    hint: spec.hint,
    retryable: spec.retryable,
    logs,
  })
}

/** Wrap a pre-flight failure as an {@link AgentAuthError} (same shape as an on-chain failure). */
export function errorFromCode(program: TableProgram, code: number): AgentAuthError {
  return build(program, code, lookupError(program, code), undefined, [])
}
