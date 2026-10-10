import type { Address } from '@solana/kit'
import type { RawAccount } from './accounts'
import { fromHex, toHex, toSeconds, U32_MAX, U64_MAX } from './bytes'
import {
  programIds as defaultProgramIds,
  SWAP_BASE_INPUT_DISC,
  TRANSFER_CHECKED_DISC,
  type ProgramIds,
} from './constants'
import { DEFAULT_AMM_ALLOWLIST } from './policy-config'
import { errorFromCode, type AgentAuthError } from './errors'
import { lookupError } from './error-tables'
import { ValidationError } from './sdk-errors'
import { checkMint, checkTokenAccountShape, decodeTokenAccount } from './token-state'
import type { Mandate, Permission, RelayPolicy } from './types'

/** A pre-flight failure: the error the program would return. */
export interface PreflightFailure {
  readonly ok: false
  readonly program: 'agent_auth' | 'relay' | 'token'
  readonly code: number
  readonly name: string
  readonly message: string
}

function fail(
  program: PreflightFailure['program'],
  code: number,
  detail?: string,
): PreflightFailure {
  const spec = lookupError(program, code)
  const base = spec?.message ?? `error ${code}`
  return {
    ok: false,
    program,
    code,
    name: spec?.name ?? `Custom${code}`,
    message: detail ? `${base} (${detail})` : base,
  }
}

/** Turn a {@link PreflightFailure} into the same {@link AgentAuthError} an on-chain failure gives. */
export function preflightFailureToError(failure: PreflightFailure): AgentAuthError {
  return errorFromCode(failure.program, failure.code)
}

/** The call `verify` would see. */
export interface VerifyCall {
  /** Key of the account passed in the `owner` position. */
  readonly owner: Address
  /** Key of the account passed in the `agent` position. */
  readonly agent: Address
  /** Reported target program id. */
  readonly targetProgram: Address
  /** Reported canonical disc8 (8 bytes or 16 hex chars). */
  readonly discriminator: Uint8Array | string
  /** Reported amount, raw units (u64). */
  readonly amount: bigint
}

/** Options of {@link checkVerify}. */
export interface CheckVerifyOptions {
  /** Cluster unix time in seconds (the program reads the Clock sysvar). */
  readonly now: bigint | number
  /** Whether the agent account signed. Default true. */
  readonly agentIsSigner?: boolean
}

/** Successful `verify` pre-flight. */
export interface VerifyOk {
  readonly ok: true
  readonly permissionIndex: number
  readonly permission: Permission
  /** Value `spend_total` would have after the call. */
  readonly newSpendTotal: bigint
  /** Value `call_count` would have after the call. */
  readonly newCallCount: number
  /** Remaining lifetime budget after the call, or `null` for an unlimited permission. */
  readonly remainingSpend: bigint | null
}

/** Result of {@link checkVerify}. */
export type CheckVerifyResult = VerifyOk | PreflightFailure

function parseCallDisc(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? fromHex(value) : value
  if (bytes.length !== 8) {
    throw new ValidationError(
      'BAD_DISCRIMINATOR',
      `discriminator must be 8 bytes, got ${bytes.length}`,
    )
  }
  return bytes
}

function discAllowed(permission: Permission, disc: Uint8Array): boolean {
  const hex = toHex(disc)
  return permission.discriminatorsHex.includes(hex)
}

/**
 * Pure TypeScript mirror of the core `verify` semantics (idl/core-idl.json v0.2.0 `checks`).
 * Check ORDER, literally: mandate missing (14) → paused (4) → expired when `now >= expiry` (5) →
 * owner key (2) → agent key (17) → agent signed (18) → program slot (6) → discriminator (7) →
 * per-call limit (8) → lifetime limit incl. u64 overflow (9). `0` limits mean unlimited; on an
 * unlimited permission the counters saturate and `verify` never reverts because of them.
 *
 * Structural checks of the real program (data length, account count, mandate length/discriminator)
 * cannot fail for a decoded {@link Mandate} and are therefore not repeated.
 *
 * This is a PRE-FLIGHT helper. The cluster Clock, not `opts.now`, decides on chain, and `verify`
 * itself is advisory unless an integrator gates an action on it.
 *
 * @param mandate decoded mandate, or `null` when the account does not exist
 * @throws ValidationError for malformed `call` values (amount outside u64, bad discriminator)
 */
