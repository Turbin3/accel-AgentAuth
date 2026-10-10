import { AgentAuthError, preflightFailureToError } from '@agentauth-sol/sdk'
import { explainReport } from './explain'
import type { GuardReport, InstructionVerdict, RefusalCode } from './types'

const HINTS: Record<RefusalCode, string> = {
  UNKNOWN_PROGRAM:
    'Ask the owner to extend the mandate and add the program to the registry, or sign it yourself outside the agent.',
  UNKNOWN_INSTRUCTION:
    'The program is known but this instruction is not; it is refused until the registry lists it.',
  BATCH_HIDES_INSTRUCTIONS: 'Send the inner instructions as separate top-level instructions.',
  AUTHORITY_CHANGE: 'Authority changes belong to the owner wallet, not to an agent.',
  DEFAULT_DENY_RISK: 'The registry marks this instruction default-deny.',
  AMOUNT_UNPARSEABLE: 'Rebuild the instruction with complete data.',
  AGENTAUTH_ADMIN: 'Owner instructions must be signed by the owner wallet.',
  MANDATE_DENIED: 'See the mandate error; ask the owner to change the mandate or lower the amount.',
  UNSUPPORTED_TRANSACTION:
    'Supply resolved lookup tables or send a legacy / v0 transaction without them.',
}

/**
 * Thrown when the guard refuses to sign. It IS an `AgentAuthError`: for a mandate denial it carries
 * the same program / code / name an on-chain failure would (for example `agent_auth` 8
 * `PerTxExceeded`); for a guard default (unknown program, batch, authority change) `program` is
 * `unknown`, `code` is 0 and `name` is the {@link RefusalCode}.
 *
 * COOPERATIVE CLIENT-SIDE GUARD: a refusal only stops signing through this wrapper. Anyone who
 * holds the raw key can still sign; hard enforcement is the relay.
 */
export class GuardRefusedError extends AgentAuthError {
  readonly report: GuardReport
  readonly refusals: readonly InstructionVerdict[]

  constructor(report: GuardReport) {
    const first = report.refusals[0]
    const total = report.verdicts.length
    const code: RefusalCode = first?.code ?? 'UNSUPPORTED_TRANSACTION'
    const headline =
      first === undefined
        ? (report.notes[0] ?? 'transaction could not be evaluated')
        : `instruction ${first.index} (${first.programName ?? first.programId}${first.instruction === null ? '' : ' ' + first.instruction}): ${first.reason}`
    const message = `AgentAuth guard refused to sign (${report.refusals.length} of ${total} instructions denied): ${headline} [cooperative client-side check, not enforcement]`
    if (first?.failure) {
      const onChain = preflightFailureToError(first.failure)
      super({
        program: onChain.program,
        code: onChain.code,
        name: onChain.name,
        message,
        hint: onChain.hint,
        retryable: onChain.retryable,
      })
    } else {
      super({
        program: 'unknown',
        code: 0,
        name: code,
        message,
        hint: HINTS[code],
        retryable: false,
      })
    }
    this.report = report
    this.refusals = report.refusals
  }

  /** Multi-line explanation of why the transaction was refused. */
  explain(): string {
    return explainReport(this.report)
  }
}
