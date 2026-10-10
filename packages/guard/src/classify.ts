import type { Address } from '@solana/kit'
import { decodeInstruction, parseAmount } from '@agentauth-sol/registry'
import type { ProgramIds } from '@agentauth-sol/sdk'
import type { GuardInstruction, InstructionKind, RefusalCode } from './types'

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'

/** Token / Token-2022 tags that change authority or close accounts: refused even if a preset lists them. */
const TOKEN_AUTHORITY_TAGS = new Set([4, 5, 6, 9, 13])
const TOKEN_BATCH_TAG = 255
const VERIFY_TAG = 3

/** The result of looking at one instruction before the mandate is consulted. */
export interface Classified {
  readonly programId: Address
  readonly programName: string | null
  readonly instruction: string | null
  readonly disc8: string | null
  readonly risk: string
  readonly amount: bigint | null
  readonly kind: InstructionKind
  /** Set for `refused`; a `mandate` kind is decided later against the live mandate. */
  readonly code: RefusalCode | null
  readonly reason: string
}

export interface ClassifyContext {
  readonly programIds: ProgramIds
  readonly allowPrograms: ReadonlySet<string>
}

/**
 * Classify one instruction from its REAL bytes: program id, canonical disc8 and amount are derived
 * here (registry decode), never taken from anything the agent reports. Default-deny for unknown
 * programs, unknown instructions, Token/Token-2022 `Batch` (tag 255 hides inner instructions) and
 * authority-changing instructions. COOPERATIVE: this protects only transactions signed through the
 * guard.
 */
export function classifyInstruction(ix: GuardInstruction, ctx: ClassifyContext): Classified {
  const programId = ix.programAddress
  const data = Uint8Array.from(ix.data ?? [])
  const base = {
    programId,
    programName: null as string | null,
    instruction: null as string | null,
    disc8: null as string | null,
    risk: 'unknown',
    amount: null as bigint | null,
  }

  if (programId === COMPUTE_BUDGET || programId === MEMO_V2 || programId === MEMO_V1) {
    return {
      ...base,
      programName: programId === COMPUTE_BUDGET ? 'Compute Budget' : 'Memo',
      kind: 'ambient',
      code: null,
      reason:
        programId === COMPUTE_BUDGET
          ? 'Compute Budget is allowed without a permission (a priority fee is spend the mandate does not meter).'
          : 'Memo is allowed without a permission.',
    }
  }
  if (ctx.allowPrograms.has(programId)) {
    return {
      ...base,
      kind: 'ambient',
      code: null,
      reason: 'Program is on the caller allow list (ambient).',
    }
  }
  if (programId === ctx.programIds.relay) {
    return {
      ...base,
      programName: 'AgentAuth relay',
      kind: 'relay',
      code: null,
      reason:
        'Relay instruction: the relay derives program, instruction and amount itself and enforces the mandate on chain (hard enforcement applies only to its typed transfer and pinned swap).',
    }
  }
  if (programId === ctx.programIds.agentAuth) {
    if (data[0] === VERIFY_TAG) {
      return {
        ...base,
        programName: 'AgentAuth core',
        instruction: 'verify',
        kind: 'verify',
        code: null,
        reason:
          'The agent is calling verify itself (advisory: it reports program, instruction and amount).',
      }
    }
    return {
      ...base,
      programName: 'AgentAuth core',
      kind: 'refused',
      code: 'AGENTAUTH_ADMIN',
      reason:
        'AgentAuth owner instructions (create, add_permission, revoke, set_active ...) belong to the owner wallet, not the agent.',
    }
  }

  const isToken = programId === ctx.programIds.token || programId === ctx.programIds.token2022
  if (isToken && data[0] === TOKEN_BATCH_TAG) {
    return {
      ...base,
      programName: programId === ctx.programIds.token ? 'SPL Token' : 'Token-2022',
      instruction: 'batch',
      disc8: 'ff00000000000000',
      risk: 'other',
      kind: 'refused',
      code: 'BATCH_HIDES_INSTRUCTIONS',
      reason:
        'Token Batch (tag 255) carries inner instructions the guard does not walk, so a Transfer could hide inside it. Refused by default.',
    }
  }

  let decoded: ReturnType<typeof decodeInstruction>
  try {
    decoded = decodeInstruction(programId, data)
  } catch {
    decoded = decodeInstruction(programId, new Uint8Array(0))
  }
  const programName = decoded.program?.name ?? null
  if (!decoded.known || decoded.instruction === null) {
    const programKnown = decoded.program !== null
    return {
      ...base,
      programName,
      disc8: decoded.disc8,
      kind: 'refused',
      code: programKnown ? 'UNKNOWN_INSTRUCTION' : 'UNKNOWN_PROGRAM',
      reason: programKnown
        ? `${programName} instruction ${decoded.disc8 ?? '(unreadable)'} is not in the registry. Default-deny.`
        : `Program ${programId} is not in the registry. Default-deny for unknown programs.`,
    }
  }

  const info = decoded.instruction
  const named = {
    ...base,
    programName,
    instruction: info.name,
    disc8: decoded.disc8,
    risk: info.risk,
  }
  if (
    info.risk === 'authority_change' ||
    info.risk === 'account_close' ||
    (isToken && data[0] !== undefined && TOKEN_AUTHORITY_TAGS.has(data[0]))
  ) {
    return {
      ...named,
      kind: 'refused',
      code: 'AUTHORITY_CHANGE',
      reason: `${programName} ${info.name} changes authority, delegation or closes an account (risk ${info.risk}). Default-deny.`,
    }
  }
  if (info.defaultDeny) {
    return {
      ...named,
      kind: 'refused',
      code: 'DEFAULT_DENY_RISK',
      reason: `${programName} ${info.name} is marked default-deny in the registry (risk ${info.risk}).`,
    }
  }

  const amount = parseAmount(programId, data)
  if (info.amount !== null && amount === null) {
    return {
      ...named,
      kind: 'refused',
      code: 'AMOUNT_UNPARSEABLE',
      reason: `${programName} ${info.name}: the amount cannot be read from the instruction data (truncated?). Default-deny.`,
    }
  }
  return {
    ...named,
    amount: amount ?? 0n,
    kind: 'mandate',
    code: null,
    reason: `${programName} ${info.name} needs a matching mandate permission.`,
  }
}
