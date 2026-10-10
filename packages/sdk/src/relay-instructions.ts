import type { Address } from '@solana/kit'
import { concatBytes, u64ToLe } from './bytes'
import { AGENT_AUTH_PROGRAM_ID, RELAY_PROGRAM_ID, SYSTEM_PROGRAM_ID } from './constants'
import {
  addressOf,
  instruction,
  meta,
  positiveU64,
  signerMeta,
  type AddressOrSigner,
  type BuiltInstruction,
} from './ix'
import { mandatePda, relayAuthorityPda, relayPolicyPda } from './pda'
import { encodeInitPolicyData, type PolicyConfigOptions } from './policy-config'
import { ValidationError } from './sdk-errors'
import type { RelayPolicy, RelayPolicyConfig, SwapConfig } from './types'

/** Derived/explicit addresses every relay instruction needs. */
interface RelayRefs {
  readonly mandate: Address
  readonly policy: Address
  readonly authority: Address
}

async function resolveRefs(
  input: {
    owner?: Address
    agent?: Address
    mandate?: Address
    policyAddress?: Address
    authority?: Address
  },
  relayProgram: Address,
  agentAuthProgram: Address,
): Promise<RelayRefs> {
  let mandate = input.mandate
  if (mandate === undefined) {
    if (input.owner === undefined || input.agent === undefined) {
      throw new ValidationError(
        'MISSING_ADDRESS',
        'pass `policy`, or `mandate`, or both `owner` and `agent` (to derive the mandate)',
      )
    }
    mandate = (await mandatePda(input.owner, input.agent, agentAuthProgram)).address
  }
  const policy = input.policyAddress ?? (await relayPolicyPda(mandate, relayProgram)).address
  const authority = input.authority ?? (await relayAuthorityPda(mandate, relayProgram)).address
  return { mandate, policy, authority }
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new ValidationError(
      'MISSING_ADDRESS',
      `missing \`${name}\` (pass it, or pass \`policy\`)`,
    )
  }
  return value
}

/** Parameters of {@link initPolicyIx}. */
export interface InitPolicyParams {
  /** Owner (signer, pays rent). */
  readonly owner: AddressOrSigner
  /** Agent named in the mandate. Needed to derive the mandate (and to check agent != owner). */
  readonly agent?: Address
  /** Mandate PDA; derived from `owner` + `agent` when omitted. */
  readonly mandate?: Address
  readonly config: RelayPolicyConfig
  /** Start paused. Default false. */
  readonly paused?: boolean
  /**
   * Allow relay actions inside CPIs. Default false: the SDK sets STRICT_TOP_LEVEL so the relay
   * rejects calls that are not top-level instructions (RELAY-SPEC D5).
   */
  readonly allowCpi?: boolean
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
  /** AMM allowlist / validation switches, see {@link PolicyConfigOptions}. */
  readonly validation?: PolicyConfigOptions
}

/**
 * Relay `init_policy` (tag 0, 802 data bytes). Accounts `[owner S W, mandate R, policy W, system R]`.
 * Validates the whole config client-side (distinctness rules, 8-recipient cap, swap rules) and
 * throws before encoding anything invalid.
 *
 * Config is immutable after init: changing it later means `close_policy` then `init_policy`.
 *
 * @throws ValidationError `BAD_CONFIG` (relayCode 113)
 */
export async function initPolicyIx(params: InitPolicyParams): Promise<BuiltInstruction> {
  const relay = params.relayProgram ?? RELAY_PROGRAM_ID
  const agentAuth = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const owner = addressOf(params.owner)
  const refs = await resolveRefs(
    { owner, agent: params.agent, mandate: params.mandate },
    relay,
    agentAuth,
  )
  const ctx = {
    mandate: refs.mandate,
    policy: refs.policy,
    authority: refs.authority,
    owner,
    agent: params.agent,
  }
  const data = encodeInitPolicyData(
    { paused: params.paused === true, strictTopLevel: params.allowCpi !== true },
    params.config,
    params.validation,
    ctx,
  )
  return instruction(
    relay,
    [
      signerMeta(params.owner, true),
      meta(refs.mandate, false),
      meta(refs.policy, true),
      meta(SYSTEM_PROGRAM_ID, false),
    ],
    data,
  )
}

