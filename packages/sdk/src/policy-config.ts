import type { Address } from '@solana/kit'
import { addressToBytes, u64ToLe, U64_MAX } from './bytes'
import {
  INIT_POLICY_DATA_SIZE,
  MAX_DEADLINE_SLOTS_CAP,
  MAX_RECIPIENTS,
  MOCK_AMM_PROGRAM_ID,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  POLICY_CONFIG_SIZE,
  POLICY_FLAG_PAUSED,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ZERO_ADDRESS,
} from './constants'
import type { Cluster } from './constants'
import { ValidationError } from './sdk-errors'
import type { RelayPolicyConfig, SwapConfig } from './types'

/** Options of the policy-config validator / encoder. */
export interface PolicyConfigOptions {
  /**
   * AMM program ids the target relay build accepts. Defaults to the Raydium CP-Swap devnet and
   * mainnet ids plus the mock AMM. The real allowlist is compiled into the relay binary (RELAY-SPEC
   * section 4); pass the list that matches the deployment you target.
   */
  readonly ammAllowlist?: readonly Address[]
  /**
   * Skip every semantic check and only serialise. For golden vectors and negative on-chain tests.
   * Never use for real owner flows.
   */
  readonly skipValidation?: boolean
}

/** Addresses of the other accounts the distinctness rule involves (RELAY-SPEC section 5.2). */
export interface PolicyContext {
  readonly mandate?: Address
  readonly policy?: Address
  readonly authority?: Address
  readonly owner?: Address
  readonly agent?: Address
}

/** Policy flags as booleans. */
export interface PolicyFlagsInput {
  readonly paused?: boolean
  /** Require relay actions to be top-level instructions (stack height 1). */
  readonly strictTopLevel?: boolean
}

/** The default AMM allowlist used for client-side validation. */
export const DEFAULT_AMM_ALLOWLIST: readonly Address[] = [
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
]

/**
 * The AMM allowlist matching one relay build: devnet CPMM on devnet, mainnet CPMM on mainnet-beta,
 * and additionally the mock AMM on localnet. Pass it as `validation: { ammAllowlist }` so client
 * validation matches the deployed relay (the default accepts all three).
 */
export function defaultAmmAllowlist(cluster: Cluster): readonly Address[] {
  if (cluster === 'mainnet-beta') return [RAYDIUM_CPMM_MAINNET_PROGRAM_ID]
  if (cluster === 'localnet') return [RAYDIUM_CPMM_DEVNET_PROGRAM_ID, MOCK_AMM_PROGRAM_ID]
  return [RAYDIUM_CPMM_DEVNET_PROGRAM_ID]
}

const TOKEN_PROGRAMS: readonly Address[] = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

/** Pack flag booleans into the policy flags byte. */
export function encodePolicyFlags(flags: PolicyFlagsInput | number): number {
  if (typeof flags === 'number') {
    if (!Number.isInteger(flags) || flags < 0 || flags > 255 || (flags & 0xfc) !== 0) {
      throw new ValidationError(
        'BAD_CONFIG',
        `flags 0x${flags.toString(16)}: only bits 0 (paused) and 1 (strict top level) may be set`,
        { relayCode: 113 },
      )
    }
    return flags
  }
  return (
    (flags.paused ? POLICY_FLAG_PAUSED : 0) |
    (flags.strictTopLevel ? POLICY_FLAG_STRICT_TOP_LEVEL : 0)
  )
}

/**
 * Validate a policy config against every `init_policy` rule of RELAY-SPEC section 5.2 and return the
 * list of problems (empty = valid). Each problem corresponds to relay error 113 (InvalidConfig).
 */
