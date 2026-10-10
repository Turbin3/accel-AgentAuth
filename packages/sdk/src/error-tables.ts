/** One row of an error table. */
export interface ErrorSpec {
  readonly code: number
  readonly name: string
  readonly message: string
  readonly hint: string
  /** True only when the agent itself can fix it (smaller amount, fresh deadline); never when the owner must act. */
  readonly retryable: boolean
}

const e = (
  code: number,
  name: string,
  message: string,
  hint: string,
  retryable = false,
): ErrorSpec => ({ code, name, message, hint, retryable })

/**
 * AgentAuth core errors (codes 1..22). Names and codes are checked against idl/core-idl.json in the
 * test-suite. Codes 1..18 are locked; 19..22 were appended by the v0.2.0 hardening.
 */
export const AGENT_AUTH_ERRORS: readonly ErrorSpec[] = [
  e(
    1,
    'InvalidDiscriminator',
    'Unknown instruction tag.',
    'The first data byte is not a known AgentAuth instruction tag (0..6). Use the SDK builders.',
  ),
  e(
    2,
    'NotOwner',
    'The signer or owner account is not the mandate owner.',
    'Use the wallet that created the mandate (mandate.owner).',
  ),
  e(
    3,
    'AlreadyInitialized',
    'A mandate for this (owner, agent) pair already exists.',
    'Fetch it, or revoke it first. One mandate exists per (owner, agent).',
  ),
  e(
    4,
    'NotActive',
    'The mandate is paused.',
    'The owner can resume it with set_active(1) (planResume). Until then verify and every permission edit fail.',
  ),
  e(
    5,
    'Expired',
    'The mandate has expired (expired iff now >= expiry).',
    'Expiry cannot be extended. The owner must create a new mandate.',
  ),
  e(
    6,
    'ProgramNotAllowed',
    'The mandate has no permission slot for that program id.',
    'The owner can add one with add_permission. If a slot was just removed with remove_permission, this is the expected result.',
  ),
  e(
    7,
    'DiscriminatorNotAllowed',
    "The instruction discriminator is not in the permission slot's allow-list.",
    'The owner can re-add the slot with the discriminator included. An empty list allows nothing.',
  ),
  e(
    8,
    'PerTxExceeded',
    "The amount is larger than the permission's per-call limit.",
    'Retry with a smaller amount. The limit is per verify call, not per transaction.',
    true,
  ),
  e(
    9,
    'SpendLimitExceeded',
    "spend_total + amount would exceed the permission's lifetime limit.",
    'The lifetime budget is used up. The owner can raise it with update_permission (counters are kept).',
  ),
  e(
    10,
    'PermissionsFull',
    'All 16 permission slots are used.',
    'Remove a permission first, or use a second mandate.',
  ),
  e(
    11,
    'TooManyDiscriminators',
    'A permission can hold at most 8 discriminators.',
    'Split the permission across programs or narrow the list.',
  ),
  e(
    12,
    'PermissionNotFound',
    'No permission slot for that program id (remove_permission / update_permission).',
    'Check the program id against the mandate. A missing owner signature is reported as InvalidSigner (18) by the hardened core; the pre-hardening binary could surface it as 12.',
  ),
  e(13, 'ArithmeticOverflow', 'A checked addition overflowed.', 'Use smaller amounts.'),
  e(
    14,
    'AccountOwnerMismatch',
    'The mandate account is not owned by the AgentAuth program (or does not exist).',
    'The mandate is missing (revoked) or the wrong account was passed. Derive it with mandatePda(owner, agent).',
  ),
  e(
    15,
    'InvalidInstructionData',
    'Wrong data length, too few accounts, wrong account length, or a malformed value.',
    'Use the SDK builders; they validate lengths client-side.',
  ),
  e(
    16,
    'InvalidAccountType',
    'The account is not an AgentAuth mandate (discriminator or PDA mismatch).',
    'Pass the mandate PDA derived from (owner, agent).',
  ),
  e(
    17,
    'UnknownAgent',
    'The agent account is not the mandate agent.',
    'Sign with the agent key named in the mandate.',
  ),
  e(
    18,
    'InvalidSigner',
    'A required signature is missing (owner for edits, agent for verify).',
    'Add the missing signer to the transaction.',
  ),
  e(
    19,
    'InvalidAgent',
    'Owner and agent must be different keys.',
    'Give the agent its own keypair; an agent that equals the owner holds full authority.',
  ),
  e(
    20,
    'InvalidExpiry',
    'The expiry must be in the future.',
    'Pass a unix timestamp (seconds) greater than the current cluster time.',
  ),
  e(
    21,
    'DuplicatePermission',
    'A permission for this program already exists.',
    'Use update_permission to change limits, or remove_permission then add_permission (resets counters).',
  ),
  e(
    22,
    'EmptyDiscriminators',
    'At least one discriminator is required.',
    'Pass 1..8 discriminators. An empty list would allow nothing.',
  ),
]

