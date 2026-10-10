import { isSignerRole, type Address } from '@solana/kit'
import { nowSeconds, toHex, toSeconds, U64_MAX } from './bytes'
import {
  addPermissionIx,
  createMandateIx,
  removePermissionIx,
  revokeMandateIx,
  setActiveIx,
  updatePermissionIx,
  type PermissionInput,
} from './core-instructions'
import {
  programIds as defaultProgramIds,
  MAX_PERMISSIONS,
  MAX_TRANSACTION_SIZE,
  SWAP_BASE_INPUT_DISC,
  TRANSFER_CHECKED_DISC,
  type ProgramIds,
} from './constants'
import {
  addressOf,
  parseDiscList,
  parseLimit,
  resolveMandate,
  type AddressOrSigner,
  type BuiltInstruction,
  type LimitInput,
} from './ix'
import { relayAuthorityPda, relayPolicyPda } from './pda'
import { validateRelayPolicyConfig, type PolicyConfigOptions } from './policy-config'
import { DEFAULT_DENY_RISKS, describeInstruction, type RegistryLike } from './registry'
import { closePolicyIx, initPolicyIx, setPausedIx } from './relay-instructions'
import { PlanRefusedError, SdkError } from './sdk-errors'
import { approveIx, revokeDelegateIx, systemTransferIx } from './token-instructions'
import { estimateTransactionSize } from './tx-size'
import { checkExpiry, isoOfSeconds } from './time'
import type { TokenAccountView } from './token-state'
import type { Mandate, RelayPolicy, RelayPolicyConfig, SwapConfig } from './types'

/** One transaction of a plan. The SDK never signs or sends. */
export interface PlanStep {
  readonly label: string
  readonly description: string
  readonly instructions: readonly BuiltInstruction[]
  /** Addresses that must sign this transaction (owner and fee payer; never the agent). */
  readonly signers: readonly Address[]
  readonly expectedOutcome: string
  /** Exact legacy-transaction size in bytes (no compute-budget instructions, no lookup tables). */
  readonly estimatedSizeBytes: number
  /** Worst-case size: v0 message plus SetComputeUnitLimit and SetComputeUnitPrice (+54 bytes). */
  readonly worstCaseSizeBytes: number
  /** `worstCaseSizeBytes <= 1232`: fits even with a priority fee and a v0 message. */
  readonly fitsInOneTx: boolean
  /**
   * Indexes of earlier steps whose effects this step needs. Do not submit (or simulate) this step
   * before every listed step is CONFIRMED; the programs would reject it (for example init_policy
   * fails with InvalidMandate 117 until the mandate exists).
   */
  readonly dependsOn: readonly number[]
  /** True when a later step needs this one to be confirmed first (wait for confirmation). */
  readonly awaitConfirmation: boolean
}

/** An UNSIGNED plan: transactions to be signed by the owner, in order. */
export interface Plan {
  readonly steps: readonly PlanStep[]
  readonly warnings: readonly string[]
  readonly summary: string
}

/** What the caller already knows about the chain (`undefined` = unknown, `null` = does not exist). */
export interface ChainState {
  readonly mandate?: Mandate | null
  readonly policy?: RelayPolicy | null
  /** Token accounts the plan touches, by address (`null` = account does not exist). */
  readonly tokenAccounts?: Readonly<Record<string, TokenAccountView | null>>
}

/** Options shared by every plan builder. */
export interface PlanCommon {
  /** Owner. Pass a signer object to get instructions that carry it, or a bare address. */
  readonly owner: AddressOrSigner
  /** Fee payer; defaults to the owner. Only affects size estimates and the signer list. */
  readonly feePayer?: Address
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
  /** Known chain state; the `Client` plan helpers fill this in for you. */
  readonly chainState?: ChainState
  /** Unix seconds used for expiry checks. Defaults to the wall clock. */
  readonly now?: bigint | number
}

const HUGE = 1n << 63n

const UNAUDITED =
  'AgentAuth is an unaudited prototype built for devnet. Do not put funds you cannot lose behind it.'

function idsOf(c: PlanCommon): ProgramIds {
  return defaultProgramIds('devnet', c.programIds)
}

function signersOf(instructions: readonly BuiltInstruction[], feePayer: Address): Address[] {
  const out: Address[] = [feePayer]
  for (const ix of instructions) {
    for (const a of ix.accounts) {
      if (isSignerRole(a.role) && !out.includes(a.address)) out.push(a.address)
    }
  }
  return out
}

function makeStep(
  label: string,
  description: string,
  instructions: readonly BuiltInstruction[],
  expectedOutcome: string,
  feePayer: Address,
  deps: { dependsOn?: readonly number[]; awaitConfirmation?: boolean } = {},
): PlanStep {
  const size = estimateTransactionSize(instructions, feePayer)
  const worst = estimateTransactionSize(instructions, feePayer, {
    version: 0,
    computeBudget: true,
  })
  return {
    label,
    description,
    instructions,
    signers: signersOf(instructions, feePayer),
    expectedOutcome,
    estimatedSizeBytes: size,
    worstCaseSizeBytes: worst,
    fitsInOneTx: worst <= MAX_TRANSACTION_SIZE,
    dependsOn: deps.dependsOn ?? [],
    awaitConfirmation: deps.awaitConfirmation ?? false,
  }
}

const WORST_CASE = { version: 0, computeBudget: true } as const

