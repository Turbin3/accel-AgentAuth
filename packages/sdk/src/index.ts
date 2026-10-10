/**
 * @agentauth-sol/sdk: TypeScript SDK for AgentAuth, on-chain mandates for AI agents on Solana.
 *
 * Unaudited prototype (devnet). Honesty notes: `verify` is advisory unless an integrator gates an
 * action on it; only the relay's `transfer` and one pinned-pool `swap` are hard-enforced; `0` limits
 * mean UNLIMITED on chain (the builders refuse a bare `0n`); spend counters are per program and
 * unit-less.
 *
 * @packageDocumentation
 */

// A. constants
export {
  ACCOUNT_SIZE,
  AGENT_AUTH_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLUSTER_RPC_URLS,
  GATED_ACTION_DISC,
  GATED_EXAMPLE_PROGRAM_ID,
  HEADER_SIZE,
  INIT_POLICY_DATA_SIZE,
  MANDATE_DISCRIMINATOR,
  MANDATE_VERSION,
  MAX_DEADLINE_SLOTS_CAP,
  MAX_DISCRIMINATORS,
  MAX_PERMISSIONS,
  MAX_RECIPIENTS,
  MAX_TRANSACTION_SIZE,
  MOCK_AMM_PROGRAM_ID,
  NATIVE_MINT,
  NATIVE_MINT_2022,
  PERMISSION_SIZE,
  POLICY_CONFIG_OFFSET,
  POLICY_CONFIG_SIZE,
  POLICY_DISCRIMINATOR,
  POLICY_FLAG_PAUSED,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  POLICY_SIZE,
  POLICY_VERSION,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  ZERO_ADDRESS,
  isDeployedOn,
  programIds,
  type Cluster,
  type ProgramIds,
} from './constants'

// bytes helpers
export {
  bytesEqual,
  concatBytes,
  fromHex,
  toHex,
  u64ToLe,
  i64ToLe,
  readU64,
  readI64,
  U64_MAX,
} from './bytes'

// B. pda
export {
  associatedTokenAddress,
  mandatePda,
  relayAuthorityPda,
  relayPolicyPda,
  type PdaResult,
} from './pda'

// C. accounts
export {
  decodeMandate,
  decodeMandateAccount,
  decodeRelayPolicy,
  decodeRelayPolicyAccount,
  fetchMandate,
  fetchMandatesByAgent,
  fetchMandatesByOwner,
  fetchRawAccount,
  fetchRawAccounts,
  fetchRelayPolicy,
  isDustedEmpty,
  mandatesEqual,
  type DecodeMandateOptions,
  type FetchOptions,
  type ListOptions,
  type RawAccount,
} from './accounts'
export {
  DEFAULT_AMM_ALLOWLIST,
  defaultAmmAllowlist,
  assertValidRelayPolicyConfig,
  encodeInitPolicyData,
  encodePolicyFlags,
  encodeRelayPolicyConfig,
  validateRelayPolicyConfig,
  type PolicyConfigOptions,
  type PolicyContext,
  type PolicyFlagsInput,
} from './policy-config'
export type {
  AccountsRpc,
  ActivityRpc,
  AgentAuthRpc,
  Mandate,
  MultipleAccountsRpc,
  Permission,
  ProgramAccountsRpc,
  RelayPolicy,
  RelayPolicyConfig,
  SwapConfig,
} from './types'
export {
  checkMint,
  checkTokenAccountShape,
  decodeMint,
  decodeTokenAccount,
  type AccountCheck,
  type MintView,
  type TokenAccountView,
} from './token-state'

// D. core instruction builders
export {
  addPermissionIx,
  createMandateIx,
  removePermissionIx,
  revokeMandateIx,
  setActiveIx,
  updatePermissionIx,
  verifyIx,
  type AddPermissionParams,
  type CreateMandateParams,
  type PermissionInput,
  type RemovePermissionParams,
  type SetActiveParams,
  type UpdatePermissionParams,
  type VerifyParams,
} from './core-instructions'
export {
  parseDisc,
  parseDiscList,
  parseLimit,
  type AddressOrSigner,
  type BuiltInstruction,
  type DiscInput,
  type IxAccount,
  type LimitInput,
  type MandateRef,
} from './ix'

// E. relay + token builders
export {
  closePolicyIx,
  initPolicyIx,
  relaySwapIx,
  relayTransferIx,
  setPausedIx,
  type ClosePolicyParams,
  type InitPolicyParams,
  type RelaySwapParams,
  type RelayTransferParams,
  type SetPausedParams,
} from './relay-instructions'
export {
  approveIx,
  createAtaIdempotentIx,
  revokeDelegateIx,
  systemTransferIx,
  transferCheckedIx,
  type ApproveParams,
  type CreateAtaParams,
  type RevokeDelegateParams,
  type SystemTransferParams,
  type TransferCheckedParams,
} from './token-instructions'