/** Relay program errors (codes 100..119). Checked against idl/relay-idl.json. */
export const RELAY_ERRORS: readonly ErrorSpec[] = [
  e(
    100,
    'InvalidInstructionData',
    'Unknown or empty instruction tag, wrong data length, zero amount, or a bad paused byte.',
    'Use the SDK builders. Amounts must be greater than zero.',
  ),
  e(
    101,
    'InvalidPolicy',
    'The policy account is missing or malformed (owner program, length, discriminator, version or flags).',
    'No relay policy exists for this mandate (or it was closed). The owner must run init_policy; until then the relay fails closed.',
  ),
  e(
    102,
    'AccountMismatch',
    'A passed account differs from the key pinned in the policy (or a PDA / mandate binding), or set_paused / close_policy received the policy (or, for close_policy, the owner) read-only.',
    'Build relay instructions from the policy (relayTransferIx({ policy })) so every pinned account is filled in.',
  ),
  e(
    103,
    'WrongProgram',
    'A program id or account owner is not the expected one, or a mint is not an initialised extension-free mint.',
    'Check the AgentAuth/Token/AMM program ids and that the mint has no Token-2022 extensions.',
  ),
  e(
    104,
    'RecipientNotAllowed',
    'The destination token account is not on the policy allowlist (or equals the source).',
    'Only the allowlisted token accounts can be paid. The owner must close and re-init the policy to change them.',
  ),
  e(
    105,
    'TokenAccountState',
    'A token account has the wrong layout, mint, owner, delegate, state (frozen) or too little delegated amount or balance.',
    'Check the source still has the relay authority as delegate with enough delegated_amount (the owner may have revoked or exhausted it).',
  ),
  e(
    106,
    'BalanceDeltaViolation',
    'The balance change after the token CPI differs from the requested amount.',
    'The token program misbehaved or the mint is unsupported. The transaction was reverted.',
  ),
  e(107, 'AgentNotSigner', 'The agent did not sign.', 'Add the agent keypair as a signer.'),
  e(108, 'OwnerNotSigner', 'The owner did not sign.', 'Add the owner as a signer.'),
  e(
    109,
    'NotPolicyOwner',
    'The signer is not the owner recorded in the mandate / policy.',
    'Sign with mandate.owner.',
  ),
  e(
    110,
    'SwapDisabled',
    'This policy does not enable swaps.',
    'The owner must close and re-init the policy with a swap configuration.',
  ),
  e(
    111,
    'DeadlineExpired',
    'The swap deadline is in the past or further than max_deadline_slots ahead.',
    'Retry with deadline_slot = current slot + a small margin (at most max_deadline_slots).',
    true,
  ),
  e(
    112,
    'SlippageFloorViolated',
    'The pool delivered less than the policy floor price allows.',
    'The market moved against the floor. Retry later; the owner can re-init the policy with a new floor.',
    true,
  ),
  e(
    113,
    'InvalidConfig',
    'init_policy validation failed (config, flags, agent == owner, or a policy already exists).',
    'Check the config against the distinctness rules; close an existing policy first.',
  ),
  e(
    114,
    'ArithmeticOverflow',
    'Floor-price or balance-delta arithmetic overflowed.',
    'Use smaller amounts.',
  ),
  e(
    115,
    'NotTopLevel',
    'The policy requires top-level calls (STRICT_TOP_LEVEL) but this was a CPI.',
    'Send the relay instruction directly in the transaction, not through another program.',
  ),
  e(
    116,
    'Paused',
    'The relay policy is paused.',
    'The owner can resume it with set_paused(0) (planResume).',
  ),
  e(
    117,
    'InvalidMandate',
    'The mandate is not a live AgentAuth mandate for this owner and agent (also: revoked).',
    'The mandate was revoked or never created. The owner must create a new mandate.',
  ),
  e(
    118,
    'StalePolicy',
    "The policy's mandate_expiry differs from the live mandate's expiry.",
    'The policy belongs to an earlier mandate generation. The owner must close it and init a fresh one.',
  ),
  e(
    119,
    'AccountInvariantViolated',
    'A callee changed the owner program, length, owner field, close authority or delegate of an owner-side account.',
    'The pinned AMM misbehaved. The transaction was reverted; the owner should unwind.',
  ),
]

