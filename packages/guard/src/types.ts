import type { Address, Instruction } from '@solana/kit'
import type {
  AgentAuthRpc,
  Cluster,
  Mandate,
  PreflightFailure,
  ProgramIds,
  VerifyOk,
} from '@agentauth-sol/sdk'

/**
 * COOPERATIVE CLIENT-SIDE GUARD: everything in this package runs in the agent's own process.
 * Anyone who holds the raw key can bypass it. Hard enforcement exists only in the AgentAuth relay
 * (typed token transfer and the pinned swap). Unaudited devnet prototype.
 */
export const GUARD_DISCLAIMER =
  'Cooperative client-side guard: not enforcement. Whoever holds the raw key can bypass it. ' +
  'Hard enforcement is the AgentAuth relay (typed transfer and pinned swap only). Unaudited devnet prototype.'

/** `enforce` refuses to sign a denied transaction; `dry-run` only reports and always signs. */
export type GuardMode = 'enforce' | 'dry-run'

/** Machine-readable reason a single instruction (or the whole transaction) is not allowed. */
export type RefusalCode =
  | 'UNKNOWN_PROGRAM'
  | 'UNKNOWN_INSTRUCTION'
  | 'BATCH_HIDES_INSTRUCTIONS'
  | 'AUTHORITY_CHANGE'
  | 'DEFAULT_DENY_RISK'
  | 'AMOUNT_UNPARSEABLE'
  | 'AGENTAUTH_ADMIN'
  | 'MANDATE_DENIED'
  | 'UNSUPPORTED_TRANSACTION'

/** How an instruction was classified before the mandate was consulted. */
export type InstructionKind =
  | 'ambient' // ComputeBudget, Memo and caller-allowed programs: no mandate needed
  | 'relay' // an AgentAuth relay instruction: the relay enforces it on chain
  | 'verify' // the agent's own AgentAuth `verify`
  | 'mandate' // a known value-bearing instruction: needs a matching mandate permission
  | 'refused' // denied by a guard default (unknown, batch, authority change, ...)

export interface InstructionVerdict {
  /** Position in the evaluated instruction list. */
  readonly index: number
  readonly programId: Address
  readonly programName: string | null
  /** Registry instruction name, when known. */
  readonly instruction: string | null
  /** Canonical disc8 (16 hex chars) or null when it cannot be determined. */
  readonly disc8: string | null
  /** Registry risk class, or 'unknown'. */
  readonly risk: string
  /** Amount parsed from the real instruction bytes (never taken from the caller). */
  readonly amount: bigint | null
  readonly kind: InstructionKind
  readonly allowed: boolean
  readonly code: RefusalCode | null
  /** Human-readable reason, honest about what is and is not enforced. */
  readonly reason: string
  /** The mandate pre-flight failure when `code` is `MANDATE_DENIED`. */
  readonly failure: PreflightFailure | null
  /** The mandate pre-flight success when the mandate allows this instruction. */
  readonly verify: VerifyOk | null
}

export interface GuardReport {
  /** True when every instruction is allowed. */
  readonly ok: boolean
  readonly mode: GuardMode
  readonly mandate: Address
  readonly agent: Address
  readonly owner: Address
  /** Unix seconds used for expiry maths. */
  readonly now: bigint
  readonly verdicts: readonly InstructionVerdict[]
  readonly refusals: readonly InstructionVerdict[]
  /** Transaction-level problems (for example an undecodable message). */
  readonly notes: readonly string[]
  readonly disclaimer: string
}

export interface GuardOptions {
  /** RPC used to read the live mandate and the cluster clock. */
  readonly rpc: AgentAuthRpc
  /** Mandate address, or an already-decoded mandate (static, no live fetch). Alternative: `owner` + `agent`. */
  readonly mandate?: Address | Mandate
  readonly owner?: Address
  readonly agent?: Address
  /** Default `enforce`. */
  readonly mode?: GuardMode
  /** Cluster preset for program ids. Default `devnet`; use `programIds` for localnet overrides. */
  readonly cluster?: Cluster
  readonly programIds?: Partial<ProgramIds>
  /** Extra programs treated as ambient (allowed without a mandate), for example the ATA program. */
  readonly allowPrograms?: readonly Address[]
  /** Clock override, unix seconds. Default: the cluster clock via the RPC. */
  readonly now?: () => bigint | Promise<bigint>
  /** Resolved address lookup tables, needed to decode v0 transactions that use them. */
  readonly addressesByLookupTableAddress?: Readonly<Record<string, readonly Address[]>>
}

export type GuardInstruction = Pick<Instruction, 'programAddress'> &
  Partial<Pick<Instruction, 'accounts' | 'data'>>