export function validateRelayPolicyConfig(
  config: RelayPolicyConfig,
  ctx: PolicyContext = {},
  opts: PolicyConfigOptions = {},
): string[] {
  const problems: string[] = []
  const allow = opts.ammAllowlist ?? DEFAULT_AMM_ALLOWLIST
  const zero = (a: Address): boolean => a === ZERO_ADDRESS

  if (!TOKEN_PROGRAMS.includes(config.tokenProgram)) {
    problems.push('tokenProgram must be the Token or Token-2022 program id')
  }
  if (zero(config.budgetMint)) problems.push('budgetMint must be non-zero')
  if (config.budgetMint === NATIVE_MINT || config.budgetMint === NATIVE_MINT_2022)
    problems.push('budgetMint must not be a native (wrapped SOL) mint (classic or Token-2022)')
  if (zero(config.sourceAccount)) problems.push('sourceAccount must be non-zero')

  if (config.recipients.length > MAX_RECIPIENTS) {
    problems.push(`at most ${MAX_RECIPIENTS} recipients (got ${config.recipients.length})`)
  }
  const seenRecipients = new Set<string>()
  config.recipients.forEach((r, i) => {
    if (zero(r)) problems.push(`recipient ${i} must be non-zero`)
    if (r === config.sourceAccount) problems.push(`recipient ${i} must not equal sourceAccount`)
    if (seenRecipients.has(r)) problems.push(`recipient ${i} duplicates an earlier recipient`)
    seenRecipients.add(r)
  })

  const swap = config.swap
  if (swap) problems.push(...validateSwap(swap, config, allow))

  // Pairwise distinctness among all pinned keys; the single permitted exception is
  // swap.inAccount === sourceAccount.
  const keyed: [string, Address | undefined][] = [
    ['mandate', ctx.mandate],
    ['policy', ctx.policy],
    ['authority', ctx.authority],
    ['owner', ctx.owner],
    ['agent', ctx.agent],
    ['sourceAccount', config.sourceAccount],
    ...config.recipients.map((r, i): [string, Address] => [`recipient ${i}`, r]),
  ]
  if (swap) {
    keyed.push(
      ['ammProgram', swap.ammProgram],
      ['ammAuthority', swap.ammAuthority],
      ['ammConfig', swap.ammConfig],
      ['poolState', swap.poolState],
      ['inputVault', swap.inputVault],
      ['outputVault', swap.outputVault],
      ['observationState', swap.observationState],
      ['outAccount', swap.outAccount],
    )
    if (swap.inAccount !== config.sourceAccount) keyed.push(['inAccount', swap.inAccount])
  }
  const seen = new Map<string, string>()
  for (const [label, key] of keyed) {
    if (key === undefined || zero(key)) continue
    const prior = seen.get(key)
    if (prior !== undefined && !(prior.startsWith('recipient') && label.startsWith('recipient'))) {
      problems.push(`${label} and ${prior} must be different accounts (${key})`)
    }
    seen.set(key, label)
  }
  if (ctx.owner !== undefined && ctx.agent !== undefined && ctx.owner === ctx.agent) {
    problems.push('agent must differ from owner (an agent equal to the owner holds full authority)')
  }
  return problems
}

function validateSwap(
  swap: SwapConfig,
  config: RelayPolicyConfig,
  allow: readonly Address[],
): string[] {
  const p: string[] = []
  const zero = (a: Address): boolean => a === ZERO_ADDRESS
  if (!allow.includes(swap.ammProgram)) {
    p.push(`ammProgram ${swap.ammProgram} is not in the AMM allowlist of the target relay build`)
  }
  const mustBeNonZero: [string, Address][] = [
    ['ammAuthority', swap.ammAuthority],
    ['ammConfig', swap.ammConfig],
    ['poolState', swap.poolState],
    ['inputVault', swap.inputVault],
    ['outputVault', swap.outputVault],
    ['observationState', swap.observationState],
    ['inMint', swap.inMint],
    ['outMint', swap.outMint],
    ['inAccount', swap.inAccount],
    ['outAccount', swap.outAccount],
  ]
  for (const [label, key] of mustBeNonZero) if (zero(key)) p.push(`${label} must be non-zero`)
  if (swap.inputVault === swap.outputVault) p.push('inputVault must differ from outputVault')
  if (swap.inMint === NATIVE_MINT || swap.inMint === NATIVE_MINT_2022)
    p.push('inMint must not be a native (wrapped SOL) mint (classic or Token-2022)')
  if (swap.inMint === swap.outMint) p.push('inMint must differ from outMint')
  if (!TOKEN_PROGRAMS.includes(swap.inTokenProgram))
    p.push('inTokenProgram must be Token or Token-2022')
  if (!TOKEN_PROGRAMS.includes(swap.outTokenProgram))
    p.push('outTokenProgram must be Token or Token-2022')
  if (swap.inAccount === config.sourceAccount) {
    if (swap.inMint !== config.budgetMint) {
      p.push('inAccount equals sourceAccount, so inMint must equal budgetMint')
    }
    if (swap.inTokenProgram !== config.tokenProgram) {
      p.push('inAccount equals sourceAccount, so inTokenProgram must equal tokenProgram')
    }
  }
  if (swap.outAccount === swap.inAccount) p.push('outAccount must differ from inAccount')
  if (swap.outAccount === config.sourceAccount) p.push('outAccount must differ from sourceAccount')
  if (typeof swap.floorOut !== 'bigint' || swap.floorOut <= 0n || swap.floorOut > U64_MAX) {
    p.push('floorOut must be a bigint in [1, 2^64-1]')
  }
  if (typeof swap.floorIn !== 'bigint' || swap.floorIn <= 0n || swap.floorIn > U64_MAX) {
    p.push('floorIn must be a bigint in [1, 2^64-1]')
  }
  if (
    !Number.isInteger(swap.maxDeadlineSlots) ||
    swap.maxDeadlineSlots < 1 ||
    swap.maxDeadlineSlots > MAX_DEADLINE_SLOTS_CAP
  ) {
    p.push(`maxDeadlineSlots must be an integer in [1, ${MAX_DEADLINE_SLOTS_CAP}]`)
  }
  return p
}