/** SPL Token program errors (TokenError, codes 0..19). Token-2022 shares the first 20 codes. */
export const TOKEN_ERRORS: readonly ErrorSpec[] = [
  e(
    0,
    'NotRentExempt',
    'Lamport balance below rent-exempt threshold.',
    'Fund the account to rent exemption.',
  ),
  e(
    1,
    'InsufficientFunds',
    'The source token account has too few tokens.',
    'Fund the source account or send a smaller amount.',
  ),
  e(2, 'InvalidMint', 'Invalid mint.', 'Check the mint address.'),
  e(
    3,
    'MintMismatch',
    'Account not associated with this mint.',
    'Use token accounts of the right mint.',
  ),
  e(
    4,
    'OwnerMismatch',
    'The authority is not the token account owner or delegate.',
    'Only the account owner (or its delegate, within delegated_amount) can move tokens. This is the expected result when an agent key tries to spend directly.',
  ),
  e(5, 'FixedSupply', 'Fixed supply.', 'The mint has no mint authority.'),
  e(6, 'AlreadyInUse', 'The account is already in use.', 'Pick a fresh account.'),
  e(
    7,
    'InvalidNumberOfProvidedSigners',
    'Invalid number of provided signers.',
    'Check the multisig signer count.',
  ),
  e(
    8,
    'InvalidNumberOfRequiredSigners',
    'Invalid number of required signers.',
    'Check the multisig threshold.',
  ),
  e(
    9,
    'UninitializedState',
    'The account is not initialised.',
    'Create / initialise the token account first.',
  ),
  e(
    10,
    'NativeNotSupported',
    'Instruction does not support native tokens.',
    'Use a non-native mint.',
  ),
  e(
    11,
    'NonNativeHasBalance',
    'A non-native account can only be closed if its balance is zero.',
    'Empty the account first.',
  ),
  e(12, 'InvalidInstruction', 'Invalid instruction.', 'Use the SDK builders.'),
  e(
    13,
    'InvalidState',
    'The account state is invalid for this instruction.',
    'Check the token account state.',
  ),
  e(14, 'Overflow', 'Operation overflowed.', 'Use smaller amounts.'),
  e(
    15,
    'AuthorityTypeNotSupported',
    'Account does not support this authority type.',
    'Check the authority type.',
  ),
  e(
    16,
    'MintCannotFreeze',
    'The mint cannot freeze accounts.',
    'The mint has no freeze authority.',
  ),
  e(
    17,
    'AccountFrozen',
    'The token account is frozen.',
    'Only the mint freeze authority can thaw it.',
  ),
  e(
    18,
    'MintDecimalsMismatch',
    'The provided decimals do not match the mint.',
    'Read the mint and pass its decimals.',
  ),
  e(
    19,
    'NonNativeNotSupported',
    'Instruction does not support non-native tokens.',
    'Use the native mint.',
  ),
]