/** Parameters of {@link setPausedIx}. */
export interface SetPausedParams {
  readonly owner: AddressOrSigner
  /** Policy account; derived from `mandate` (or `agent`) when omitted. */
  readonly policy?: Address
  readonly mandate?: Address
  readonly agent?: Address
  readonly paused: boolean
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
}

async function policyAddressFor(params: {
  owner: AddressOrSigner
  policy?: Address
  mandate?: Address
  agent?: Address
  relayProgram?: Address
  agentAuthProgram?: Address
}): Promise<{ relay: Address; policy: Address }> {
  const relay = params.relayProgram ?? RELAY_PROGRAM_ID
  if (params.policy !== undefined) return { relay, policy: params.policy }
  const refs = await resolveRefs(
    { owner: addressOf(params.owner), agent: params.agent, mandate: params.mandate },
    relay,
    params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID,
  )
  return { relay, policy: refs.policy }
}

/** Relay `set_paused` (tag 1). Accounts `[owner S, policy W]`, data `[1, paused]`. Owner only; reversible. */
export async function setPausedIx(params: SetPausedParams): Promise<BuiltInstruction> {
  const { relay, policy } = await policyAddressFor(params)
  return instruction(
    relay,
    [signerMeta(params.owner, false), meta(policy, true)],
    new Uint8Array([1, params.paused ? 1 : 0]),
  )
}

/** Parameters of {@link closePolicyIx}. */
export interface ClosePolicyParams {
  readonly owner: AddressOrSigner
  readonly policy?: Address
  readonly mandate?: Address
  readonly agent?: Address
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
}

/**
 * Relay `close_policy` (tag 2). Accounts `[owner S W, policy W]`, data `[2]`. Returns the rent to the
 * owner. Works even when the mandate is already revoked, which is why the unwind plan includes it.
 */
export async function closePolicyIx(params: ClosePolicyParams): Promise<BuiltInstruction> {
  const { relay, policy } = await policyAddressFor(params)
  return instruction(
    relay,
    [signerMeta(params.owner, true), meta(policy, true)],
    new Uint8Array([2]),
  )
}

/** Parameters of {@link relayTransferIx}. */
export interface RelayTransferParams {
  /** The agent (signer). */
  readonly agent: AddressOrSigner
  readonly amount: bigint
  /** Destination token account; must be on the policy allowlist (else relay error 104). */
  readonly destination: Address
  /** Decoded policy: supplies owner, mandate, authority, source, mint and token program. */
  readonly policy?: RelayPolicy
  /** Explicit values (win over `policy`; needed when `policy` is omitted). */
  readonly owner?: Address
  readonly mandate?: Address
  readonly policyAddress?: Address
  readonly authority?: Address
  readonly source?: Address
  readonly mint?: Address
  readonly tokenProgram?: Address
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
}

/**
 * Relay `transfer` (tag 3, 9 data bytes): hard-enforced SPL `TransferChecked` from the owner's
 * source account to an allowlisted token account. Accounts, in IDL order:
 * `[agent S, mandate W, owner R, policy R, authority R, source W, destination W, mint R,
 * token_program R, agentauth_program R]`. The agent supplies only the amount; derived PDAs are
 * filled in when omitted.
 *
 * @throws ValidationError `BAD_AMOUNT | MISSING_ADDRESS`
 */