// F. errors
export {
  AGENT_AUTH_ERRORS,
  AgentAuthError,
  MOCK_AMM_ERRORS,
  RELAY_ERRORS,
  SYSTEM_ERRORS,
  TOKEN_ERRORS,
  errorFromCode,
  lookupError,
  parseProgramError,
  type ErrorProgram,
  type ErrorSpec,
  type ParseProgramErrorOptions,
  type TableProgram,
} from './errors'
export {
  DecodeError,
  PlanRefusedError,
  SdkError,
  ValidationError,
  type SdkErrorCode,
} from './sdk-errors'

// G. pre-flight mirrors
export {
  checkRelaySwap,
  checkRelayTransfer,
  checkVerify,
  preflightFailureToError,
  type CheckVerifyOptions,
  type CheckVerifyResult,
  type PreflightFailure,
  type RelayCheckCommon,
  type RelaySwapCheckArgs,
  type RelaySwapOk,
  type RelaySwapResult,
  type RelaySwapTokenAccounts,
  type RelayTokenAccounts,
  type RelayTransferCheckArgs,
  type RelayTransferOk,
  type RelayTransferResult,
  type VerifyCall,
  type VerifyOk,
} from './preflight'

// H. units
export { formatUnits, parseLimitInput, parseUnits, type FormatUnitsOptions } from './units'

// H2. time
export {
  MAX_MANDATE_LIFETIME_SECONDS,
  MAX_SANE_EXPIRY,
  MILLISECOND_SUSPECT_THRESHOLD,
  checkExpiry,
  expiresIn,
  isoOfSeconds,
  parseDuration,
  parseExpiry,
  type ExpiryCheckOptions,
} from './time'

// I. explain + registry
export {
  explainMandate,
  dedupeWarnings,
  type DelegationInfo,
  type EnforcementLevel,
  type ExplainOptions,
  type Explanation,
  type LimitLine,
} from './explain'
export {
  DEFAULT_DENY_RISKS,
  builtinRegistry,
  describeInstruction,
  describeProgram,
  loadRegistry,
  type InstructionInfo,
  type RegistryInstructionLike,
  type RegistryLike,
  type RegistryProgramLike,
  type RiskClass,
} from './registry'

// J. plans
export {
  planClosePolicy,
  planOnboarding,
  planPause,
  planReinitPolicy,
  planResume,
  planRevokeDiscriminator,
  planRevokePermission,
  planUnwind,
  planUpdateLimits,
  type ChainState,
  type ClosePolicyInput,
  type DelegatedAccount,
  type OnboardingInput,
  type OnboardingSwap,
  type PauseInput,
  type PauseScope,
  type Plan,
  type PlanCommon,
  type PlanStep,
  type ReinitPolicyInput,
  type RevokeDiscriminatorInput,
  type RevokePermissionInput,
  type UnwindInput,
  type UpdateLimitsInput,
} from './plans'
export { estimateTransactionSize, fitsInOneTransaction, type SizeOptions } from './tx-size'

// J2. compute budget, transactions
export {
  COMPUTE_BUDGET_PROGRAM_ID,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
} from './compute-budget'
export {
  buildTransactionMessage,
  compileUnsigned,
  planToUnsignedTransactions,
  sendAndConfirmStep,
  simulateStep,
  stripSigners,
  type BlockhashLifetime,
  type BuildMessageOptions,
  type SendOptions,
  type SendResult,
  type SimulateOptions,
  type SimulationResult,
  type StepLike,
  type UnsignedPlanStep,
  type UnsignedTransaction,
} from './tx'

// J3. JSON
export {
  activityToJson,
  explanationToJson,
  mandateToJson,
  planToJson,
  policyToJson,
  toJsonSafe,
  type JsonValue,
} from './json'

// J4. capacity + seller
export { capacity, type Capacity, type CapacityLive, type LimitedBy } from './capacity'
export { assertMandateAuthorises, type AuthoriseInput, type AuthoriseResult } from './seller'

// K. activity
export {
  decodeRelayEvents,
  decodeTransaction,
  getActivity,
  getActivityPage,
  toDecodableTransaction,
  type ActivityItem,
  type ActivityPage,
  type ActivityKind,
  type DecodableTransaction,
  type DecodeContext,
  type GetActivityOptions,
  type LocatedRelayEvent,
  type RawInstruction,
  type RelayEvent,
  type RpcTransactionLike,
} from './activity'

// L. client
export {
  createClient,
  parseAddress,
  type Client,
  type ClientPlans,
  type CreateClientOptions,
  type FoundDelegation,
  type InspectOptions,
  type MandateView,
} from './client'

// Re-exported Kit types for convenience.
export type { Address, Instruction, TransactionSigner } from '@solana/kit'