export function checkVerify(
  mandate: Mandate | null,
  call: VerifyCall,
  opts: CheckVerifyOptions,
): CheckVerifyResult {
  if (typeof call.amount !== 'bigint' || call.amount < 0n || call.amount > U64_MAX) {
    throw new ValidationError('U64_RANGE', 'amount must be a bigint in [0, 2^64-1]')
  }
  const disc = parseCallDisc(call.discriminator)
  if (mandate === null)
    return fail('agent_auth', 14, 'mandate account missing or not owned by AgentAuth')
  if (!mandate.active) return fail('agent_auth', 4)
  const now = toSeconds(opts.now, 'now')
  if (now >= mandate.expiry) return fail('agent_auth', 5, `now ${now} >= expiry ${mandate.expiry}`)
  if (call.owner !== mandate.owner) return fail('agent_auth', 2)
  if (call.agent !== mandate.agent) return fail('agent_auth', 17)
  if (opts.agentIsSigner === false) return fail('agent_auth', 18, 'agent did not sign')
  const permission = mandate.permissions.find((p) => p.program === call.targetProgram)
  if (!permission) return fail('agent_auth', 6, `program ${call.targetProgram}`)
  if (!discAllowed(permission, disc)) return fail('agent_auth', 7, `discriminator ${toHex(disc)}`)
  if (!permission.perTxUnlimited && call.amount > permission.perTxLimit) {
    return fail('agent_auth', 8, `amount ${call.amount} > per-call limit ${permission.perTxLimit}`)
  }
  const projected = permission.spendTotal + call.amount
  if (!permission.spendUnlimited && (projected > U64_MAX || projected > permission.spendLimit)) {
    return fail(
      'agent_auth',
      9,
      `spent ${permission.spendTotal} + ${call.amount} > lifetime limit ${permission.spendLimit}`,
    )
  }
  const newSpendTotal = projected > U64_MAX ? U64_MAX : projected
  const newCallCount = permission.callCount >= U32_MAX ? U32_MAX : permission.callCount + 1
  return {
    ok: true,
    permissionIndex: permission.index,
    permission,
    newSpendTotal,
    newCallCount,
    remainingSpend: permission.spendUnlimited ? null : permission.spendLimit - newSpendTotal,
  }
}

/** Token-side accounts a relay pre-flight needs, as raw account data. `null` = does not exist. */
export interface RelayTokenAccounts {
  readonly source?: RawAccount | null
  readonly destination?: RawAccount | null
  readonly mint?: RawAccount | null
}

/** Options common to the relay pre-flights. */
export interface RelayCheckCommon {
  /** The key that signs as the agent. */
  readonly agent: Address
  /** Whether the agent signed. Default true. */
  readonly agentIsSigner?: boolean
  /** Cluster unix time in seconds. */
  readonly now: bigint | number
  /** Instruction stack height: 1 = top-level (default). Anything else trips STRICT_TOP_LEVEL (115). */
  readonly stackHeight?: number
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
}

/** Arguments of {@link checkRelayTransfer}. */
export interface RelayTransferCheckArgs extends RelayCheckCommon {
  readonly amount: bigint
  /** Destination token account. */
  readonly destination: Address
  /** Accounts as the transaction passes them; default to the policy-derived honest values. */
  readonly accounts?: {
    readonly mandate?: Address
    readonly owner?: Address
    readonly policy?: Address
    readonly authority?: Address
    readonly source?: Address
    readonly mint?: Address
    readonly tokenProgram?: Address
    readonly agentAuthProgram?: Address
  }
}

/** Successful relay-transfer pre-flight. */
export interface RelayTransferOk {
  readonly ok: true
  readonly verify: VerifyOk
}

/** Result of {@link checkRelayTransfer}. */
export type RelayTransferResult = RelayTransferOk | PreflightFailure

const TOKEN_PROGRAMS = (ids: ProgramIds): readonly Address[] => [ids.token, ids.token2022]

function relayIds(partial: Partial<ProgramIds> | undefined): ProgramIds {
  return defaultProgramIds('devnet', partial)
}