export async function relayTransferIx(params: RelayTransferParams): Promise<BuiltInstruction> {
  const relay = params.relayProgram ?? RELAY_PROGRAM_ID
  const agentAuth = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const amount = positiveU64(params.amount, 'amount')
  const p = params.policy
  const agent = addressOf(params.agent)
  const owner = params.owner ?? p?.owner
  const refs = await resolveRefs(
    {
      owner,
      agent,
      mandate: params.mandate ?? p?.mandate,
      policyAddress: params.policyAddress ?? p?.address,
      authority: params.authority ?? p?.authority,
    },
    relay,
    agentAuth,
  )
  return instruction(
    relay,
    [
      signerMeta(params.agent, false),
      meta(refs.mandate, true),
      meta(need(owner, 'owner'), false),
      meta(refs.policy, false),
      meta(refs.authority, false),
      meta(need(params.source ?? p?.sourceAccount, 'source'), true),
      meta(params.destination, true),
      meta(need(params.mint ?? p?.budgetMint, 'mint'), false),
      meta(need(params.tokenProgram ?? p?.tokenProgram, 'tokenProgram'), false),
      meta(agentAuth, false),
    ],
    concatBytes(new Uint8Array([3]), u64ToLe(amount, 'amount')),
  )
}

/** Parameters of {@link relaySwapIx}. */
export interface RelaySwapParams {
  readonly agent: AddressOrSigner
  readonly amountIn: bigint
  /** Agent-chosen minimum output; the relay enforces `max(minOut, floor price)`. */
  readonly minOut: bigint
  /** Slot by which the swap must execute (relay error 111 when past or too far ahead). */
  readonly deadlineSlot: bigint
  /** Decoded policy with swap enabled: supplies every pinned account. */
  readonly policy: RelayPolicy
  /**
   * Replace pinned accounts to craft a hostile call (attack demos, negative tests). The relay must
   * reject every such substitution with 102/103/113; honest callers never pass this.
   */
  readonly accountOverrides?: Partial<Omit<SwapConfig, 'floorOut' | 'floorIn' | 'maxDeadlineSlots'>>
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
}

/**
 * Relay `swap` (tag 4, 25 data bytes): hard-enforced exact-in swap on the ONE pool pinned in the
 * policy. Accounts (19, IDL order): `[agent S, mandate W, owner R, policy R, authority R,
 * in_account W, out_account W, amm_program R, amm_authority R, amm_config R, pool_state W,
 * input_vault W, output_vault W, in_token_program R, out_token_program R, in_mint R, out_mint R,
 * observation_state W, agentauth_program R]`.
 *
 * @throws ValidationError `BAD_AMOUNT | MISSING_ADDRESS` (policy without swap config)
 */
export async function relaySwapIx(params: RelaySwapParams): Promise<BuiltInstruction> {
  const relay = params.relayProgram ?? RELAY_PROGRAM_ID
  const agentAuth = params.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID
  const p = params.policy
  const base = p.swap
  if (!base) {
    throw new ValidationError(
      'MISSING_ADDRESS',
      'this policy has swaps disabled (relay error 110 SwapDisabled)',
      { relayCode: 110 },
    )
  }
  const s = { ...base, ...params.accountOverrides }
  const amountIn = positiveU64(params.amountIn, 'amountIn')
  const refs = await resolveRefs(
    {
      owner: p.owner,
      agent: p.agent,
      mandate: p.mandate,
      policyAddress: p.address,
      authority: p.authority,
    },
    relay,
    agentAuth,
  )
  return instruction(
    relay,
    [
      signerMeta(params.agent, false),
      meta(refs.mandate, true),
      meta(p.owner, false),
      meta(refs.policy, false),
      meta(refs.authority, false),
      meta(s.inAccount, true),
      meta(s.outAccount, true),
      meta(s.ammProgram, false),
      meta(s.ammAuthority, false),
      meta(s.ammConfig, false),
      meta(s.poolState, true),
      meta(s.inputVault, true),
      meta(s.outputVault, true),
      meta(s.inTokenProgram, false),
      meta(s.outTokenProgram, false),
      meta(s.inMint, false),
      meta(s.outMint, false),
      meta(s.observationState, true),
      meta(agentAuth, false),
    ],
    concatBytes(
      new Uint8Array([4]),
      u64ToLe(amountIn, 'amountIn'),
      u64ToLe(params.minOut, 'minOut'),
      u64ToLe(params.deadlineSlot, 'deadlineSlot'),
    ),
  )
}