/** Greedily pack instructions into transactions that each fit 1232 bytes, preserving order. */
function packInstructions(
  instructions: readonly BuiltInstruction[],
  feePayer: Address,
): BuiltInstruction[][] {
  const groups: BuiltInstruction[][] = []
  let current: BuiltInstruction[] = []
  for (const ix of instructions) {
    const candidate = [...current, ix]
    if (
      current.length > 0 &&
      estimateTransactionSize(candidate, feePayer, WORST_CASE) > MAX_TRANSACTION_SIZE
    ) {
      groups.push(current)
      current = [ix]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function short(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}

// ---------------------------------------------------------------------------------------------
// planOnboarding
// ---------------------------------------------------------------------------------------------

/** Swap configuration for onboarding: the policy swap config plus the delegation cap of `inAccount`. */
export interface OnboardingSwap extends SwapConfig {
  /**
   * SPL delegation cap for `inAccount`. Required when `inAccount` differs from `token.source`;
   * ignored when they are the same account (then `token.delegateCap` covers both).
   */
  readonly delegateCap?: bigint
}

/** Input of {@link planOnboarding}. */
export interface OnboardingInput extends PlanCommon {
  readonly agent: Address
  /** First unix second at which the mandate is invalid. */
  readonly expiry: bigint
  /** Lamports sent from the owner to the agent for fees. Omit or 0 to skip. */
  readonly fundAgentLamports?: bigint
  readonly token: {
    readonly mint: Address
    /** Defaults to the classic Token program. */
    readonly tokenProgram?: Address
    /** Owner's token account the relay will debit. */
    readonly source: Address
    /** SPL `Approve` amount for `source` (hard cap enforced by the Token program). */
    readonly delegateCap: bigint
  }
  /** Mandate permissions. Must include the Token TransferChecked slot when `recipients` is non-empty. */
  readonly permissions: readonly PermissionInput[]
  /** Allowlisted recipient TOKEN ACCOUNTS (0..8). */
  readonly recipients: readonly Address[]
  readonly swap?: OnboardingSwap
  /** Extra permissions merged before `permissions` (for example from a registry preset). */
  readonly preset?: { readonly permissions: readonly PermissionInput[] }
  /** Allow relay actions inside CPIs (default false: STRICT_TOP_LEVEL is set). */
  readonly allowCpi?: boolean
  /** Create the policy paused. */
  readonly paused?: boolean
  /** Accept `"unlimited"` limits. Default false: such a plan is refused. */
  readonly allowUnlimited?: boolean
  /** Accept `delegateCap` above the smallest lifetime limit. Default false: refused. */
  readonly allowOverride?: boolean
  /** Accept permissions on default-deny instructions (authority_change, account_close, admin). */
  readonly allowDefaultDeny?: boolean
  /** Registry used to detect default-deny instructions. */
  readonly registry?: RegistryLike | null
  /** AMM allowlist / validation switches for the policy config. */
  readonly validation?: PolicyConfigOptions
  /** Accept an expiry more than one year away (still capped at the year 2100). */
  readonly allowLongExpiry?: boolean
  /** Refuse (instead of warning about) permissions on instructions that no registry knows. */
  readonly requireKnownInstructions?: boolean
  /** Accept `fundAgentLamports` above 1 SOL. */
  readonly allowLargeFunding?: boolean
  /** Accept replacing a different SPL delegate that `chainState.tokenAccounts` shows on an account. */
  readonly allowReplaceDelegate?: boolean
}

interface NormalizedPermission {
  readonly input: PermissionInput
  readonly spend: bigint
  readonly perTx: bigint
  readonly discHex: readonly string[]
}

/**
 * Plan the owner onboarding of RELAY-SPEC 12.1: transaction 1 = `[System.Transfer(owner->agent)],
 * create_mandate, add_permission (Token), add_permission (AMM), other permissions, Approve(source),
 * Approve(in_account if different)`; the final transaction = relay `init_policy`. The result is
 * UNSIGNED. If transaction 1 would exceed 1232 bytes it is split in order.
 *
 * Refuses (throws {@link PlanRefusedError} listing every reason): unlimited limits unless
 * `allowUnlimited`; `delegateCap` above the smallest lifetime limit of the permissions that draw on
 * the account unless `allowOverride`; missing Token/AMM permissions for the configured actions;
 * an existing mandate or policy (when `chainState` says so); default-deny permissions unless
 * `allowDefaultDeny`; an expiry in the past; `agent == owner`; invalid policy config.
 *
 * @example
 * const plan = await planOnboarding({ owner, agent, expiry, token: { mint, source, delegateCap: 5_000_000n }, permissions, recipients })
 */
export async function planOnboarding(input: OnboardingInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const now = input.now !== undefined ? toSeconds(input.now, 'now') : nowSeconds()
  const tokenProgram = input.token.tokenProgram ?? ids.token
  const refusals: string[] = []
  const warnings: string[] = [UNAUDITED]

  // 1. Normalise permissions.
  const merged = [...(input.preset?.permissions ?? []), ...input.permissions]
  if (merged.length > MAX_PERMISSIONS) {
    refusals.push(`at most ${MAX_PERMISSIONS} permissions per mandate (got ${merged.length})`)
  }
  const seenPrograms = new Set<string>()
  const normalized: NormalizedPermission[] = []
  for (const p of merged) {
    if (seenPrograms.has(p.program)) {
      refusals.push(
        `two permissions for program ${p.program}: a mandate holds one slot per program`,
      )
      continue
    }
    seenPrograms.add(p.program)
    try {
      const spend = parseLimit(p.spendLimit, `spendLimit (${short(p.program)})`)
      const perTx = parseLimit(p.perTxLimit, `perTxLimit (${short(p.program)})`)
      const discs = parseDiscList(p.discriminators)
      normalized.push({ input: p, spend, perTx, discHex: discs.map(toHex) })
    } catch (error) {
      refusals.push(error instanceof SdkError ? error.message : String(error))
    }
  }

  // 2. Unlimited / risky permissions.
  for (const n of normalized) {
    if (n.spend >= HUGE || n.perTx >= HUGE) {
      // 2^63 and above can never be reached by real balances: treat it as the unlimited sentinel.
      if (input.allowUnlimited !== true) {
        refusals.push(
          `permission on ${short(n.input.program)} has a limit of 2^63 or more, which is effectively unlimited; pass allowUnlimited: true to accept it explicitly`,
        )
      }
    }
    if (n.spend !== 0n && n.perTx !== 0n && n.perTx > n.spend) {
      warnings.push(
        `permission on ${short(n.input.program)}: the per-call limit is larger than the lifetime limit; the lifetime limit always binds first.`,
      )
    }
    if ((n.spend === 0n || n.perTx === 0n) && input.allowUnlimited !== true) {
      refusals.push(
        `permission on ${short(n.input.program)} uses an unlimited limit; pass allowUnlimited: true to accept it explicitly`,
      )
    } else if (n.spend === 0n || n.perTx === 0n) {
      warnings.push(
        `UNLIMITED limit accepted for ${short(n.input.program)} (allowUnlimited): nothing in the mandate caps it.`,
      )
    }
    for (const hex of n.discHex) {
      const info = describeInstruction(n.input.program, hex, input.registry)
      if (!info.known) {
        const msg = `permission on ${short(n.input.program)} includes instruction 0x${hex} that no registry knows: its effect is unreviewed`
        if (input.requireKnownInstructions === true) refusals.push(msg)
        else warnings.push(`${msg} (pass requireKnownInstructions: true to refuse such plans).`)
      }
      if (info.defaultDeny || (info.risk !== null && DEFAULT_DENY_RISKS.includes(info.risk))) {
        if (input.allowDefaultDeny === true) {
          warnings.push(
            `Default-deny instruction allowed on ${short(n.input.program)}: ${info.title ?? hex}.`,
          )
        } else {
          refusals.push(
            `permission on ${short(n.input.program)} includes default-deny instruction ${info.title ?? hex} (${info.risk ?? 'default-deny'}); pass allowDefaultDeny: true to accept it`,
          )
        }
      }
    }
  }

  // 3. Required permissions for the configured relay actions.
  const tokenPerm = normalized.find((n) => n.input.program === tokenProgram)
  const swap = input.swap
  const ammPerm = swap ? normalized.find((n) => n.input.program === swap.ammProgram) : undefined
  if (input.recipients.length > 0) {
    if (!tokenPerm) {
      refusals.push(
        `recipients are configured but no permission exists for the Token program ${tokenProgram}`,
      )
    } else if (!tokenPerm.discHex.includes(TRANSFER_CHECKED_DISC)) {
      refusals.push(`the Token permission must include TransferChecked (${TRANSFER_CHECKED_DISC})`)
    }
  }
  if (swap) {
    if (!ammPerm) {
      refusals.push(
        `a swap is configured but no permission exists for the AMM program ${swap.ammProgram}`,
      )
    } else if (!ammPerm.discHex.includes(SWAP_BASE_INPUT_DISC)) {
      refusals.push(`the AMM permission must include swap_base_input (${SWAP_BASE_INPUT_DISC})`)
    }
  }

  // 4. Delegation caps.
  const sourceApproved =
    input.recipients.length > 0 || (swap !== undefined && swap.inAccount === input.token.source)
  const separateIn = swap !== undefined && swap.inAccount !== input.token.source
  const finiteMin = (perms: (NormalizedPermission | undefined)[]): bigint | null => {
    const limits = perms
      .filter((p): p is NormalizedPermission => p !== undefined && p.spend !== 0n)
      .map((p) => p.spend)
    return limits.length === 0 ? null : limits.reduce((a, b) => (a < b ? a : b))
  }
  const checkCap = (cap: bigint, bound: bigint | null, what: string): void => {
    if (typeof cap !== 'bigint' || cap <= 0n || cap > U64_MAX) {
      refusals.push(`${what}: delegateCap must be a bigint in [1, 2^64-1]`)
      return
    }
    if (cap >= HUGE && input.allowUnlimited !== true) {
      refusals.push(
        `${what}: delegateCap ${cap} is 2^63 or more, which is effectively unlimited; pass allowUnlimited: true to accept it explicitly`,
      )
    }
    if (bound === null) {
      warnings.push(
        `${what}: every drawing permission has an unlimited lifetime limit, so the SPL delegation (${cap}) is the only hard cap.`,
      )
    } else if (cap > bound) {
      if (input.allowOverride === true) {
        warnings.push(
          `${what}: delegateCap ${cap} exceeds the smallest lifetime limit ${bound} (allowOverride).`,
        )
      } else {
        refusals.push(
          `${what}: delegateCap ${cap} exceeds the smallest lifetime limit ${bound} of the permissions that draw on it; lower it or pass allowOverride: true`,
        )
      }
    }
  }
  if (sourceApproved) {
    const drawing = [
      input.recipients.length > 0 ? tokenPerm : undefined,
      swap && !separateIn ? ammPerm : undefined,
    ]
    checkCap(input.token.delegateCap, finiteMin(drawing), 'source account')
  }
  if (swap && separateIn) {
    if (swap.delegateCap === undefined)
      refusals.push('swap.inAccount differs from token.source: swap.delegateCap is required')
    else checkCap(swap.delegateCap, finiteMin([ammPerm]), 'swap input account')
  }

  // 5. Mandate / chain state / time.
  if (owner === input.agent) refusals.push('agent must differ from owner')
  for (const problem of checkExpiry(input.expiry, {
    now,
    allowLongExpiry: input.allowLongExpiry,
  })) {
    refusals.push(
      problem.replace(
        'the program rejects it (20)',
        'the program rejects it with InvalidExpiry (20)',
      ),
    )
  }
  const fundCap = 1_000_000_000n
  if ((input.fundAgentLamports ?? 0n) > fundCap && input.allowLargeFunding !== true) {
    refusals.push(
      `fundAgentLamports ${input.fundAgentLamports} is more than 1 SOL (an agent needs fee money, not a treasury); pass allowLargeFunding: true to accept it`,
    )
  }
  const cs = input.chainState
  if (cs?.mandate)
    refusals.push(
      'a mandate for this (owner, agent) already exists; use the update/unwind plans instead',
    )
  if (cs?.policy) {
    refusals.push(
      'a relay policy already exists for this mandate; close it first (planClosePolicy / planUnwind) or use planReinitPolicy',
    )
  }
  if (cs === undefined || cs.mandate === undefined || cs.policy === undefined) {
    warnings.push(
      'Chain state was not checked: the programs reject duplicates themselves (core 3, relay 113) but this plan could not pre-empt that.',
    )
  }

  // 6. Policy config validity (needs derived addresses).
  const mandateAddress = await resolveMandate(
    { owner: input.owner, agent: input.agent },
    ids.agentAuth,
  )
  const [policyPda, authorityPda] = await Promise.all([
    relayPolicyPda(mandateAddress, ids.relay),
    relayAuthorityPda(mandateAddress, ids.relay),
  ])
  const config: RelayPolicyConfig = {
    tokenProgram,
    budgetMint: input.token.mint,
    sourceAccount: input.token.source,
    recipients: input.recipients,
    swap: swap
      ? {
          ammProgram: swap.ammProgram,
          ammAuthority: swap.ammAuthority,
          ammConfig: swap.ammConfig,
          poolState: swap.poolState,
          inputVault: swap.inputVault,
          outputVault: swap.outputVault,
          observationState: swap.observationState,
          inMint: swap.inMint,
          outMint: swap.outMint,
          inTokenProgram: swap.inTokenProgram,
          outTokenProgram: swap.outTokenProgram,
          inAccount: swap.inAccount,
          outAccount: swap.outAccount,
          floorOut: swap.floorOut,
          floorIn: swap.floorIn,
          maxDeadlineSlots: swap.maxDeadlineSlots,
        }
      : null,
  }
  refusals.push(
    ...validateRelayPolicyConfig(
      config,
      {
        mandate: mandateAddress,
        policy: policyPda.address,
        authority: authorityPda.address,
        owner,
        agent: input.agent,
      },
      input.validation,
    ).map((m) => `policy config: ${m}`),
  )

  // Existing SPL delegates: Approve REPLACES the delegate (one per token account).
  const approvedAccounts: Address[] = []
  if (sourceApproved) approvedAccounts.push(input.token.source)
  if (swap && separateIn) approvedAccounts.push(swap.inAccount)
  for (const account of approvedAccounts) {
    const view = cs?.tokenAccounts?.[account]
    if (view === null) {
      refusals.push(`token account ${short(account)} does not exist (Approve would fail)`)
    } else if (view && view.delegate !== null && view.delegate !== authorityPda.address) {
      const msg = `token account ${short(account)} already delegates ${view.delegatedAmount} units to ${short(view.delegate)}; Approve would silently REPLACE that delegation`
      if (input.allowReplaceDelegate === true) warnings.push(`${msg} (allowReplaceDelegate).`)
      else refusals.push(`${msg}; pass allowReplaceDelegate: true to accept it`)
    }
  }
  if (input.recipients.length === 0 && !swap) {
    warnings.push(
      'No recipients and no swap: the policy would reject every relay action (RecipientNotAllowed 104) and no SPL Approve is emitted, so delegateCap is unused. Add recipients or a swap, or skip the relay.',
    )
  }

  if (refusals.length > 0) throw new PlanRefusedError(refusals)

  // 7. Instructions.
  const agentAuthProgram = ids.agentAuth
  const relayProgram = ids.relay
  const first: BuiltInstruction[] = []
  const fund = input.fundAgentLamports ?? 0n
  if (fund > 0n)
    first.push(systemTransferIx({ from: input.owner, to: input.agent, lamports: fund }))
  else
    warnings.push(
      'fundAgentLamports is 0: the agent needs SOL for transaction fees before it can act.',
    )
  first.push(
    await createMandateIx({
      owner: input.owner,
      agent: input.agent,
      expiry: input.expiry,
      mandate: mandateAddress,
      agentAuthProgram,
    }),
  )
  const ordered: NormalizedPermission[] = [
    ...(tokenPerm ? [tokenPerm] : []),
    ...(ammPerm && ammPerm !== tokenPerm ? [ammPerm] : []),
    ...normalized.filter((n) => n !== tokenPerm && n !== ammPerm),
  ]
  for (const n of ordered) {
    first.push(
      await addPermissionIx({
        ...n.input,
        owner: input.owner,
        mandate: mandateAddress,
        agentAuthProgram,
      }),
    )
  }
  if (sourceApproved) {
    first.push(
      await approveIx({
        source: input.token.source,
        owner: input.owner,
        delegate: authorityPda.address,
        amount: input.token.delegateCap,
        tokenProgram,
      }),
    )
  }
  if (swap && separateIn && swap.delegateCap !== undefined) {
    first.push(
      await approveIx({
        source: swap.inAccount,
        owner: input.owner,
        delegate: authorityPda.address,
        amount: swap.delegateCap,
        tokenProgram: swap.inTokenProgram,
      }),
    )
  }
  const init = await initPolicyIx({
    owner: input.owner,
    agent: input.agent,
    mandate: mandateAddress,
    config,
    paused: input.paused,
    allowCpi: input.allowCpi,
    relayProgram,
    agentAuthProgram,
    validation: input.validation,
  })
  if (input.allowCpi === true)
    warnings.push(
      'allowCpi: STRICT_TOP_LEVEL is off, so relay calls made through other programs are accepted.',
    )
  warnings.push(
    'SPL allows one delegate per token account: each Approve REPLACES any existing delegate on that account.',
    'Until the final step (init_policy) lands, the relay fails closed with InvalidPolicy (101); the agent can do nothing through it.',
  )
  if (input.recipients.length > 0) {
    warnings.push(
      'Recipients are token accounts, not wallets: the relay pins the account, not its owner.',
    )
  }

  const groups = packInstructions(first, feePayer)
  const steps: PlanStep[] = groups.map((ixs, i) =>
    makeStep(
      groups.length === 1
        ? 'Create mandate, grant permissions, delegate'
        : `Create mandate, grant permissions, delegate (${i + 1}/${groups.length})`,
      'Owner-signed: [fund agent], create_mandate, add_permission per program, SPL Approve to the relay authority.',
      ixs,
      i === groups.length - 1
        ? 'Mandate exists with the permissions; the relay authority holds a bounded SPL delegation. The agent still cannot act (no policy yet).'
        : 'Part of the mandate set-up; later parts follow in order.',
      feePayer,
      { dependsOn: i === 0 ? [] : [i - 1], awaitConfirmation: true },
    ),
  )
  steps.push(
    makeStep(
      'Activate relay policy',
      'Owner-signed: relay init_policy pins recipients, mint, source and (optionally) one swap pool. Config is immutable afterwards.',
      [init],
      'RelayPolicy account exists; relay transfer/swap now work within the mandate and delegation.',
      feePayer,
      { dependsOn: groups.map((_, i) => i), awaitConfirmation: false },
    ),
  )
  if (steps.length > 2)
    warnings.push(
      `The set-up needs ${steps.length} transactions (the first did not fit 1232 bytes).`,
    )
  for (const s of steps) {
    if (!s.fitsInOneTx)
      warnings.push(
        `Step "${s.label}" is ${s.estimatedSizeBytes} bytes and does not fit one transaction.`,
      )
  }

  const summary = `Onboard agent ${short(input.agent)} for owner ${short(owner)}: create mandate (expires ${isoOfSeconds(input.expiry)}), ${normalized.length} permission${normalized.length === 1 ? '' : 's'}, delegate ${input.token.delegateCap} raw units of ${short(input.token.mint)} to the relay authority, allowlist ${input.recipients.length} recipient token account${input.recipients.length === 1 ? '' : 's'}${swap ? ', one pinned swap pool' : ''}. ${steps.length} transactions, unsigned.`
  return { steps, warnings, summary }
}

// ---------------------------------------------------------------------------------------------
// planUnwind
// ---------------------------------------------------------------------------------------------

/** A token account whose SPL delegation should be revoked. */
export interface DelegatedAccount {
  readonly address: Address
  /** Defaults to the classic Token program. */
  readonly tokenProgram?: Address
}

/** Input of {@link planUnwind}. */
export interface UnwindInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  /** Token accounts to revoke. Defaults to the policy's source (and swap input) account when `chainState.policy` is known. */
  readonly tokenAccounts?: readonly DelegatedAccount[]
}

async function mandateOf(
  input: PlanCommon & { agent?: Address; mandate?: Address },
  ids: ProgramIds,
): Promise<Address> {
  return resolveMandate(
    {
      owner: input.owner,
      agent: input.agent ?? input.chainState?.mandate?.agent ?? input.chainState?.policy?.agent,
      mandate: input.mandate,
    },
    ids.agentAuth,
  )
}

/**
 * Plan the one-transaction unwind of RELAY-SPEC 12.3: `Revoke(source)`, `Revoke(in_account)` if
 * different, `revoke_mandate`, `close_policy`. Each element alone already stops the agent; together
 * they leave no stale delegation, mandate or policy. Elements that `chainState` shows are already
 * gone are skipped. If the set does not fit 1232 bytes it is split with the kill switch
 * (`revoke_mandate`) first.
 *
 * Revoking does not undo past transfers. Use a priority fee for urgency (not set by the SDK).
 */
export async function planUnwind(input: UnwindInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const mandate = await mandateOf(input, ids)
  const cs = input.chainState
  const warnings: string[] = []

  let accounts = input.tokenAccounts
  if (accounts === undefined && cs?.policy) {
    const p = cs.policy
    accounts = [{ address: p.sourceAccount, tokenProgram: p.tokenProgram }]
    if (p.swap && p.swap.inAccount !== p.sourceAccount) {
      accounts = [...accounts, { address: p.swap.inAccount, tokenProgram: p.swap.inTokenProgram }]
    }
  }
  if (!accounts || accounts.length === 0) {
    warnings.push(
      'No token accounts to revoke were given or derivable: the SPL delegation (if any) stays on the source account until you revoke it (see findDelegationsTo).',
    )
  }
  // SPL has ONE delegate per account: only revoke when the current delegate is this mandate's
  // authority, otherwise we would kill another mandate's (or someone else's) delegation.
  const authority = (await relayAuthorityPda(mandate, ids.relay)).address
  const toRevoke: DelegatedAccount[] = []
  for (const a of accounts ?? []) {
    const view = cs?.tokenAccounts?.[a.address]
    if (view === null) {
      warnings.push(`Token account ${short(a.address)} does not exist: its Revoke was skipped.`)
    } else if (view && view.delegate === null) {
      warnings.push(`Token account ${short(a.address)} has no delegate: its Revoke was skipped.`)
    } else if (view && view.delegate !== authority) {
      warnings.push(
        `Token account ${short(a.address)} is delegated to ${short(view.delegate as string)}, not to this mandate's relay authority: its Revoke was skipped so another delegation is not destroyed.`,
      )
    } else {
      toRevoke.push(a)
    }
  }
  const revokes = toRevoke.map((a) =>
    revokeDelegateIx({
      source: a.address,
      owner: input.owner,
      tokenProgram: a.tokenProgram ?? ids.token,
    }),
  )
  const mandateGone = cs?.mandate === null
  const policyGone = cs?.policy === null
  const kill: BuiltInstruction[] = []
  if (!mandateGone)
    kill.push(
      await revokeMandateIx({ owner: input.owner, mandate, agentAuthProgram: ids.agentAuth }),
    )
  else warnings.push('The mandate no longer exists: revoke_mandate was skipped.')
  const close: BuiltInstruction[] = []
  if (!policyGone)
    close.push(
      await closePolicyIx({
        owner: input.owner,
        mandate,
        relayProgram: ids.relay,
        agentAuthProgram: ids.agentAuth,
      }),
    )
  else warnings.push('The relay policy no longer exists: close_policy was skipped.')
  const stateKnown = cs?.mandate !== undefined && cs?.policy !== undefined
  warnings.push(
    'Revoking stops future agent actions only; it does not undo transfers that already happened.',
    'Send with a priority fee if you need this to land quickly during congestion (setComputeUnitPriceIx).',
    'revoke_mandate destroys the counters. Re-creating a mandate for the same agent gives the same address but a new generation.',
  )

  const all = [...revokes, ...kill, ...close]
  if (all.length === 0)
    throw new PlanRefusedError(['nothing to unwind: no delegation, mandate or policy remains'])

  let steps: PlanStep[]
  if (!stateKnown) {
    // Unknown state: one failing cleanup instruction (policy never created, already closed) would
    // revert a combined transaction INCLUDING the kill switch. Kill switch alone first; the
    // best-effort cleanup is independent and may fail without undoing it.
    warnings.push(
      'Chain state was not checked, so the unwind is split: transaction 1 is the kill switch alone (revoke_mandate), transaction 2 is the cleanup (Revoke, close_policy). If the cleanup fails because something is already gone, the kill switch is unaffected. Re-plan with chainState (client.plan.unwind) for a single transaction.',
    )
    steps = []
    if (kill.length > 0) {
      steps.push(
        makeStep(
          `Unwind 1/${1 + packInstructions([...revokes, ...close], feePayer).length}: kill switch`,
          'Owner-signed: revoke_mandate alone, so nothing can revert it.',
          kill,
          'The mandate is destroyed: the agent is stopped.',
          feePayer,
        ),
      )
    }
    const groups = packInstructions([...revokes, ...close], feePayer)
    const total = groups.length + (kill.length > 0 ? 1 : 0)
    for (const ixs of groups) {
      steps.push(
        makeStep(
          `Unwind ${steps.length + 1}/${total}: cleanup`,
          'Owner-signed, best effort: SPL Revoke per delegated account and close_policy.',
          ixs,
          'No stale delegation and no policy. May fail if they are already gone.',
          feePayer,
        ),
      )
    }
  } else {
    const single = makeStep(
      'Unwind: revoke delegation, mandate and policy',
      'One owner-signed transaction: SPL Revoke per delegated account, revoke_mandate, close_policy.',
      all,
      'No delegation, no mandate, no policy: the agent can do nothing.',
      feePayer,
    )
    steps = [single]
    if (!single.fitsInOneTx) {
      const groups = packInstructions([...kill, ...close, ...revokes], feePayer)
      steps = groups.map((ixs, i) =>
        makeStep(
          `Unwind (${i + 1}/${groups.length})`,
          'Kill switch first (revoke_mandate, close_policy), then delegation revokes.',
          ixs,
          'Part of the unwind; the agent is already stopped once the first part lands.',
          feePayer,
        ),
      )
      warnings.push(
        `The full unwind did not fit one transaction (${single.worstCaseSizeBytes} bytes worst case); it was split with the kill switch first.`,
      )
    }
  }
  return {
    steps,
    warnings,
    summary: `Unwind mandate ${short(mandate)}: ${revokes.length} delegation revoke${revokes.length === 1 ? '' : 's'}${mandateGone ? '' : ', revoke_mandate'}${policyGone ? '' : ', close_policy'} in ${steps.length} transaction${steps.length === 1 ? '' : 's'}, unsigned.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------------------------

/** Which kill switches {@link planPause} / {@link planResume} touch. */
export type PauseScope = 'relay' | 'mandate' | 'both'

/** Input of {@link planPause} and {@link planResume}. */
export interface PauseInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  /** Default `"both"`: relay `set_paused` AND core `set_active`. */
  readonly scope?: PauseScope
}

async function pauseOrResume(input: PauseInput, pause: boolean): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const scope = input.scope ?? 'both'
  const mandate = await mandateOf(input, ids)
  const cs = input.chainState
  const warnings: string[] = []
  const ixs: BuiltInstruction[] = []
  if (scope !== 'mandate') {
    if (cs?.policy === null) warnings.push('No relay policy exists: set_paused was skipped.')
    else
      ixs.push(
        await setPausedIx({
          owner: input.owner,
          mandate,
          paused: pause,
          relayProgram: ids.relay,
          agentAuthProgram: ids.agentAuth,
        }),
      )
  }
  if (scope !== 'relay') {
    ixs.push(
      await setActiveIx({
        owner: input.owner,
        mandate,
        active: !pause,
        agentAuthProgram: ids.agentAuth,
      }),
    )
  }
  if (!pause && cs?.mandate) {
    const now = input.now !== undefined ? toSeconds(input.now) : nowSeconds()
    if (now >= cs.mandate.expiry)
      warnings.push(
        'The mandate has expired: resuming it does not help, verify still fails with Expired (5). Create a new mandate.',
      )
  }
  if (pause) {
    warnings.push(
      'Pausing is reversible and keeps counters and permissions. Core edits (add/remove/update permission) fail with NotActive while the mandate is paused.',
      'Pausing stops future actions only. It does not revoke the SPL delegation; use planUnwind for a full stop.',
    )
  }
  if (ixs.length === 0) throw new PlanRefusedError(['nothing to do for the requested scope'])
  const step = makeStep(
    pause ? 'Pause' : 'Resume',
    pause
      ? 'Owner-signed: relay set_paused(1) and/or core set_active(0).'
      : 'Owner-signed: relay set_paused(0) and/or core set_active(1).',
    ixs,
    pause
      ? 'The relay and/or the mandate reject every agent action until resumed.'
      : 'Agent actions work again within the mandate and delegation.',
    feePayer,
  )
  return {
    steps: [step],
    warnings,
    summary: `${pause ? 'Pause' : 'Resume'} mandate ${short(mandate)} (scope: ${scope}), unsigned.`,
  }
}

/** Plan a reversible stop: relay `set_paused(1)` and/or core `set_active(0)`, one transaction. */
export function planPause(input: PauseInput): Promise<Plan> {
  return pauseOrResume(input, true)
}

/** Plan the inverse of {@link planPause}: relay `set_paused(0)` and/or core `set_active(1)`. */
export function planResume(input: PauseInput): Promise<Plan> {
  return pauseOrResume(input, false)
}

// ---------------------------------------------------------------------------------------------
// Permission edits
// ---------------------------------------------------------------------------------------------

/** Wrap edit instructions so a paused mandate can be edited and is paused again afterwards. */
async function withResumedIfPaused(
  edits: BuiltInstruction[],
  input: PlanCommon,
  mandate: Address,
  ids: ProgramIds,
  warnings: string[],
): Promise<BuiltInstruction[]> {
  const m = input.chainState?.mandate
  if (m && !m.active) {
    warnings.push(
      'The mandate is paused and core edits fail with NotActive while paused: the plan resumes it, edits, and pauses it again inside ONE transaction (atomic, the agent cannot act in between).',
    )
    return [
      await setActiveIx({
        owner: input.owner,
        mandate,
        active: true,
        agentAuthProgram: ids.agentAuth,
      }),
      ...edits,
      await setActiveIx({
        owner: input.owner,
        mandate,
        active: false,
        agentAuthProgram: ids.agentAuth,
      }),
    ]
  }
  return edits
}

/** Input of {@link planRevokePermission}. */
export interface RevokePermissionInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  /** Program whose permission slot is removed. */
  readonly program: Address
  /**
   * Instead of removing the slot outright, re-add it with a narrower discriminator list
   * (the "live per-instruction revoke" beat). Requires `chainState.mandate` so the remaining
   * budget can be carried over: remove + add resets the counters, so the new lifetime limit is the
   * old limit minus what was already spent.
   */
  readonly replaceWith?: { readonly discriminators: readonly (Uint8Array | string)[] }
  /** Needed when the existing limit is unlimited and `replaceWith` re-adds it. */
  readonly allowUnlimited?: boolean
  /** Allow `replaceWith` to contain discriminators the slot does not have today (widening). Default false. */
  readonly allowWiden?: boolean
}

/**
 * Plan `remove_permission` (the live per-instruction revoke). Removing a slot deletes ALL of its
 * discriminators: the next verify for that program fails with ProgramNotAllowed (6). To show
 * DiscriminatorNotAllowed (7) instead, pass `replaceWith` to re-add the slot with fewer
 * discriminators; the remaining budget is carried over so the reset counters do not grant a fresh
 * budget.
 */
export async function planRevokePermission(input: RevokePermissionInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const mandate = await mandateOf(input, ids)
  const warnings: string[] = []
  const slot = input.chainState?.mandate?.permissions.find((p) => p.program === input.program)
  if (input.chainState?.mandate && !slot) {
    throw new PlanRefusedError([
      `the mandate has no permission for ${input.program} (core error 12 PermissionNotFound)`,
    ])
  }
  const edits: BuiltInstruction[] = [
    await removePermissionIx({
      owner: input.owner,
      mandate,
      program: input.program,
      agentAuthProgram: ids.agentAuth,
    }),
  ]
  let outcome = `Verify for ${short(input.program)} now fails with ProgramNotAllowed (6); other permissions keep working.`
  if (input.replaceWith) {
    if (!slot) {
      throw new PlanRefusedError([
        'replaceWith needs chainState.mandate to carry the remaining budget over',
      ])
    }
    if (input.allowWiden !== true) {
      const current = new Set(slot.discriminatorsHex)
      const wider = parseDiscList(input.replaceWith.discriminators)
        .map(toHex)
        .filter((h) => !current.has(h))
      if (wider.length > 0) {
        throw new PlanRefusedError([
          `replaceWith contains discriminators the permission does not have (${wider.map((h) => '0x' + h).join(', ')}): a revoke must not widen it; pass allowWiden: true to accept`,
        ])
      }
    }
    const remaining = slot.spendUnlimited
      ? 'unlimited'
      : slot.spendLimit - (slot.spendTotal < slot.spendLimit ? slot.spendTotal : slot.spendLimit)
    if (remaining !== 'unlimited' && remaining <= 0n) {
      throw new PlanRefusedError([
        'the lifetime budget of this permission is already used up; remove it without replaceWith',
      ])
    }
    const perTx: LimitInput = slot.perTxUnlimited ? 'unlimited' : slot.perTxLimit
    if ((remaining === 'unlimited' || perTx === 'unlimited') && input.allowUnlimited !== true) {
      throw new PlanRefusedError([
        'the existing permission has an unlimited limit; re-adding it needs allowUnlimited: true',
      ])
    }
    edits.push(
      await addPermissionIx({
        owner: input.owner,
        mandate,
        program: input.program,
        spendLimit: remaining,
        perTxLimit: perTx,
        discriminators: input.replaceWith.discriminators,
        agentAuthProgram: ids.agentAuth,
      }),
    )
    warnings.push(
      'remove + add resets spend_total and call_count; the new lifetime limit is the old limit minus what was already spent, so the total budget is unchanged. The recorded call count restarts at 0.',
    )
    outcome = `Permission re-added with a narrower discriminator list: calls with a removed discriminator fail with DiscriminatorNotAllowed (7).`
  } else {
    warnings.push(
      'remove_permission deletes the WHOLE slot (all discriminators). Re-adding it later resets spend_total and call_count.',
    )
  }
  const ixs = await withResumedIfPaused(edits, input, mandate, ids, warnings)
  const step = makeStep('Revoke permission', 'Owner-signed core edit.', ixs, outcome, feePayer)
  return {
    steps: [step],
    warnings,
    summary: `Revoke the permission for ${short(input.program)} on mandate ${short(mandate)}, unsigned.`,
  }
}

/** Input of {@link planRevokeDiscriminator}. */
export interface RevokeDiscriminatorInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  readonly program: Address
  /** One or more discriminators (8 bytes or 16 hex chars) to take away from the permission. */
  readonly discriminators: readonly (Uint8Array | string)[]
  readonly allowUnlimited?: boolean
}

/**
 * Take ONE (or a few) discriminators away from a permission, keeping the rest and the remaining
 * budget. Computes the kept list for you; when nothing would be kept it plans a plain
 * `remove_permission`. Needs `chainState.mandate` (use `client.plan.revokeDiscriminator`).
 *
 * @throws PlanRefusedError when the mandate state is unknown, the slot is missing, or a discriminator is not in the slot
 */
export async function planRevokeDiscriminator(input: RevokeDiscriminatorInput): Promise<Plan> {
  const m = input.chainState?.mandate
  if (!m) {
    throw new PlanRefusedError([
      'planRevokeDiscriminator needs chainState.mandate (use client.plan)',
    ])
  }
  const slot = m.permissions.find((p) => p.program === input.program)
  if (!slot) {
    throw new PlanRefusedError([
      `the mandate has no permission for ${input.program} (core error 12 PermissionNotFound)`,
    ])
  }
  const remove = parseDiscList(input.discriminators).map(toHex)
  const missing = remove.filter((h) => !slot.discriminatorsHex.includes(h))
  if (missing.length > 0) {
    throw new PlanRefusedError([
      `the permission does not contain ${missing.map((h) => '0x' + h).join(', ')}`,
    ])
  }
  const kept = slot.discriminatorsHex.filter((h) => !remove.includes(h))
  return planRevokePermission({
    ...input,
    ...(kept.length > 0 ? { replaceWith: { discriminators: kept } } : {}),
  })
}

/** Input of {@link planUpdateLimits}. */
export interface UpdateLimitsInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  readonly program: Address
  readonly spendLimit: LimitInput
  readonly perTxLimit: LimitInput
  /** Accept `"unlimited"`. Default false: refused. */
  readonly allowUnlimited?: boolean
}

/**
 * Plan `update_permission`: change the lifetime and per-call limits of one slot. Counters and the
 * discriminator list are preserved, so changing a limit does not grant a fresh budget. Lowering the
 * lifetime limit below what was already spent blocks the permission until the owner raises it.
 */
export async function planUpdateLimits(input: UpdateLimitsInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const mandate = await mandateOf(input, ids)
  const warnings: string[] = []
  const refusals: string[] = []
  let spend = 0n
  let perTx = 0n
  try {
    spend = parseLimit(input.spendLimit, 'spendLimit')
    perTx = parseLimit(input.perTxLimit, 'perTxLimit')
  } catch (error) {
    refusals.push(error instanceof SdkError ? error.message : String(error))
  }
  if ((spend === 0n || perTx === 0n) && refusals.length === 0) {
    if (input.allowUnlimited === true)
      warnings.push('UNLIMITED limit accepted (allowUnlimited): nothing in the mandate caps it.')
    else
      refusals.push(
        'an unlimited limit was requested; pass allowUnlimited: true to accept it explicitly',
      )
  }
  const slot = input.chainState?.mandate?.permissions.find((p) => p.program === input.program)
  if (input.chainState?.mandate && !slot)
    refusals.push(`the mandate has no permission for ${input.program} (core error 12)`)
  if (slot && spend !== 0n && slot.spendTotal >= spend) {
    warnings.push(
      `The new lifetime limit ${spend} is not above the amount already spent (${slot.spendTotal}): the permission is blocked until the limit is raised again.`,
    )
  }
  if (slot && slot.spendUnlimited && slot.spendTotal === U64_MAX && spend !== 0n) {
    warnings.push(
      'spend_total saturated at u64::MAX while the permission was unlimited: a finite limit blocks it until remove + add.',
    )
  }
  if (spend !== 0n && perTx !== 0n && perTx > spend) {
    warnings.push(
      'The per-call limit is larger than the lifetime limit: the lifetime limit always binds first.',
    )
  }
  if (refusals.length > 0) throw new PlanRefusedError(refusals)
  const edits = [
    await updatePermissionIx({
      owner: input.owner,
      mandate,
      program: input.program,
      spendLimit: input.spendLimit,
      perTxLimit: input.perTxLimit,
      agentAuthProgram: ids.agentAuth,
    }),
  ]
  const ixs = await withResumedIfPaused(edits, input, mandate, ids, warnings)
  warnings.push('Counters are preserved: raising a limit does not reset what was already spent.')
  return {
    steps: [
      makeStep(
        'Update limits',
        'Owner-signed update_permission.',
        ixs,
        'New limits apply to the next verify call.',
        feePayer,
      ),
    ],
    warnings,
    summary: `Update limits of ${short(input.program)} on mandate ${short(mandate)}, unsigned.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Policy lifecycle
// ---------------------------------------------------------------------------------------------

/** Input of {@link planClosePolicy}. */
export interface ClosePolicyInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
}

/** Plan relay `close_policy`. The agent fails closed (InvalidPolicy 101); the SPL delegation is NOT revoked. */
export async function planClosePolicy(input: ClosePolicyInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const mandate = await mandateOf(input, ids)
  if (input.chainState?.policy === null)
    throw new PlanRefusedError(['no relay policy exists for this mandate'])
  const ix = await closePolicyIx({
    owner: input.owner,
    mandate,
    relayProgram: ids.relay,
    agentAuthProgram: ids.agentAuth,
  })
  return {
    steps: [
      makeStep(
        'Close relay policy',
        'Owner-signed relay close_policy; rent returns to the owner.',
        [ix],
        'The relay fails closed (101) for this mandate until a new policy is initialised.',
        feePayer,
      ),
    ],
    warnings: [
      'The SPL delegation on the source account is NOT revoked by this plan; use planUnwind for a full stop.',
      'The mandate and its counters are untouched.',
    ],
    summary: `Close the relay policy of mandate ${short(mandate)}, unsigned.`,
  }
}

/** Input of {@link planReinitPolicy}. */
export interface ReinitPolicyInput extends PlanCommon {
  readonly agent: Address
  readonly config: RelayPolicyConfig
  readonly allowCpi?: boolean
  readonly paused?: boolean
  readonly validation?: PolicyConfigOptions
}

/**
 * Plan a policy change: `close_policy` then `init_policy` in two transactions (RELAY-SPEC 12.2; the
 * config is immutable and a closed account cannot be re-initialised in the same transaction). The
 * close step is skipped when `chainState.policy` is `null`. Delegations are not touched.
 */
export async function planReinitPolicy(input: ReinitPolicyInput): Promise<Plan> {
  const ids = idsOf(input)
  const owner = addressOf(input.owner)
  const feePayer = input.feePayer ?? owner
  const mandate = await mandateOf(input, ids)
  const init = await initPolicyIx({
    owner: input.owner,
    agent: input.agent,
    mandate,
    config: input.config,
    allowCpi: input.allowCpi,
    paused: input.paused,
    relayProgram: ids.relay,
    agentAuthProgram: ids.agentAuth,
    validation: input.validation,
  })
  const steps: PlanStep[] = []
  const warnings: string[] = []
  if (input.chainState?.mandate && !input.chainState.mandate.active) {
    warnings.push(
      'The mandate is paused: init_policy requires an active mandate (relay error 117). Resume it first (planResume).',
    )
  }
  warnings.push(
    'Between the two transactions the agent fails closed (InvalidPolicy 101).',
    'This plan does not touch SPL delegations: if the source or input account changed, approve the new account(s) with the relay authority as delegate.',
  )
  if (input.chainState?.policy !== null) {
    steps.push(
      makeStep(
        'Close old policy',
        'Owner-signed relay close_policy.',
        [
          await closePolicyIx({
            owner: input.owner,
            mandate,
            relayProgram: ids.relay,
            agentAuthProgram: ids.agentAuth,
          }),
        ],
        'The old policy is gone; the relay fails closed.',
        feePayer,
        { awaitConfirmation: true },
      ),
    )
  } else {
    warnings.push('No existing policy: the close step was skipped.')
  }
  steps.push(
    makeStep(
      'Init new policy',
      'Owner-signed relay init_policy with the new immutable config.',
      [init],
      'The new policy is live.',
      feePayer,
      { dependsOn: steps.length > 0 ? [0] : [] },
    ),
  )
  return {
    steps,
    warnings,
    summary: `Re-initialise the relay policy of mandate ${short(mandate)} in ${steps.length} transaction${steps.length === 1 ? '' : 's'}, unsigned.`,
  }
}