/** Shared steps 3-9 of both relay actions. Returns a failure or the mandate to continue with. */
function commonRelayChecks(
  policy: RelayPolicy | null,
  mandate: Mandate | null,
  common: RelayCheckCommon,
  accounts: {
    mandate: Address
    owner: Address
    authority: Address
    agentAuthProgram: Address
  },
  ids: ProgramIds,
):
  | PreflightFailure
  | { readonly ok: true; readonly policy: RelayPolicy; readonly mandate: Mandate } {
  if (common.agentIsSigner === false) return fail('relay', 107)
  if (accounts.agentAuthProgram !== ids.agentAuth) return fail('relay', 103, 'agentauth_program')
  if (policy === null) return fail('relay', 101, 'no relay policy account')
  if (policy.paused) return fail('relay', 116)
  if (policy.strictTopLevel && (common.stackHeight ?? 1) !== 1) return fail('relay', 115)
  if (mandate === null || mandate.owner !== accounts.owner || mandate.agent !== common.agent) {
    return fail('relay', 117)
  }
  if (
    policy.mandate !== accounts.mandate ||
    policy.owner !== accounts.owner ||
    policy.agent !== common.agent ||
    policy.authority !== accounts.authority
  ) {
    return fail('relay', 102, 'policy bindings')
  }
  if (mandate.expiry !== policy.mandateExpiry) {
    return fail('relay', 118, `mandate expiry ${mandate.expiry} != policy ${policy.mandateExpiry}`)
  }
  return { ok: true, policy, mandate }
}

/**
 * Pre-flight mirror of the relay `transfer` check order (RELAY-SPEC 7.4). Returns `{ ok: true }`
 * with the `verify` outcome, or the relay/AgentAuth/Token error the transaction would fail with.
 *
 * Order: amount (100) → agent signer (107) → AgentAuth program id (103) → policy (101) →
 * paused (116) / top-level (115) → mandate (117) → bindings (102) → stale policy (118) → pins
 * (102/103) → recipient (104) → mint and program ownership (103) → source (105) → destination
 * (105) → `verify` (AgentAuth 2..18) → Token `InsufficientFunds` (token 1).
 *
 * Not mirrored: the post-CPI balance-delta check (106) and compute/size limits.
 */
export function checkRelayTransfer(
  policy: RelayPolicy | null,
  mandate: Mandate | null,
  tokenAccounts: RelayTokenAccounts,
  args: RelayTransferCheckArgs,
): RelayTransferResult {
  const ids = relayIds(args.programIds)
  if (typeof args.amount !== 'bigint' || args.amount <= 0n || args.amount > U64_MAX) {
    return fail('relay', 100, 'amount must be in [1, 2^64-1]')
  }
  const a = args.accounts ?? {}
  const accounts = {
    mandate: a.mandate ?? policy?.mandate ?? ('' as Address),
    owner: a.owner ?? policy?.owner ?? ('' as Address),
    authority: a.authority ?? policy?.authority ?? ('' as Address),
    agentAuthProgram: a.agentAuthProgram ?? ids.agentAuth,
  }
  const common = commonRelayChecks(policy, mandate, args, accounts, ids)
  if (!common.ok) return common
  const p = common.policy
  const tokenProgram = a.tokenProgram ?? p.tokenProgram
  const mintKey = a.mint ?? p.budgetMint
  const sourceKey = a.source ?? p.sourceAccount
  // Pins (102) then program membership (103).
  if (
    tokenProgram !== p.tokenProgram ||
    mintKey !== p.budgetMint ||
    sourceKey !== p.sourceAccount
  ) {
    return fail('relay', 102, 'token_program / mint / source differ from the policy')
  }
  if (!TOKEN_PROGRAMS(ids).includes(tokenProgram)) return fail('relay', 103, 'token_program')
  if (!p.recipients.includes(args.destination))
    return fail('relay', 104, 'destination not allowlisted')
  if (args.destination === sourceKey) return fail('relay', 104, 'destination equals source')
  const mintCheck = checkMint(tokenAccounts.mint ?? null, tokenProgram)
  if (!mintCheck.ok) return fail('relay', mintCheck.code, 'mint')
  const src = tokenAccounts.source ?? null
  const dst = tokenAccounts.destination ?? null
  if (!src || src.ownerProgram !== tokenProgram || !dst || dst.ownerProgram !== tokenProgram) {
    return fail('relay', 103, 'source/destination are not owned by the token program')
  }
  const srcShape = checkTokenAccountShape(src, tokenProgram)
  if (!srcShape.ok) return fail('relay', srcShape.code, 'source')
  const s = decodeTokenAccount(src.data)
  if (
    s.mint !== p.budgetMint ||
    s.owner !== p.owner ||
    s.delegate !== accounts.authority ||
    s.delegatedAmount < args.amount
  ) {
    return fail('relay', 105, 'source mint / owner / delegate / delegated_amount')
  }
  const dstShape = checkTokenAccountShape(dst, tokenProgram)
  if (!dstShape.ok) return fail('relay', dstShape.code, 'destination')
  if (decodeTokenAccount(dst.data).mint !== p.budgetMint) {
    return fail('relay', 105, 'destination mint')
  }
  const verified = checkVerify(
    common.mandate,
    {
      owner: accounts.owner,
      agent: args.agent,
      targetProgram: tokenProgram,
      discriminator: TRANSFER_CHECKED_DISC,
      amount: args.amount,
    },
    { now: args.now, agentIsSigner: args.agentIsSigner },
  )
  if (!verified.ok) return verified
  if (s.amount < args.amount) {
    return fail('token', 1, `balance ${s.amount} < ${args.amount}`)
  }
  return { ok: true, verify: verified }
}