/** System program errors (SystemError, codes 0..8). */
export const SYSTEM_ERRORS: readonly ErrorSpec[] = [
  e(
    0,
    'AccountAlreadyInUse',
    'An account with the same address already exists.',
    'Use a fresh address.',
  ),
  e(1, 'ResultWithNegativeLamports', 'The account does not have enough SOL.', 'Fund the payer.'),
  e(
    2,
    'InvalidProgramId',
    'Cannot assign the account to this program id.',
    'Check the program id.',
  ),
  e(
    3,
    'InvalidAccountDataLength',
    'Cannot allocate account data of this length.',
    'Check the requested size.',
  ),
  e(4, 'MaxSeedLengthExceeded', 'Length of requested seed is too long.', 'Shorten the seed.'),
  e(
    5,
    'AddressWithSeedMismatch',
    'Provided address does not match the derived address.',
    'Re-derive the address.',
  ),
  e(
    6,
    'NonceNoRecentBlockhashes',
    'Advancing the nonce requires recent blockhashes.',
    'Retry later.',
  ),
  e(
    7,
    'NonceBlockhashNotExpired',
    'Stored nonce is still in recent_blockhashes.',
    'Wait for the next slot.',
  ),
  e(
    8,
    'NonceUnexpectedBlockhashValue',
    'Specified nonce does not match the stored one.',
    'Fetch the current nonce.',
  ),
]

/** Mock AMM errors (test/demo program, codes 7001..7005). */
export const MOCK_AMM_ERRORS: readonly ErrorSpec[] = [
  e(
    7001,
    'ExceededSlippage',
    'The mock AMM output is below the minimum.',
    'Lower the minimum or retry.',
    true,
  ),
  e(7002, 'InvalidPool', 'Invalid pool.', 'Check the pool account.'),
  e(7003, 'InvalidVault', 'Invalid vault.', 'Check the pool vaults.'),
  e(7004, 'ZeroAmount', 'Zero amount.', 'Use an amount greater than zero.'),
  e(7005, 'InvalidInstruction', 'Invalid instruction.', 'Use the SDK builders.'),
]

/** Program families an error can be attributed to. */
export type ErrorProgram =
  'agent_auth' | 'relay' | 'token' | 'system' | 'mock_amm' | 'runtime' | 'unknown'

/** The programs that own an error table (everything except `runtime` and `unknown`). */
export type TableProgram = Exclude<ErrorProgram, 'runtime' | 'unknown'>

const TABLES: Readonly<Record<TableProgram, readonly ErrorSpec[]>> = {
  agent_auth: AGENT_AUTH_ERRORS,
  relay: RELAY_ERRORS,
  token: TOKEN_ERRORS,
  system: SYSTEM_ERRORS,
  mock_amm: MOCK_AMM_ERRORS,
}

/** Look up an error row. Returns undefined for unknown codes or the `unknown` program. */
export function lookupError(program: ErrorProgram, code: number): ErrorSpec | undefined {
  if (program === 'unknown' || program === 'runtime') return undefined
  return TABLES[program].find((row) => row.code === code)
}

/** Every known (program, row) pair that uses `code`. Used to describe ambiguity when no logs exist. */
export function candidatesForCode(
  code: number,
): readonly { program: TableProgram; spec: ErrorSpec }[] {
  const out: { program: TableProgram; spec: ErrorSpec }[] = []
  for (const program of Object.keys(TABLES) as TableProgram[]) {
    const spec = lookupError(program, code)
    if (spec) out.push({ program, spec })
  }
  return out
}
