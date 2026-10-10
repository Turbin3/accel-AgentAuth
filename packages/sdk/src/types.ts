import type {
  Address,
  GetAccountInfoApi,
  GetBlockHeightApi,
  GetBlockTimeApi,
  GetLatestBlockhashApi,
  GetMultipleAccountsApi,
  GetProgramAccountsApi,
  GetSignatureStatusesApi,
  GetTokenAccountsByOwnerApi,
  SendTransactionApi,
  SimulateTransactionApi,
  GetSlotApi,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  Rpc,
} from '@solana/kit'

/** Anything that can serve `getAccountInfo` (a Kit `createSolanaRpc()` result qualifies). */
export type AccountsRpc = Rpc<GetAccountInfoApi>
/** Anything that can serve `getMultipleAccounts`. */
export type MultipleAccountsRpc = Rpc<GetMultipleAccountsApi>
/** Anything that can serve `getProgramAccounts`. */
export type ProgramAccountsRpc = Rpc<GetProgramAccountsApi>
/** Anything that can serve the activity feed (`getSignaturesForAddress` + `getTransaction`). */
export type ActivityRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>
/** The full RPC surface the SDK uses. A plain `createSolanaRpc(url)` satisfies it. */
export type AgentAuthRpc = Rpc<
  GetAccountInfoApi &
    GetMultipleAccountsApi &
    GetProgramAccountsApi &
    GetSignaturesForAddressApi &
    GetTransactionApi &
    GetSlotApi &
    GetBlockTimeApi &
    GetBlockHeightApi &
    GetLatestBlockhashApi &
    GetSignatureStatusesApi &
    GetTokenAccountsByOwnerApi &
    SendTransactionApi &
    SimulateTransactionApi
>

/** One permission slot of a mandate, decoded. All amounts are raw base units (bigint). */
export interface Permission {
  /** Slot index inside the mandate (0..15). */
  readonly index: number
  /** Target program id the slot applies to. */
  readonly program: Address
  /** Lifetime cap in raw units; `0n` on chain means UNLIMITED (see `spendUnlimited`). */
  readonly spendLimit: bigint
  /** Per-`verify`-call cap in raw units; `0n` on chain means UNLIMITED (see `perTxUnlimited`). */
  readonly perTxLimit: bigint
  /** True when `spendLimit` is the unlimited sentinel (0). */
  readonly spendUnlimited: boolean
  /** True when `perTxLimit` is the unlimited sentinel (0). */
  readonly perTxUnlimited: boolean
  /** Lifetime amount booked by `verify` so far (unit-less per program: all mints share it). */
  readonly spendTotal: bigint
  /** Number of `verify` calls booked. */
  readonly callCount: number
  /** Allowed 8-byte discriminators (only the first `discriminators_len` of the 8 slots). */
  readonly discriminators: readonly Uint8Array[]
  /** Same as `discriminators`, lower-case hex. */
  readonly discriminatorsHex: readonly string[]
}

/** A decoded `AgentMandate` account (2136 bytes, core layout). */
export interface Mandate {
  /**
   * Account address. Always set by `fetchMandate`, `fetchMandatesByOwner`, `fetchMandatesByAgent`,
   * `decodeMandateAccount` and `client.inspect`; `undefined` only for a bare `decodeMandate(bytes)`
   * call that was not given the address.
   */
  readonly address: Address | undefined
  readonly owner: Address
  readonly agent: Address
  /** First unix second at which the mandate is invalid (expired iff now >= expiry). */
  readonly expiry: bigint
  /** True when the header byte is exactly 1; false means paused. */
  readonly active: boolean
  /** Layout version byte (1 for the hardened core; 0 for pre-hardening accounts). */
  readonly version: number
  /** Stored PDA bump. */
  readonly bump: number
  readonly permissions: readonly Permission[]
}

/** The swap half of a relay policy (config region, immutable after init). */
export interface SwapConfig {
  readonly ammProgram: Address
  readonly ammAuthority: Address
  readonly ammConfig: Address
  readonly poolState: Address
  readonly inputVault: Address
  readonly outputVault: Address
  readonly observationState: Address
  readonly inMint: Address
  readonly outMint: Address
  readonly inTokenProgram: Address
  readonly outTokenProgram: Address
  /** Owner's input token account. May equal the transfer `sourceAccount`. */
  readonly inAccount: Address
  /** Owner's output token account (the relay forces swap output here). */
  readonly outAccount: Address
  /** Floor price numerator: at least `floorOut` out per `floorIn` in (raw units). */
  readonly floorOut: bigint
  readonly floorIn: bigint
  /** Maximum number of slots a swap deadline may lie in the future (1..9000). */
  readonly maxDeadlineSlots: number
}

/** The immutable config region of a relay policy (bytes [144, 944)). */
export interface RelayPolicyConfig {
  readonly tokenProgram: Address
  readonly budgetMint: Address
  /** Owner's token account the relay may debit. Recipients are token accounts, not wallets. */
  readonly sourceAccount: Address
  /** Allowlisted destination token accounts (0..8). */
  readonly recipients: readonly Address[]
  /** Swap configuration, or `null` when swaps are disabled. */
  readonly swap: SwapConfig | null
}

/** A decoded `RelayPolicy` account (944 bytes). */
export interface RelayPolicy extends RelayPolicyConfig {
  readonly address: Address | undefined
  readonly version: number
  readonly policyBump: number
  readonly authorityBump: number
  /** Raw flags byte. */
  readonly flags: number
  /** Flag bit 0: the relay refuses every action. */
  readonly paused: boolean
  /** Flag bit 1: relay actions must be top-level instructions. */
  readonly strictTopLevel: boolean
  readonly mandate: Address
  readonly owner: Address
  readonly agent: Address
  /** The SPL delegate PDA `["authority", mandate]`. */
  readonly authority: Address
  /** Mandate expiry copied at init (stale-policy guard). */
  readonly mandateExpiry: bigint
}