/** Arguments of {@link checkRelaySwap}. */
export interface RelaySwapCheckArgs extends RelayCheckCommon {
  readonly amountIn: bigint
  readonly minOut: bigint
  readonly deadlineSlot: bigint
  /** Current cluster slot. */
  readonly currentSlot: bigint
  /** AMM programs the target relay build accepts. Defaults to Raydium devnet/mainnet + mock AMM. */
  readonly ammAllowlist?: readonly Address[]
  /** Accounts as the transaction passes them; default to the policy's pinned values. */
  readonly accounts?: Partial<{
    mandate: Address
    owner: Address
    authority: Address
    inAccount: Address
    outAccount: Address
    ammProgram: Address
    ammAuthority: Address
    ammConfig: Address
    poolState: Address
    inputVault: Address
    outputVault: Address
    inTokenProgram: Address
    outTokenProgram: Address
    inMint: Address
    outMint: Address
    observationState: Address
    agentAuthProgram: Address
  }>
}

/** Token-side accounts of a swap pre-flight. */
export interface RelaySwapTokenAccounts {
  readonly inAccount?: RawAccount | null
  readonly outAccount?: RawAccount | null
  readonly inMint?: RawAccount | null
  readonly outMint?: RawAccount | null
}

/** Successful relay-swap pre-flight. */
export interface RelaySwapOk {
  readonly ok: true
  readonly verify: VerifyOk
  /** `ceil(amountIn * floorOut / floorIn)`. */
  readonly requiredMinOut: bigint
  /** `max(minOut, requiredMinOut)`: what the relay passes to the AMM. */
  readonly effectiveMinOut: bigint
}

/** Result of {@link checkRelaySwap}. */
export type RelaySwapResult = RelaySwapOk | PreflightFailure

/**
 * Pre-flight mirror of the relay `swap` check order (RELAY-SPEC 7.5): … → swap enabled (110) →
 * deadline window (111) → pinned accounts (102) / AMM allowlist and token programs (103) → mints
 * (103) → input account (103/105) → output account incl. owner field (105) → floor price (114) →
 * `verify` (AgentAuth). The AMM itself, the post-CPI delta checks (106/112/119) and compute limits
 * are not simulated.
 */