/** Throw a {@link ValidationError} (relay code 113) listing every problem, if any. */
export function assertValidRelayPolicyConfig(
  config: RelayPolicyConfig,
  ctx: PolicyContext = {},
  opts: PolicyConfigOptions = {},
): void {
  if (opts.skipValidation) return
  const problems = validateRelayPolicyConfig(config, ctx, opts)
  if (problems.length > 0) {
    throw new ValidationError('BAD_CONFIG', `invalid relay policy config: ${problems.join('; ')}`, {
      relayCode: 113,
    })
  }
}

/**
 * Serialise the 800-byte policy config region (RELAY-SPEC section 5.2 region B). These are exactly
 * bytes [2, 802) of the `init_policy` instruction data and bytes [144, 944) of the policy account.
 *
 * @throws ValidationError `BAD_CONFIG` (relayCode 113) when the config breaks an init rule and
 *   `opts.skipValidation` is not set.
 */
export function encodeRelayPolicyConfig(
  config: RelayPolicyConfig,
  opts: PolicyConfigOptions = {},
  ctx: PolicyContext = {},
): Uint8Array {
  assertValidRelayPolicyConfig(config, ctx, opts)
  if (config.recipients.length > MAX_RECIPIENTS) {
    throw new ValidationError('BAD_CONFIG', `at most ${MAX_RECIPIENTS} recipients`, {
      relayCode: 113,
    })
  }
  const out = new Uint8Array(POLICY_CONFIG_SIZE)
  const put = (offset: number, key: Address): void => out.set(addressToBytes(key), offset)
  put(0, config.tokenProgram)
  put(32, config.budgetMint)
  put(64, config.sourceAccount)
  out[96] = config.recipients.length
  out[97] = config.swap ? 1 : 0
  // out[98..104) reserved1 stays zero
  config.recipients.forEach((r, i) => put(104 + i * 32, r))
  const s = config.swap
  if (s) {
    put(360, s.ammProgram)
    put(392, s.ammAuthority)
    put(424, s.ammConfig)
    put(456, s.poolState)
    put(488, s.inputVault)
    put(520, s.outputVault)
    put(552, s.observationState)
    put(584, s.inMint)
    put(616, s.outMint)
    put(648, s.inTokenProgram)
    put(680, s.outTokenProgram)
    put(712, s.inAccount)
    put(744, s.outAccount)
    out.set(u64ToLe(s.floorOut, 'floorOut'), 776)
    out.set(u64ToLe(s.floorIn, 'floorIn'), 784)
    if (
      !Number.isInteger(s.maxDeadlineSlots) ||
      s.maxDeadlineSlots < 0 ||
      s.maxDeadlineSlots > 0xffff_ffff
    ) {
      throw new ValidationError('U32_RANGE', 'maxDeadlineSlots must be a u32')
    }
    new DataView(out.buffer).setUint32(792, s.maxDeadlineSlots, true)
  }
  return out
}

/**
 * Build the 802-byte `init_policy` instruction data: `[0] + flags + config[800]` (RELAY-SPEC 7.1).
 *
 * @param flags raw flags byte or booleans. Bits other than paused (bit 0) and strict top level
 *   (bit 1) are rejected.
 */
export function encodeInitPolicyData(
  flags: PolicyFlagsInput | number,
  config: RelayPolicyConfig,
  opts: PolicyConfigOptions = {},
  ctx: PolicyContext = {},
): Uint8Array {
  const flagsByte = encodePolicyFlags(flags)
  const body = encodeRelayPolicyConfig(config, opts, ctx)
  const out = new Uint8Array(INIT_POLICY_DATA_SIZE)
  out[0] = 0
  out[1] = flagsByte
  out.set(body, 2)
  return out
}