export function checkRelaySwap(
  policy: RelayPolicy | null,
  mandate: Mandate | null,
  tokenAccounts: RelaySwapTokenAccounts,
  args: RelaySwapCheckArgs,
): RelaySwapResult {
  const ids = relayIds(args.programIds)
  for (const [name, v] of [
    ['amountIn', args.amountIn],
    ['minOut', args.minOut],
    ['deadlineSlot', args.deadlineSlot],
  ] as const) {
    if (typeof v !== 'bigint' || v < 0n || v > U64_MAX)
      return fail('relay', 100, `${name} must be a u64`)
  }
  if (args.amountIn <= 0n) return fail('relay', 100, 'amountIn must be > 0')
  const a = args.accounts ?? {}
  const swap = policy?.swap ?? null
  const accounts = {
    mandate: a.mandate ?? policy?.mandate ?? ('' as Address),
    owner: a.owner ?? policy?.owner ?? ('' as Address),
    authority: a.authority ?? policy?.authority ?? ('' as Address),
    agentAuthProgram: a.agentAuthProgram ?? ids.agentAuth,
  }
  const common = commonRelayChecks(policy, mandate, args, accounts, ids)
  if (!common.ok) return common
  const p = common.policy
  if (!swap) return fail('relay', 110)
  const slot = args.currentSlot
  if (slot > args.deadlineSlot || args.deadlineSlot - slot > BigInt(swap.maxDeadlineSlots)) {
    return fail(
      'relay',
      111,
      `slot ${slot}, deadline ${args.deadlineSlot}, window ${swap.maxDeadlineSlots}`,
    )
  }
  const passed = {
    inAccount: a.inAccount ?? swap.inAccount,
    outAccount: a.outAccount ?? swap.outAccount,
    ammProgram: a.ammProgram ?? swap.ammProgram,
    ammAuthority: a.ammAuthority ?? swap.ammAuthority,
    ammConfig: a.ammConfig ?? swap.ammConfig,
    poolState: a.poolState ?? swap.poolState,
    inputVault: a.inputVault ?? swap.inputVault,
    outputVault: a.outputVault ?? swap.outputVault,
    inTokenProgram: a.inTokenProgram ?? swap.inTokenProgram,
    outTokenProgram: a.outTokenProgram ?? swap.outTokenProgram,
    inMint: a.inMint ?? swap.inMint,
    outMint: a.outMint ?? swap.outMint,
    observationState: a.observationState ?? swap.observationState,
  }
  for (const key of Object.keys(passed) as (keyof typeof passed)[]) {
    if (passed[key] !== swap[key]) return fail('relay', 102, `${key} differs from the policy`)
  }
  const allow = args.ammAllowlist ?? DEFAULT_AMM_ALLOWLIST
  if (!allow.includes(swap.ammProgram))
    return fail('relay', 103, 'amm_program not in the allowlist')
  const tps = TOKEN_PROGRAMS(ids)
  if (!tps.includes(swap.inTokenProgram) || !tps.includes(swap.outTokenProgram)) {
    return fail('relay', 103, 'in/out token program')
  }
  const inMintCheck = checkMint(tokenAccounts.inMint ?? null, swap.inTokenProgram)
  if (!inMintCheck.ok) return fail('relay', inMintCheck.code, 'in_mint')
  const outMintCheck = checkMint(tokenAccounts.outMint ?? null, swap.outTokenProgram)
  if (!outMintCheck.ok) return fail('relay', outMintCheck.code, 'out_mint')

  const inAcc = tokenAccounts.inAccount ?? null
  const inShape = checkTokenAccountShape(inAcc, swap.inTokenProgram)
  if (!inShape.ok || !inAcc) return fail('relay', inShape.ok ? 103 : inShape.code, 'in_account')
  const i = decodeTokenAccount(inAcc.data)
  if (
    i.mint !== swap.inMint ||
    i.owner !== p.owner ||
    i.delegate !== accounts.authority ||
    i.delegatedAmount < args.amountIn ||
    i.amount < args.amountIn
  ) {
    return fail('relay', 105, 'in_account mint / owner / delegate / delegated_amount / balance')
  }
  const outAcc = tokenAccounts.outAccount ?? null
  const outShape = checkTokenAccountShape(outAcc, swap.outTokenProgram)
  if (!outShape.ok || !outAcc)
    return fail('relay', outShape.ok ? 103 : outShape.code, 'out_account')
  const o = decodeTokenAccount(outAcc.data)
  if (o.mint !== swap.outMint || o.owner !== p.owner) {
    return fail(
      'relay',
      105,
      'out_account mint / owner (the output must land in the owner’s own account)',
    )
  }

  const num = args.amountIn * swap.floorOut
  const requiredMinOut = (num + swap.floorIn - 1n) / swap.floorIn
  if (requiredMinOut > U64_MAX) return fail('relay', 114, 'floor price overflows u64')
  const effectiveMinOut = args.minOut > requiredMinOut ? args.minOut : requiredMinOut

  const verified = checkVerify(
    common.mandate,
    {
      owner: accounts.owner,
      agent: args.agent,
      targetProgram: swap.ammProgram,
      discriminator: SWAP_BASE_INPUT_DISC,
      amount: args.amountIn,
    },
    { now: args.now, agentIsSigner: args.agentIsSigner },
  )
  if (!verified.ok) return verified
  return { ok: true, verify: verified, requiredMinOut, effectiveMinOut }
}
