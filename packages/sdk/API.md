# @agentauth-sol/sdk: API reference (v0.2.0, FROZEN)

Status: **frozen for the hackathon build.** Downstream packages (CLI, MCP server, dashboard, demo, seller examples) code against exactly this document. Everything listed here is exported from the package root `@agentauth-sol/sdk`; nothing else is public. Additions are allowed (minor versions); signatures and semantics below are not changed without a major version.

> **Honesty.** AgentAuth is an unaudited devnet prototype. `verify` is advisory unless a program gates an action on it. Only the relay's `transfer` (SPL `TransferChecked`) and the single pinned-pool `swap` are hard-enforced, and only while the owner's SPL delegation is in place. The SDK helpers that say "can"/"cannot" read chain state at one moment; they are not guarantees.

## Conventions

- **Runtime**: ESM package (also loadable with `require()` on Node 22.12+ through the `default` export condition), tree-shakeable, browser-safe: no Node built-ins, no storage, no `console`, no network except the RPC you pass. Peer dependency: `@solana/kit` ^8.4.0.
- **Keys**: the SDK never creates, stores or logs keys. Where a function needs a signer it takes a Kit `TransactionSigner` (a bare `Address` builds an unsigned instruction). Plans built with signer objects embed them in instruction metas: call `stripSigners(plan)` before logging or serializing, or build with addresses only.
- **Numbers**: amounts, limits, counters and slots are `bigint` raw base units. **Time is unix SECONDS** (`bigint`). `expiry` values above 1e11 are refused as probable milliseconds. Use `expiresIn('7d')` / `parseExpiry`. Limits: a positive `bigint` or the string `'unlimited'`; a bare `0n` is refused (`ZERO_LIMIT_AMBIGUOUS`) because 0 means UNLIMITED on chain.
- **Addresses**: Kit `Address` (branded base58 string). `parseAddress(string)` validates.
- **Instructions**: every builder returns a `BuiltInstruction` (`{ programAddress, accounts: [{ address, role, signer? }], data: Uint8Array }`), directly usable by Kit. Builders that derive a PDA are `async`; the rest are sync.
- **Plans**: `plan*` functions return an UNSIGNED `Plan { steps, warnings, summary }`. Each `PlanStep` has `instructions`, `signers`, `estimatedSizeBytes` (exact legacy size), `worstCaseSizeBytes` (v0 + compute budget), `fitsInOneTx`, `dependsOn` (indexes of steps that must be CONFIRMED first) and `awaitConfirmation`. Plans are refused (`PlanRefusedError` with every `reasons[]`) rather than silently weakened.
- **Errors**: client-side failures throw `SdkError` subclasses with a stable `code` (`ValidationError`, `DecodeError`, `PlanRefusedError`). On-chain failures become `AgentAuthError { program, code, name, message, hint, retryable, programId?, logs }` through `parseProgramError`; `program` is `agent_auth | relay | token | system | mock_amm | runtime | unknown` and is attributed by the ORIGIN frame in the logs (a wrapper never overrides a foreign program that raised the code).
- **Reads**: fetchers return `null` for a missing account, **including a system-owned empty account** (a PDA address pre-funded with lamports counts as "not created"). They throw `DecodeError` only for an existing account that is not valid for the program. `createClient` reads at `confirmed` unless you pass `commitment`.
- **JSON**: `bigint` becomes a decimal string, `Uint8Array` becomes lower-case hex, errors become `{ name, message, program, code, hint, retryable }`, signer objects are dropped. Use `toJsonSafe` (or the `*ToJson` helpers) for any CLI `--json`, MCP tool result or server-component boundary.
- **Cluster**: AgentAuth and the relay are deployed on devnet only. `createClient({ cluster: 'mainnet-beta' })` throws `NOT_DEPLOYED` unless you override the program ids or pass `acknowledgeNoMainnet: true`.

## Contents

- [Constants, program ids and layout sizes](#constants-program-ids-and-layout-sizes)
- [Byte helpers](#byte-helpers)
- [PDA derivation](#pda-derivation)
- [Accounts: decode, fetch, list; token-account state](#accounts-decode-fetch-list-token-account-state)
- [Core instruction builders (AgentAuth)](#core-instruction-builders-agentauth)
- [Relay and token instruction builders](#relay-and-token-instruction-builders)
- [Errors](#errors)
- [Pre-flight mirrors (offline checks of what the programs would decide)](#pre-flight-mirrors-offline-checks-of-what-the-programs-would-decide)
- [Units](#units)
- [Time and expiry](#time-and-expiry)
- [Explain and registry](#explain-and-registry)
- [Plans (unsigned, owner-signed transaction sets)](#plans-unsigned-owner-signed-transaction-sets)
- [Compute budget and transactions](#compute-budget-and-transactions)
- [JSON serialization](#json-serialization)
- [Capacity and seller-side checks](#capacity-and-seller-side-checks)
- [Activity feed](#activity-feed)
- [Client](#client)
- [Re-exported Kit types](#re-exported-kit-types)
- [Consumer recipes](#consumer-recipes)
- [What the SDK does not do](#what-the-sdk-does-not-do)

## How examples are verified

Every example below is real TypeScript. The ten recipes are in `packages/sdk/test/recipes.ts` and the one-line examples in `packages/sdk/test/api-examples.ts`; `tsc --noEmit` checks both on every `pnpm typecheck`, and `test/recipes.test.ts` fails if this document drifts from them. The one-line examples share this context (declared, not executed):

```ts
declare const owner: TransactionSigner // the human's wallet
declare const agent: TransactionSigner // the agent's key
declare const rpc: AgentAuthRpc
declare const mandateAddress: Address
declare const mandate: Mandate
declare const policy: RelayPolicy
declare const plan: Plan
declare const mint: Address
declare const source: Address
declare const destination: Address
declare const blockhash: { blockhash: string; lastValidBlockHeight: bigint }
declare const accountBytes: Uint8Array
declare const tx: RpcTransactionLike
declare const signature: string
declare const logs: string[]
declare const ixData: RawInstruction
const client = createClient({ cluster: 'devnet' })
```

## Constants, program ids and layout sizes

#### `ACCOUNT_SIZE`

```ts
export const ACCOUNT_SIZE = 2136
```

Core mandate account size in bytes (locked layout).

#### `AGENT_AUTH_PROGRAM_ID`

```ts
export const AGENT_AUTH_PROGRAM_ID: Address
```

AgentAuth core program (devnet deployment). Source: idl/core-idl.json `addresses.devnet`.

#### `ASSOCIATED_TOKEN_PROGRAM_ID`

```ts
export const ASSOCIATED_TOKEN_PROGRAM_ID: Address
```

Associated Token Account program.

#### `CLUSTER_RPC_URLS`

```ts
export const CLUSTER_RPC_URLS: Readonly<Record<Cluster, string>>
```

Public RPC endpoint presets (rate limited; use your own provider for anything serious).

#### `GATED_ACTION_DISC`

```ts
export const GATED_ACTION_DISC = '0100000000000000'
```

`disc8` of the `gated-example` program's `gated_action` instruction.

#### `GATED_EXAMPLE_PROGRAM_ID`

```ts
export const GATED_EXAMPLE_PROGRAM_ID: Address
```

`gated-example`, the second (non-relay) integrator of `verify` (test/demo only).

#### `HEADER_SIZE`

```ts
export const HEADER_SIZE = 88
```

Mandate header size; permission slots start here.

#### `INIT_POLICY_DATA_SIZE`

```ts
export const INIT_POLICY_DATA_SIZE = 802
```

Total `init_policy` instruction data length (tag + flags + config).

#### `MANDATE_DISCRIMINATOR`

```ts
export const MANDATE_DISCRIMINATOR = 1
```

First byte of every initialised mandate.

#### `MANDATE_VERSION`

```ts
export const MANDATE_VERSION = 1
```

Mandate layout version written by the hardened core (header byte 79).

#### `MAX_DEADLINE_SLOTS_CAP`

```ts
export const MAX_DEADLINE_SLOTS_CAP = 9000
```

Upper bound of `max_deadline_slots`.

#### `MAX_DISCRIMINATORS`

```ts
export const MAX_DISCRIMINATORS = 8
```

Maximum discriminators per permission slot.

#### `MAX_PERMISSIONS`

```ts
export const MAX_PERMISSIONS = 16
```

Maximum permission slots per mandate.

#### `MAX_RECIPIENTS`

```ts
export const MAX_RECIPIENTS = 8
```

Maximum allowlisted recipient token accounts per policy.

#### `MAX_TRANSACTION_SIZE`

```ts
export const MAX_TRANSACTION_SIZE = 1232
```

Maximum serialized transaction size accepted by the cluster.

#### `MOCK_AMM_PROGRAM_ID`

```ts
export const MOCK_AMM_PROGRAM_ID: Address
```

Raydium-CPMM-shaped mock AMM (test/demo only; never allowlisted on a mainnet relay build).

#### `NATIVE_MINT`

```ts
export const NATIVE_MINT: Address
```

Wrapped SOL mint. The relay rejects it as budget mint / input mint.

#### `NATIVE_MINT_2022`

```ts
export const NATIVE_MINT_2022: Address
```

Token-2022's native (wrapped SOL) mint. The relay rejects it as budget mint / input mint too (error 113); `validateRelayPolicyConfig` refuses both native mints.

#### `PERMISSION_SIZE`

```ts
export const PERMISSION_SIZE = 128
```

Size of one permission slot.

#### `POLICY_CONFIG_OFFSET`

```ts
export const POLICY_CONFIG_OFFSET = 144
```

Offset of the immutable config region inside the policy account.

#### `POLICY_CONFIG_SIZE`

```ts
export const POLICY_CONFIG_SIZE = 800
```

Length of the config region (also bytes [2..802) of `init_policy` data).

#### `POLICY_DISCRIMINATOR`

```ts
export const POLICY_DISCRIMINATOR = 0xa7
```

First byte of every RelayPolicy.

#### `POLICY_FLAG_PAUSED`

```ts
export const POLICY_FLAG_PAUSED = 0x01
```

Policy flag bit 0: the relay refuses every action (reversible kill switch).

#### `POLICY_FLAG_STRICT_TOP_LEVEL`

```ts
export const POLICY_FLAG_STRICT_TOP_LEVEL = 0x02
```

Policy flag bit 1: relay actions must be top-level instructions (stack height 1).

#### `POLICY_SIZE`

```ts
export const POLICY_SIZE = 944
```

RelayPolicy account size in bytes.

#### `POLICY_VERSION`

```ts
export const POLICY_VERSION = 1
```

RelayPolicy layout version.

#### `RAYDIUM_CPMM_DEVNET_PROGRAM_ID`

```ts
export const RAYDIUM_CPMM_DEVNET_PROGRAM_ID: Address
```

Raydium CP-Swap, devnet.

#### `RAYDIUM_CPMM_MAINNET_PROGRAM_ID`

```ts
export const RAYDIUM_CPMM_MAINNET_PROGRAM_ID: Address
```

Raydium CP-Swap, mainnet-beta.

#### `RELAY_PROGRAM_ID`

```ts
export const RELAY_PROGRAM_ID: Address
```

AgentAuth Relay program (throwaway test/devnet key). Source: idl/relay-idl.json.

#### `SWAP_BASE_INPUT_DISC`

```ts
export const SWAP_BASE_INPUT_DISC = '8fbe5adac41e33de'
```

`disc8` of Raydium CP-Swap `swap_base_input` = sha256("global:swap_base_input")[0..8].

#### `SYSTEM_PROGRAM_ID`

```ts
export const SYSTEM_PROGRAM_ID: Address
```

System program.

#### `TOKEN_2022_PROGRAM_ID`

```ts
export const TOKEN_2022_PROGRAM_ID: Address
```

SPL Token-2022.

#### `TOKEN_PROGRAM_ID`

```ts
export const TOKEN_PROGRAM_ID: Address
```

SPL Token (classic; p-token shares this id).

#### `TRANSFER_CHECKED_DISC`

```ts
export const TRANSFER_CHECKED_DISC = '0c00000000000000'
```

`disc8` reported to `verify` for SPL `TransferChecked`: the SPL tag byte (12) zero padded.
SPL instructions have no 8-byte discriminator; this is the documented AgentAuth convention.

#### `ZERO_ADDRESS`

```ts
export const ZERO_ADDRESS: Address
```

The all-zero address (System program id). Used by the relay for "unset" config slots.

#### `isDeployedOn`

```ts
export function isDeployedOn(cluster: Cluster): boolean
```

True when AgentAuth + relay are deployed on the cluster (devnet only, to the best of our knowledge).

Throws: nothing.

Example:

```ts
isDeployedOn('mainnet-beta') // false: devnet prototype
```

#### `programIds`

```ts
export function programIds(cluster: Cluster, overrides: Partial<ProgramIds> = {}): ProgramIds
```

Program ids for a cluster, optionally overridden (localnet, tests, forks).

The same AgentAuth/relay ids are returned for every cluster, but only devnet has a deployment
(as of 2026-10-10): there is NO mainnet-beta deployment. Overrides are per call; nothing global
is mutated.

Throws: nothing.

Example:

```ts
const ids = programIds('localnet', { relay: address('...') })
```

### Types in this group

<details><summary><code>Cluster</code> - Supported clusters.</summary>

```ts
export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta'
```
</details>

<details><summary><code>ProgramIds</code> - Program ids the SDK talks to for one cluster.</summary>

```ts
export interface ProgramIds {
  readonly agentAuth: Address
  readonly relay: Address
  readonly mockAmm: Address
  readonly gatedExample: Address
  readonly token: Address
  readonly token2022: Address
  readonly system: Address
  readonly associatedToken: Address
  /** Raydium CP-Swap for this cluster (devnet id on localnet). */
  readonly raydiumCpmm: Address
}
```
</details>

## Byte helpers

#### `bytesEqual`

```ts
export function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean
```

Constant-shape equality of two byte arrays.

Throws: nothing.

Example:

```ts
bytesEqual(new Uint8Array([1]), new Uint8Array([1])) // true
```

#### `concatBytes`

```ts
export function concatBytes(...parts: readonly ReadonlyUint8Array[]): Uint8Array
```

Concatenate byte arrays into a new array.

Throws: nothing.

Example:

```ts
concatBytes(new Uint8Array([3]), u64ToLe(5n))
```

#### `fromHex`

```ts
export function fromHex(hex: string, expectedLength?: number): Uint8Array
```

Strict hex parser: optional `0x` prefix, even length, hex digits only.

Parameters:
- `expectedLength` when given, the decoded length must match exactly.

Throws: `ValidationError` `BAD_HEX`

Example:

```ts
fromHex('0c00000000000000', 8)
```

#### `toHex`

```ts
export function toHex(bytes: ReadonlyUint8Array): string
```

Lower-case hex of a byte array.

Throws: nothing.

Example:

```ts
toHex(new Uint8Array([12, 0])) // "0c00"
```

#### `u64ToLe`

```ts
export function u64ToLe(value: bigint, field = 'value'): Uint8Array
```

Encode a u64 little-endian. @throws ValidationError `U64_RANGE`

Throws: `ValidationError` `U64_RANGE`.

Example:

```ts
u64ToLe(1_000_000n) // 8 bytes, little endian
```

#### `i64ToLe`

```ts
export function i64ToLe(value: bigint, field = 'value'): Uint8Array
```

Encode an i64 little-endian. @throws ValidationError `I64_RANGE`

Throws: `ValidationError` `I64_RANGE`.

Example:

```ts
i64ToLe(1_800_000_000n)
```

#### `readU64`

```ts
export function readU64(bytes: ReadonlyUint8Array, offset: number): bigint
```

Read a little-endian u64 as bigint.

Throws: `RangeError` when `offset + 8` is past the end of `bytes`.

Example:

```ts
readU64(accountBytes, 64)
```

#### `readI64`

```ts
export function readI64(bytes: ReadonlyUint8Array, offset: number): bigint
```

Read a little-endian i64 as bigint.

Throws: `RangeError` when `offset + 8` is past the end of `bytes`.

Example:

```ts
readI64(accountBytes, 65)
```

#### `U64_MAX`

```ts
export const U64_MAX = (1n << 64n) - 1n
```

Largest u64.

## PDA derivation

#### `associatedTokenAddress`

```ts
export async function associatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ID, associatedTokenProgram: Address = ASSOCIATED_TOKEN_PROGRAM_ID): Promise<PdaResult>
```

Associated token account address: seeds `[owner, tokenProgram, mint]` under the ATA program.
Works for Token and Token-2022 (pass the matching `tokenProgram`).

Throws: nothing for valid addresses (Kit throws on a malformed address string).

Example:

```ts
const ata = await associatedTokenAddress(owner.address, mint, TOKEN_PROGRAM_ID)
void [ata.address, ASSOCIATED_TOKEN_PROGRAM_ID]
```

#### `mandatePda`

```ts
export function mandatePda(owner: Address, agent: Address, programId: Address = AGENT_AUTH_PROGRAM_ID): Promise<PdaResult>
```

The mandate PDA: seeds `["mandate", owner, agent]` under the AgentAuth program.

Parameters:
- `programId` override for localnet / tests.

Throws: nothing for valid addresses.

Example:

```ts
const { address: mandateAddr, bump } = await mandatePda(owner.address, agent.address)
```

#### `relayAuthorityPda`

```ts
export function relayAuthorityPda(mandate: Address, programId: Address = RELAY_PROGRAM_ID): Promise<PdaResult>
```

The relay authority PDA: seeds `["authority", mandate]` under the relay program.
It is the SPL delegate. No account exists at this address; it only signs inside the relay.

Parameters:
- `programId` override for localnet / tests.

Throws: nothing for valid addresses.

Example:

```ts
const { address: authority } = await relayAuthorityPda(mandateAddress) // the SPL delegate
```

#### `relayPolicyPda`

```ts
export function relayPolicyPda(mandate: Address, programId: Address = RELAY_PROGRAM_ID): Promise<PdaResult>
```

The relay policy PDA: seeds `["policy", mandate]` under the relay program.

Parameters:
- `programId` override for localnet / tests.

Throws: nothing for valid addresses.

Example:

```ts
const { address: policyAddress } = await relayPolicyPda(mandateAddress)
```

### Types in this group

<details><summary><code>PdaResult</code> - A derived address and its bump seed.</summary>

```ts
export interface PdaResult {
  readonly address: Address
  readonly bump: number
}
```
</details>

## Accounts: decode, fetch, list; token-account state

#### `decodeMandate`

```ts
export function decodeMandate(bytes: ReadonlyUint8Array, address?: Address, opts: DecodeMandateOptions = {}): Mandate
```

Decode a 2136-byte `AgentMandate` account.

Strict: the length, discriminator, version, permission count and every slot's discriminator
count are validated; nothing is trusted. `active` mirrors the program (`byte == 1`).

Parameters:
- `bytes` raw account data
- `address` the account address, copied into the result when given

Throws: `DecodeError` `MANDATE_BAD_LENGTH | MANDATE_BAD_DISCRIMINATOR | MANDATE_UNSUPPORTED_VERSION | MANDATE_BAD_PERMISSION_COUNT | MANDATE_BAD_PERMISSION`

Example:

```ts
const decoded = decodeMandate(accountBytes, mandateAddress) // throws DecodeError on bad bytes
```

#### `decodeMandateAccount`

```ts
export async function decodeMandateAccount(account: RawAccount, opts: FetchOptions = {}): Promise<Mandate>
```

Decode a mandate from a `RawAccount`, checking the owner program and (by default) that the
address really is the PDA of its (owner, agent). A forged account that merely *looks* like a
mandate is rejected.

Throws: `DecodeError` `WRONG_OWNER_PROGRAM | ADDRESS_MISMATCH` plus every `decodeMandate` code.

Example:

```ts
const raw = await fetchRawAccount(rpc, mandateAddress)
const m = raw && (await decodeMandateAccount(raw)) // also checks owner program and PDA address
```

#### `decodeRelayPolicy`

```ts
export function decodeRelayPolicy(bytes: ReadonlyUint8Array, address?: Address): RelayPolicy
```

Decode a 944-byte `RelayPolicy` account (RELAY-SPEC section 5.2).

Strict: length, discriminator `0xA7`, version, reserved flag bits, `recipients_len <= 8`,
`swap_enabled in {0,1}`, canonical zero padding and (when swap is enabled) a sane deadline cap.

Throws: `DecodeError` `POLICY_BAD_LENGTH | POLICY_BAD_DISCRIMINATOR | POLICY_UNSUPPORTED_VERSION | POLICY_BAD_FLAGS | POLICY_BAD_CONFIG`

Example:

```ts
const p = decodeRelayPolicy(accountBytes, policyAddress)
```

#### `decodeRelayPolicyAccount`

```ts
export async function decodeRelayPolicyAccount(account: RawAccount, opts: FetchOptions = {}): Promise<RelayPolicy>
```

Decode a relay policy from a `RawAccount`, checking the owner program and that the address
and authority are the PDAs of the mandate recorded inside.

Throws: `DecodeError` `WRONG_OWNER_PROGRAM | ADDRESS_MISMATCH` plus every `decodeRelayPolicy` code.

Example:

```ts
const rawPolicy = await fetchRawAccount(rpc, policyAddress)
const pol = rawPolicy && (await decodeRelayPolicyAccount(rawPolicy))
```

#### `fetchMandate`

```ts
export async function fetchMandate(rpc: AccountsRpc, address: Address, opts: FetchOptions = {}): Promise<Mandate | null>
```

Fetch and decode a mandate. `null` when the account does not exist (never created, or revoked).

Throws: `DecodeError` when the account exists but is not a valid mandate for this program.

Example:

```ts
const found = await fetchMandate(rpc, mandateAddress, { commitment: 'confirmed' }) // null if missing
```

#### `fetchMandatesByAgent`

```ts
export function fetchMandatesByAgent(rpc: ProgramAccountsRpc, agent: Address, opts: ListOptions = {}): Promise<Mandate[]>
```

All mandates naming an agent (`getProgramAccounts` with `dataSize 2136` and `memcmp` at offset 33).
Undecodable accounts are skipped (see `onSkip`).

Throws: RPC errors (Kit `SolanaError`) propagate. Undecodable program accounts are skipped (see `onSkip`).

Example:

```ts
const naming = await fetchMandatesByAgent(rpc, agent.address, { owners: [owner.address] })
```

#### `fetchMandatesByOwner`

```ts
export function fetchMandatesByOwner(rpc: ProgramAccountsRpc, owner: Address, opts: ListOptions = {}): Promise<Mandate[]>
```

All mandates of an owner (`getProgramAccounts` with `dataSize 2136` and `memcmp` at offset 1).
Undecodable accounts are skipped (see `onSkip`).

Throws: RPC errors (Kit `SolanaError`) propagate. Undecodable program accounts are skipped (see `onSkip`).

Example:

```ts
const mine = await fetchMandatesByOwner(rpc, owner.address, { limit: 50 })
```

#### `fetchRawAccount`

```ts
export async function fetchRawAccount(rpc: AccountsRpc, address: Address, opts: Pick<FetchOptions, 'commitment' | 'abortSignal'> = {}): Promise<RawAccount | null>
```

Fetch one raw account (base64). Returns `null` when it does not exist.

Throws: RPC errors (Kit `SolanaError`) propagate.

Example:

```ts
const account = await fetchRawAccount(rpc, source) // { ownerProgram, data, lamports, ... } | null
```

#### `fetchRawAccounts`

```ts
export async function fetchRawAccounts(rpc: MultipleAccountsRpc, addresses: readonly Address[], opts: Pick<FetchOptions, 'commitment' | 'abortSignal'> = {}): Promise<(RawAccount | null)[]>
```

Fetch many raw accounts in one RPC (`getMultipleAccounts`, base64). Results are in input order;
`null` = does not exist. At most 100 addresses per call (the RPC limit); larger inputs are chunked.

Throws: RPC errors (Kit `SolanaError`) propagate.

Example:

```ts
const [a, b] = await fetchRawAccounts(rpc, [source, destination]) // one RPC
```

#### `fetchRelayPolicy`

```ts
export async function fetchRelayPolicy(rpc: AccountsRpc, address: Address, opts: FetchOptions = {}): Promise<RelayPolicy | null>
```

Fetch and decode a relay policy. `null` when the account does not exist.

Throws: `DecodeError` when the account exists but is not a valid policy of this relay.

Example:

```ts
const foundPolicy = await fetchRelayPolicy(rpc, policyAddress)
```

#### `isDustedEmpty`

```ts
export function isDustedEmpty(raw: RawAccount): boolean
```

True for a system-owned, zero-data account: a PDA address that anyone can pre-fund with lamports
(griefing). Such an account is "not created" as far as AgentAuth and the relay are concerned (both
programs handle pre-funded PDAs), so the fetchers report it as missing instead of throwing.

Throws: nothing.

Example:

```ts
const dusted = account !== null && isDustedEmpty(account) // pre-funded, never created
```

#### `mandatesEqual`

```ts
export function mandatesEqual(a: Mandate, b: Mandate): boolean
```

Structural equality of two mandates' state (for tests and change detection).

Throws: nothing.

Example:

```ts
mandatesEqual(mandate, mandate) // true
```

#### `DEFAULT_AMM_ALLOWLIST`

```ts
export const DEFAULT_AMM_ALLOWLIST: readonly Address[]
```

The default AMM allowlist used for client-side validation.

#### `defaultAmmAllowlist`

```ts
export function defaultAmmAllowlist(cluster: Cluster): readonly Address[]
```

The AMM allowlist matching one relay build: devnet CPMM on devnet, mainnet CPMM on mainnet-beta,
and additionally the mock AMM on localnet. Pass it as `validation: { ammAllowlist }` so client
validation matches the deployed relay (the default accepts all three).

Throws: nothing.

Example:

```ts
const validation = { ammAllowlist: defaultAmmAllowlist('devnet') }
```

#### `assertValidRelayPolicyConfig`

```ts
export function assertValidRelayPolicyConfig(config: RelayPolicyConfig, ctx: PolicyContext = {}, opts: PolicyConfigOptions = {}): void
```

Throw a `ValidationError` (relay code 113) listing every problem, if any.

Throws: `ValidationError` `BAD_CONFIG` listing every problem.

Example:

```ts
assertValidRelayPolicyConfig(policy) // throws ValidationError listing the problems
```

#### `encodeInitPolicyData`

```ts
export function encodeInitPolicyData(flags: PolicyFlagsInput | number, config: RelayPolicyConfig, opts: PolicyConfigOptions = {}, ctx: PolicyContext = {}): Uint8Array
```

Build the 802-byte `init_policy` instruction data: `[0] + flags + config[800]` (RELAY-SPEC 7.1).

Parameters:
- `flags` raw flags byte or booleans. Bits other than paused (bit 0) and strict top level
  (bit 1) are rejected.

Throws: `ValidationError` `BAD_CONFIG | U32_RANGE` (unless `skipValidation`).

Example:

```ts
const initData = encodeInitPolicyData({ strictTopLevel: true }, policy) // 802 bytes
```

#### `encodePolicyFlags`

```ts
export function encodePolicyFlags(flags: PolicyFlagsInput | number): number
```

Pack flag booleans into the policy flags byte.

Throws: nothing.

Example:

```ts
encodePolicyFlags({ paused: false, strictTopLevel: true }) // 2
```

#### `encodeRelayPolicyConfig`

```ts
export function encodeRelayPolicyConfig(config: RelayPolicyConfig, opts: PolicyConfigOptions = {}, ctx: PolicyContext = {}): Uint8Array
```

Serialise the 800-byte policy config region (RELAY-SPEC section 5.2 region B). These are exactly
bytes [2, 802) of the `init_policy` instruction data and bytes [144, 944) of the policy account.

Throws: `ValidationError` `BAD_CONFIG` (relayCode 113) when the config breaks an init rule and `opts.skipValidation` is not set.

Example:

```ts
const config800 = encodeRelayPolicyConfig(policy) // the 800-byte config region
```

#### `validateRelayPolicyConfig`

```ts
export function validateRelayPolicyConfig(config: RelayPolicyConfig, ctx: PolicyContext = {}, opts: PolicyConfigOptions = {}): string[]
```

Validate a policy config against every `init_policy` rule of RELAY-SPEC section 5.2 and return the
list of problems (empty = valid). Each problem corresponds to relay error 113 (InvalidConfig).

Throws: nothing; returns the list of problems (empty when valid).

Example:

```ts
const problems = validateRelayPolicyConfig(policy) // string[] of every problem, [] when valid
```

#### `checkMint`

```ts
export function checkMint(account: RawAccount | null, programKey: Address): AccountCheck
```

Mirror of the relay's `check_mint` (RELAY-SPEC 6.4): owned by `programKey`, exactly 82 bytes
(extension-free), initialised. Failure is relay error 103.

Throws: nothing.

Example:

```ts
checkMint(await fetchRawAccount(rpc, mint), TOKEN_PROGRAM_ID) // { ok: true } | { ok: false, code: 103 }
```

#### `checkTokenAccountShape`

```ts
export function checkTokenAccountShape(account: RawAccount | null, programKey: Address): AccountCheck
```

Mirror of the relay's `token_acct_ok` (RELAY-SPEC 6.3): owner program (103), then layout and
state (105). Accepts 165 bytes, or for Token-2022 exactly the 170-byte ImmutableOwner-only shape.

Throws: nothing.

Example:

```ts
checkTokenAccountShape(account, TOKEN_PROGRAM_ID) // { ok: false, code: 103 | 105 } on a bad account
```

#### `decodeMint`

```ts
export function decodeMint(data: ReadonlyUint8Array): MintView
```

Decode an SPL mint. Needs at least 82 bytes.

Throws: `DecodeError` `MINT_BAD_LENGTH`

Example:

```ts
const { decimals } = decodeMint(accountBytes)
```

#### `decodeTokenAccount`

```ts
export function decodeTokenAccount(data: ReadonlyUint8Array): TokenAccountView
```

Decode an SPL token account (RELAY-SPEC 6.5 offsets). Needs at least 165 bytes.

Throws: `DecodeError` `TOKEN_ACCOUNT_BAD_LENGTH`

Example:

```ts
const { delegate, delegatedAmount, amount } = decodeTokenAccount(accountBytes)
```

### Types in this group

<details><summary><code>DecodeMandateOptions</code> - Options of `decodeMandate`.</summary>

```ts
export interface DecodeMandateOptions {
  /**
   * Accept accounts written before the hardening (version byte 0). Their layout is identical but
   * `bump` is not stored. Default false: fail closed on unknown versions.
   */
  readonly acceptLegacyVersion?: boolean
}
```
</details>

<details><summary><code>FetchOptions</code> - Common options of the RPC fetchers.</summary>

```ts
export interface FetchOptions {
  readonly commitment?: Commitment
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
  /** Re-derive the PDA and compare address and stored bump. Default true. */
  readonly verifyAddress?: boolean
  /** See `DecodeMandateOptions.acceptLegacyVersion`. */
  readonly acceptLegacyVersion?: boolean
  /** Abort signal forwarded to the RPC call. */
  readonly abortSignal?: AbortSignal
}
```
</details>

<details><summary><code>ListOptions</code> - Options for the `getProgramAccounts` based listings.</summary>

```ts
export interface ListOptions extends FetchOptions {
  /** Called for each program account that failed to decode (it is skipped). */
  readonly onSkip?: (address: Address, error: unknown) => void
  /**
   * Trusted owners (agent listings only). Anybody can create a mandate that names any agent, so
   * `fetchMandatesByAgent` WITHOUT `owners` returns attacker-created mandates too. With one owner the
   * filter also runs server-side.
   */
  readonly owners?: readonly Address[]
  /** Return at most this many mandates (after filtering). Default 1000. */
  readonly limit?: number
}
```
</details>

<details><summary><code>RawAccount</code> - A raw account as the SDK sees it.</summary>

```ts
export interface RawAccount {
  readonly address: Address
  readonly ownerProgram: Address
  readonly data: Uint8Array
  readonly lamports: bigint
  readonly executable: boolean
}
```
</details>

<details><summary><code>PolicyConfigOptions</code> - Options of the policy-config validator / encoder.</summary>

```ts
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
```
</details>

<details><summary><code>PolicyContext</code> - Addresses of the other accounts the distinctness rule involves (RELAY-SPEC section 5.2).</summary>

```ts
export interface PolicyContext {
  readonly mandate?: Address
  readonly policy?: Address
  readonly authority?: Address
  readonly owner?: Address
  readonly agent?: Address
}
```
</details>

<details><summary><code>PolicyFlagsInput</code> - Policy flags as booleans.</summary>

```ts
export interface PolicyFlagsInput {
  readonly paused?: boolean
  /** Require relay actions to be top-level instructions (stack height 1). */
  readonly strictTopLevel?: boolean
}
```
</details>

<details><summary><code>AccountsRpc</code> - Anything that can serve `getAccountInfo` (a Kit `createSolanaRpc()` result qualifies).</summary>

```ts
export type AccountsRpc = Rpc<GetAccountInfoApi>
```
</details>

<details><summary><code>ActivityRpc</code> - Anything that can serve the activity feed (`getSignaturesForAddress` + `getTransaction`).</summary>

```ts
export type ActivityRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>
```
</details>

<details><summary><code>AgentAuthRpc</code> - The full RPC surface the SDK uses. A plain `createSolanaRpc(url)` satisfies it.</summary>

```ts
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
```
</details>

#### type `Mandate`

A decoded `AgentMandate` account (2136 bytes, core layout).

```ts
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
```

<details><summary><code>MultipleAccountsRpc</code> - Anything that can serve `getMultipleAccounts`.</summary>

```ts
export type MultipleAccountsRpc = Rpc<GetMultipleAccountsApi>
```
</details>

#### type `Permission`

One permission slot of a mandate, decoded. All amounts are raw base units (bigint).

```ts
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
```

<details><summary><code>ProgramAccountsRpc</code> - Anything that can serve `getProgramAccounts`.</summary>

```ts
export type ProgramAccountsRpc = Rpc<GetProgramAccountsApi>
```
</details>

#### type `RelayPolicy`

A decoded `RelayPolicy` account (944 bytes).

```ts
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
```

#### type `RelayPolicyConfig`

The immutable config region of a relay policy (bytes [144, 944)).

```ts
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
```

#### type `SwapConfig`

The swap half of a relay policy (config region, immutable after init).

```ts
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
```

<details><summary><code>AccountCheck</code> - Result of the relay's `token_acct_ok` / `check_mint` mirrors: the relay error that would fire.</summary>

```ts
export type AccountCheck = { readonly ok: true } | { readonly ok: false; readonly code: 103 | 105 }
```
</details>

<details><summary><code>MintView</code> - A decoded SPL mint (first 82 bytes).</summary>

```ts
export interface MintView {
  readonly decimals: number
  readonly isInitialized: boolean
  readonly supply: bigint
  readonly mintAuthority: Address | null
  readonly freezeAuthority: Address | null
}
```
</details>

<details><summary><code>TokenAccountView</code> - A decoded SPL token account (first 165 bytes; extensions are ignored).</summary>

```ts
export interface TokenAccountView {
  readonly mint: Address
  readonly owner: Address
  readonly amount: bigint
  /** The SPL delegate, or `null`. */
  readonly delegate: Address | null
  /** 0 uninitialised, 1 initialised, 2 frozen. */
  readonly state: number
  readonly delegatedAmount: bigint
  readonly closeAuthority: Address | null
}
```
</details>

## Core instruction builders (AgentAuth)

#### `addPermissionIx`

```ts
export async function addPermissionIx(params: AddPermissionParams): Promise<BuiltInstruction>
```

`add_permission` (tag 1). Accounts `[owner S, mandate W]`, data
`[1] + program + spend_limit u64 + per_tx_limit u64 + disc_len + discs`.
Validates 1..8 discriminators and refuses `0n` limits (use `"unlimited"`).

Throws: `ValidationError` `ZERO_LIMIT_AMBIGUOUS | BAD_LIMIT | EMPTY_DISCRIMINATORS | TOO_MANY_DISCRIMINATORS | BAD_DISCRIMINATOR | DUPLICATE_DISCRIMINATOR | MISSING_ADDRESS`

Example:

```ts
const add = await addPermissionIx({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
  spendLimit: 250_000_000n,
  perTxLimit: 25_000_000n,
  discriminators: [TRANSFER_CHECKED_DISC],
})
```

#### `createMandateIx`

```ts
export async function createMandateIx(params: CreateMandateParams): Promise<BuiltInstruction>
```

`create_mandate` (tag 0). Accounts `[owner S W, agent R, mandate W, system R]`, data
`[0] + expiry i64`. The program rejects `expiry <= now` (error 20) and `owner == agent` (19).

Refuses an `expiry` above 1e11 (it is almost certainly milliseconds).

Throws: `ValidationError` `SAME_OWNER_AND_AGENT | BAD_EXPIRY`

Example:

```ts
const create = await createMandateIx({ owner, agent: agent.address, expiry: 1_900_000_000n })
```

#### `removePermissionIx`

```ts
export async function removePermissionIx(params: RemovePermissionParams): Promise<BuiltInstruction>
```

`remove_permission` (tag 2). Accounts `[owner S, mandate W]`, data `[2] + program`.
Removes the whole slot; re-adding it later resets `spend_total` and `call_count`.

Throws: `ValidationError` `MISSING_ADDRESS` (neither `mandate` nor `agent`).

Example:

```ts
const remove = await removePermissionIx({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
})
```

#### `revokeMandateIx`

```ts
export async function revokeMandateIx(params: MandateRef): Promise<BuiltInstruction>
```

`revoke_mandate` (tag 4). Accounts `[owner S W, mandate W, system R]`, data `[4]`. Closes the
mandate account and returns its lamports to the owner. Destructive; `set_active(false)` pauses.

Throws: `ValidationError` `MISSING_ADDRESS` (neither `mandate` nor `agent`).

Example:

```ts
const kill = await revokeMandateIx({ owner, agent: agent.address }) // destroys the mandate
```

#### `setActiveIx`

```ts
export async function setActiveIx(params: SetActiveParams): Promise<BuiltInstruction>
```

`set_active` (tag 5). Accounts `[owner S, mandate W]`, data `[5, active]`.

Throws: `ValidationError` `MISSING_ADDRESS`.

Example:

```ts
const pause = await setActiveIx({ owner, agent: agent.address, active: false })
```

#### `updatePermissionIx`

```ts
export async function updatePermissionIx(params: UpdatePermissionParams): Promise<BuiltInstruction>
```

`update_permission` (tag 6). Accounts `[owner S, mandate W]`, data
`[6] + program + spend_limit u64 + per_tx_limit u64` (49 bytes). Counters and the discriminator
list are preserved: changing a limit does not grant a fresh budget.

Throws: `ValidationError` `MISSING_ADDRESS | BAD_LIMIT | ZERO_LIMIT_AMBIGUOUS`.

Example:

```ts
const update = await updatePermissionIx({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
  spendLimit: 'unlimited', // 0n is rejected: say "unlimited" when you mean it
  perTxLimit: 10_000_000n,
})
```

#### `verifyIx`

```ts
export function verifyIx(params: VerifyParams): BuiltInstruction
```

`verify` (tag 3, 49 bytes). Accounts `[mandate W, owner R, agent R+S]`, data
`[3] + target_program + disc8 + amount u64`.

ADVISORY: `verify` trusts the program id, discriminator and amount the caller reports, and any
program may call it. It only protects an action when the integrator derives those values from the
action it is about to perform and gates that action on the result (as the relay does). Use this
builder for tests and integrations, not as proof that an agent behaved.

Throws: `ValidationError` `U64_RANGE | BAD_DISCRIMINATOR | BAD_HEX`.

Example:

```ts
const verify = verifyIx({
  mandate: mandateAddress,
  owner: owner.address,
  agent,
  targetProgram: TOKEN_PROGRAM_ID,
  discriminator: TRANSFER_CHECKED_DISC,
  amount: 5_000_000n,
})
```

#### `parseDisc`

```ts
export function parseDisc(value: DiscInput, field = 'discriminator'): Uint8Array
```

Parse and validate one 8-byte discriminator. @throws ValidationError `BAD_DISCRIMINATOR | BAD_HEX`

Throws: `ValidationError` `BAD_DISCRIMINATOR | BAD_HEX`.

Example:

```ts
parseDisc('0c00000000000000') // Uint8Array(8); also accepts 8 bytes
```

#### `parseDiscList`

```ts
export function parseDiscList(list: readonly DiscInput[]): Uint8Array[]
```

Validate a discriminator list for `add_permission`: 1..8 entries, each 8 bytes, no duplicates.

Throws: `ValidationError` `EMPTY_DISCRIMINATORS | TOO_MANY_DISCRIMINATORS | DUPLICATE_DISCRIMINATOR`

Example:

```ts
parseDiscList([TRANSFER_CHECKED_DISC, SWAP_BASE_INPUT_DISC]) // 1..8, no duplicates
```

#### `parseLimit`

```ts
export function parseLimit(value: LimitInput, field: string): bigint
```

Convert a caller-facing limit to the on-chain u64. `"unlimited"` becomes the sentinel 0; a bigint
must be in [1, 2^64-1]. A bigint `0n` is rejected on purpose: on chain 0 means UNLIMITED, and
silently turning "0" into "no limit" is the classic fail-open trap.

Throws: `ValidationError` `ZERO_LIMIT_AMBIGUOUS | BAD_LIMIT`

Example:

```ts
parseLimit('unlimited', 'spendLimit') // 0n on chain; bare 0n is refused (ZERO_LIMIT_AMBIGUOUS)
```

### Types in this group

<details><summary><code>AddPermissionParams</code> - Parameters of `addPermissionIx`.</summary>

```ts
export interface AddPermissionParams extends MandateRef, PermissionInput {}
```
</details>

<details><summary><code>CreateMandateParams</code> - Parameters of `createMandateIx`.</summary>

```ts
export interface CreateMandateParams {
  /** Owner (payer, signer). */
  readonly owner: AddressOrSigner
  /** The agent key. Not required to sign. Must differ from `owner`. */
  readonly agent: Address
  /** First unix second at which the mandate is invalid (expired iff now >= expiry). */
  readonly expiry: bigint
  /** Mandate PDA; derived when omitted. */
  readonly mandate?: Address
  readonly agentAuthProgram?: Address
}
```
</details>

<details><summary><code>PermissionInput</code> - One permission as callers state it. Limits are explicit: a positive bigint or `"unlimited"`.</summary>

```ts
export interface PermissionInput {
  /** Target program id the slot applies to (one slot per program). */
  readonly program: Address
  /** Lifetime cap in raw units, or `"unlimited"`. `0n` is rejected. */
  readonly spendLimit: LimitInput
  /** Per-`verify`-call cap in raw units, or `"unlimited"`. `0n` is rejected. */
  readonly perTxLimit: LimitInput
  /** 1..8 discriminators (8 bytes or 16 hex chars each). */
  readonly discriminators: readonly DiscInput[]
}
```
</details>

<details><summary><code>RemovePermissionParams</code> - Parameters of `removePermissionIx`.</summary>

```ts
export interface RemovePermissionParams extends MandateRef {
  /** Program whose WHOLE slot (all discriminators) is removed. */
  readonly program: Address
}
```
</details>

<details><summary><code>SetActiveParams</code> - Parameters of `setActiveIx`.</summary>

```ts
export interface SetActiveParams extends MandateRef {
  /** `true` resumes, `false` pauses (reversible; counters and permissions are kept). */
  readonly active: boolean
}
```
</details>

<details><summary><code>UpdatePermissionParams</code> - Parameters of `updatePermissionIx`.</summary>

```ts
export interface UpdatePermissionParams extends MandateRef {
  readonly program: Address
  readonly spendLimit: LimitInput
  readonly perTxLimit: LimitInput
}
```
</details>

<details><summary><code>VerifyParams</code> - Parameters of `verifyIx`.</summary>

```ts
export interface VerifyParams {
  readonly mandate: Address
  /** The mandate owner (read-only, need not sign). */
  readonly owner: Address
  /** The agent: must equal `mandate.agent` and sign. */
  readonly agent: AddressOrSigner
  /** Target program id being reported. */
  readonly targetProgram: Address
  /** Canonical 8-byte discriminator being reported (see packages/registry SCHEMA.md). */
  readonly discriminator: DiscInput
  /** Amount being reported, raw units. */
  readonly amount: bigint
  readonly agentAuthProgram?: Address
}
```
</details>

<details><summary><code>AddressOrSigner</code> - A plain address or a Kit `TransactionSigner` (the SDK never needs the secret key).</summary>

```ts
export type AddressOrSigner = Address | TransactionSigner
```
</details>

#### type `BuiltInstruction`

What every builder returns: a Kit-compatible instruction with concrete accounts and data.

```ts
export interface BuiltInstruction extends Instruction {
  readonly programAddress: Address
  readonly accounts: readonly IxAccount[]
  readonly data: Uint8Array
}
```

<details><summary><code>DiscInput</code> - A discriminator as callers state it: 8 bytes or 16 hex characters.</summary>

```ts
export type DiscInput = Uint8Array | string
```
</details>

<details><summary><code>IxAccount</code> - An account entry of a built instruction (carries `signer` when a signer object was supplied).</summary>

```ts
export type IxAccount = AccountMeta | AccountSignerMeta
```
</details>

<details><summary><code>LimitInput</code> - A limit as callers state it: a positive bigint or the explicit string `"unlimited"`.</summary>

```ts
export type LimitInput = bigint | 'unlimited'
```
</details>

<details><summary><code>MandateRef</code> - How builders find the mandate: explicit address, or derived from owner + agent.</summary>

```ts
export interface MandateRef {
  readonly owner: AddressOrSigner
  /** Mandate PDA. Derived from `owner` + `agent` when omitted. */
  readonly mandate?: Address
  readonly agent?: Address
  /** AgentAuth program id override (localnet / tests). */
  readonly agentAuthProgram?: Address
}
```
</details>

## Relay and token instruction builders

#### `closePolicyIx`

```ts
export async function closePolicyIx(params: ClosePolicyParams): Promise<BuiltInstruction>
```

Relay `close_policy` (tag 2). Accounts `[owner S W, policy W]`, data `[2]`. Returns the rent to the
owner. Works even when the mandate is already revoked, which is why the unwind plan includes it.

Throws: `ValidationError` `MISSING_ADDRESS`.

Example:

```ts
const close = await closePolicyIx({ owner, agent: agent.address })
```

#### `initPolicyIx`

```ts
export async function initPolicyIx(params: InitPolicyParams): Promise<BuiltInstruction>
```

Relay `init_policy` (tag 0, 802 data bytes). Accounts `[owner S W, mandate R, policy W, system R]`.
Validates the whole config client-side (distinctness rules, 8-recipient cap, swap rules) and
throws before encoding anything invalid.

The policy config (recipients, source, pool, floor) cannot be edited in place; changing it later means `close_policy` then `init_policy`.

Throws: `ValidationError` `BAD_CONFIG` (relayCode 113)

Example:

```ts
const init = await initPolicyIx({ owner, agent: agent.address, config: policy })
```

#### `relaySwapIx`

```ts
export async function relaySwapIx(params: RelaySwapParams): Promise<BuiltInstruction>
```

Relay `swap` (tag 4, 25 data bytes): hard-enforced exact-in swap on the ONE pool pinned in the
policy. Accounts (19, IDL order): `[agent S, mandate W, owner R, policy R, authority R,
in_account W, out_account W, amm_program R, amm_authority R, amm_config R, pool_state W,
input_vault W, output_vault W, in_token_program R, out_token_program R, in_mint R, out_mint R,
observation_state W, agentauth_program R]`.

Throws: `ValidationError` `BAD_AMOUNT | MISSING_ADDRESS` (policy without swap config)

Example:

```ts
const swap = await relaySwapIx({
  agent,
  policy,
  amountIn: 1_000_000n,
  minOut: 900_000n,
  deadlineSlot: 123_456_789n,
})
```

#### `relayTransferIx`

```ts
export async function relayTransferIx(params: RelayTransferParams): Promise<BuiltInstruction>
```

Relay `transfer` (tag 3, 9 data bytes): hard-enforced SPL `TransferChecked` from the owner's
source account to an allowlisted token account. Accounts, in IDL order:
`[agent S, mandate W, owner R, policy R, authority R, source W, destination W, mint R,
token_program R, agentauth_program R]`. The agent supplies only the amount; derived PDAs are
filled in when omitted.

Throws: `ValidationError` `BAD_AMOUNT | MISSING_ADDRESS`

Example:

```ts
const pay = await relayTransferIx({ agent, policy, destination, amount: 5_000_000n })
```

#### `setPausedIx`

```ts
export async function setPausedIx(params: SetPausedParams): Promise<BuiltInstruction>
```

Relay `set_paused` (tag 1). Accounts `[owner S, policy W]`, data `[1, paused]`. Owner only; reversible.

Throws: `ValidationError` `MISSING_ADDRESS`.

Example:

```ts
const pauseRelay = await setPausedIx({ owner, agent: agent.address, paused: true })
```

#### `approveIx`

```ts
export async function approveIx(params: ApproveParams): Promise<BuiltInstruction>
```

SPL `Approve` (tag 4): a BOUNDED delegation of `amount` raw units from `source` to the relay
authority PDA (or an explicit `delegate`). Accounts `[source W, delegate R, owner R+S]`, data
`[4] + amount u64`. One SPL delegate exists per token account, so this overwrites any earlier
delegation on `source`.

Throws: `ValidationError` `BAD_AMOUNT | MISSING_ADDRESS`

Example:

```ts
const approve = await approveIx({ source, owner, mandate: mandateAddress, amount: 250_000_000n })
```

#### `createAtaIdempotentIx`

```ts
export async function createAtaIdempotentIx(params: CreateAtaParams): Promise<BuiltInstruction>
```

Associated Token Account `CreateIdempotent` (tag 1). Accounts
`[payer WS, ata W, owner R, mint R, system R, token_program R]`, data `[1]`. A no-op when the ATA
already exists with the right owner and mint.

Throws: nothing.

Example:

```ts
const makeAta = await createAtaIdempotentIx({ payer: owner, owner: agent.address, mint })
```

#### `revokeDelegateIx`

```ts
export function revokeDelegateIx(params: RevokeDelegateParams): BuiltInstruction
```

SPL `Revoke` (tag 5): clears the delegate of `source`. Accounts `[source W, owner R+S]`, data `[5]`.

Throws: nothing.

Example:

```ts
const revoke = revokeDelegateIx({ source, owner })
```

#### `systemTransferIx`

```ts
export function systemTransferIx(params: SystemTransferParams): BuiltInstruction
```

System `Transfer` (tag 2 as u32). Accounts `[from WS, to W]`, data `[2,0,0,0] + lamports u64`.

Throws: `ValidationError` `BAD_AMOUNT | U64_RANGE`.

Example:

```ts
const fund = systemTransferIx({ from: owner, to: agent.address, lamports: 5_000_000n })
```

#### `transferCheckedIx`

```ts
export function transferCheckedIx(params: TransferCheckedParams): BuiltInstruction
```

Raw SPL `TransferChecked` (tag 12). Accounts `[source W, mint R, destination W, authority R+S]`,
data `[12] + amount u64 + decimals`. Used by the hot-wallet contrast and attack demos; it is NOT
gated by AgentAuth.

Throws: `ValidationError` `BAD_AMOUNT | BAD_DECIMALS`.

Example:

```ts
const raw1 = transferCheckedIx({
  source,
  mint,
  destination,
  authority: owner,
  amount: 1n,
  decimals: 6,
})
```

### Types in this group

<details><summary><code>ClosePolicyParams</code> - Parameters of `closePolicyIx`.</summary>

```ts
export interface ClosePolicyParams {
  readonly owner: AddressOrSigner
  readonly policy?: Address
  readonly mandate?: Address
  readonly agent?: Address
  readonly relayProgram?: Address
  readonly agentAuthProgram?: Address
}
```
</details>

<details><summary><code>InitPolicyParams</code> - Parameters of `initPolicyIx`.</summary>

```ts
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
  /** AMM allowlist / validation switches, see `PolicyConfigOptions`. */
  readonly validation?: PolicyConfigOptions
}
```
</details>

<details><summary><code>RelaySwapParams</code> - Parameters of `relaySwapIx`.</summary>

```ts
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
```
</details>

<details><summary><code>RelayTransferParams</code> - Parameters of `relayTransferIx`.</summary>

```ts
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
```
</details>

<details><summary><code>SetPausedParams</code> - Parameters of `setPausedIx`.</summary>

```ts
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
```
</details>

<details><summary><code>ApproveParams</code> - Parameters of `approveIx`.</summary>

```ts
export interface ApproveParams {
  /** The owner's token account that gets delegated (the policy `sourceAccount`). */
  readonly source: Address
  /** The owner (signer). Approve MUST be a top-level instruction signed by the owner. */
  readonly owner: AddressOrSigner
  /** Delegate. Omit to use the relay authority PDA of `mandate`. */
  readonly delegate?: Address
  /** Mandate used to derive the relay authority PDA when `delegate` is omitted. */
  readonly mandate?: Address
  /** Delegated amount in raw units (> 0). The Token program enforces this as a hard cap. */
  readonly amount: bigint
  /** Token or Token-2022 program id. Defaults to the classic Token program. */
  readonly tokenProgram?: Address
  readonly relayProgram?: Address
}
```
</details>

<details><summary><code>CreateAtaParams</code> - Parameters of `createAtaIdempotentIx`.</summary>

```ts
export interface CreateAtaParams {
  /** Rent payer (signer). */
  readonly payer: AddressOrSigner
  /** Wallet that will own the token account. */
  readonly owner: Address
  readonly mint: Address
  readonly tokenProgram?: Address
  /** ATA address; derived when omitted. */
  readonly ata?: Address
  readonly associatedTokenProgram?: Address
}
```
</details>

<details><summary><code>RevokeDelegateParams</code> - Parameters of `revokeDelegateIx`.</summary>

```ts
export interface RevokeDelegateParams {
  readonly source: Address
  readonly owner: AddressOrSigner
  readonly tokenProgram?: Address
}
```
</details>

<details><summary><code>SystemTransferParams</code> - Parameters of `systemTransferIx`.</summary>

```ts
export interface SystemTransferParams {
  readonly from: AddressOrSigner
  readonly to: Address
  readonly lamports: bigint
}
```
</details>

<details><summary><code>TransferCheckedParams</code> - Parameters of `transferCheckedIx`.</summary>

```ts
export interface TransferCheckedParams {
  readonly source: Address
  readonly mint: Address
  readonly destination: Address
  /** Authority: the token account owner (or delegate). Signer. */
  readonly authority: AddressOrSigner
  readonly amount: bigint
  readonly decimals: number
  readonly tokenProgram?: Address
}
```
</details>

## Errors

#### `AGENT_AUTH_ERRORS`

```ts
export const AGENT_AUTH_ERRORS: readonly ErrorSpec[]
```

AgentAuth core errors (codes 1..22). Names and codes are checked against idl/core-idl.json in the
test-suite. Codes 1..18 are locked; 19..22 were appended by the v0.2.0 hardening.

#### `AgentAuthError`

```ts
export class AgentAuthError extends Error {
  /** Program family that raised the error. */
  readonly program: ErrorProgram
  /** Failing program id as printed in the logs, when known. */
  readonly programId: string | undefined
  /** `Custom(n)` code. */
  readonly code: number
  /** Error name from the program IDL (for example `SpendLimitExceeded`). */
  override readonly name: string
  /** What to do about it. */
  readonly hint: string
  /** True only when the agent itself can fix it (smaller amount, fresh deadline). */
  readonly retryable: boolean
  /** Log lines the error was derived from (may be empty). */
  readonly logs: readonly string[]

  constructor(init: {
    program: ErrorProgram
    code: number
    name: string
    message: string
    hint: string
    retryable: boolean
    programId?: string
    logs?: readonly string[]
  }) {
    super(init.message)
    this.name = init.name
    this.program = init.program
    this.code = init.code
    this.hint = init.hint
    this.retryable = init.retryable
    this.programId = init.programId
    this.logs = init.logs ?? []
  }

  /** `program:code name` one-liner for logs and UIs. */
  describe(): string {
    return `${this.program}:${this.code} ${this.name}: ${this.message}`
  }
}
```

A decoded on-chain program error.

Custom error codes overlap between AgentAuth (1..22), the SPL Token program (0..19), the System
program and the relay (100..119). `program` is therefore resolved from the failing program id in
the transaction logs, never from the number alone.

#### `MOCK_AMM_ERRORS`

```ts
export const MOCK_AMM_ERRORS: readonly ErrorSpec[]
```

Mock AMM errors (test/demo program, codes 7001..7005).

#### `RELAY_ERRORS`

```ts
export const RELAY_ERRORS: readonly ErrorSpec[]
```

Relay program errors (codes 100..119). Checked against idl/relay-idl.json.

#### `SYSTEM_ERRORS`

```ts
export const SYSTEM_ERRORS: readonly ErrorSpec[]
```

System program errors (SystemError, codes 0..8).

#### `TOKEN_ERRORS`

```ts
export const TOKEN_ERRORS: readonly ErrorSpec[]
```

SPL Token program errors (TokenError, codes 0..19). Token-2022 shares the first 20 codes.

#### `errorFromCode`

```ts
export function errorFromCode(program: TableProgram, code: number): AgentAuthError
```

Wrap a pre-flight failure as an `AgentAuthError` (same shape as an on-chain failure).

Throws: nothing.

Example:

```ts
errorFromCode('relay', 104).hint // build the same error object an on-chain failure gives
```

#### `lookupError`

```ts
export function lookupError(program: ErrorProgram, code: number): ErrorSpec | undefined
```

Look up an error row. Returns undefined for unknown codes or the `unknown` program.

Throws: nothing.

Example:

```ts
lookupError('agent_auth', 9)?.name // "SpendLimitExceeded"
```

#### `parseProgramError`

```ts
export function parseProgramError(errOrLogs: unknown, opts: ParseProgramErrorOptions = {}): AgentAuthError | null
```

Turn a failed transaction (logs, a simulation result, an RPC/Kit error, a `TransactionError`
object) into an `AgentAuthError`, or `null` when no custom program error is present.

Attribution rule: the failing *program id* in the logs decides which table applies. A relay call
that fails inside `verify` logs the AgentAuth failure first and then the relay re-reporting the
same code; the SDK resolves that to the AgentAuth error. When no logs are available the code is
resolved only if it is unambiguous (relay codes 100..119); otherwise `program` is `"unknown"`
and the message lists the candidates.

Throws: never; returns `null` when the input carries no recognisable failure.

Example:

```ts
const err = parseProgramError(simulation.value.logs)
if (err?.program === 'agent_auth' && err.name === 'SpendLimitExceeded') { ... }
```

#### `DecodeError`

```ts
export class DecodeError extends SdkError {}
```

Raised when on-chain bytes do not look like what they claim to be.

#### `PlanRefusedError`

```ts
export class PlanRefusedError extends SdkError {
  readonly reasons: readonly string[]
  constructor(reasons: readonly string[]) {
    super('PLAN_REFUSED', `plan refused: ${reasons.join('; ')}`)
    this.reasons = reasons
  }
}
```

Raised by plan builders that refuse an unsafe request. `reasons` lists every refusal.

#### `SdkError`

```ts
export class SdkError extends Error {
  /** Stable machine-readable code. */
  readonly code: SdkErrorCode
  constructor(code: SdkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}
```

Base class of every error thrown by the SDK itself (as opposed to program errors).

#### `ValidationError`

```ts
export class ValidationError extends SdkError {
  /**
   * Relay error code (100..119) the program would return for the same mistake, when there is one.
   * Lets callers map client-side rejections onto on-chain behaviour.
   */
  readonly relayCode: number | undefined
  constructor(
    code: SdkErrorCode,
    message: string,
    options?: { cause?: unknown; relayCode?: number },
  ) {
    super(code, message, options)
    this.relayCode = options?.relayCode
  }
}
```

Raised when a caller-supplied input is invalid or unsafe; nothing was built.

### Types in this group

<details><summary><code>ErrorProgram</code> - Program families an error can be attributed to.</summary>

```ts
export type ErrorProgram =
  'agent_auth' | 'relay' | 'token' | 'system' | 'mock_amm' | 'runtime' | 'unknown'
```
</details>

<details><summary><code>ErrorSpec</code> - One row of an error table.</summary>

```ts
export interface ErrorSpec {
  readonly code: number
  readonly name: string
  readonly message: string
  readonly hint: string
  /** True only when the agent itself can fix it (smaller amount, fresh deadline); never when the owner must act. */
  readonly retryable: boolean
}
```
</details>

<details><summary><code>ParseProgramErrorOptions</code> - Options of `parseProgramError`.</summary>

```ts
export interface ParseProgramErrorOptions {
  /** Override program ids (localnet / tests). Defaults to the devnet ids. */
  readonly programIds?: Partial<ProgramIds>
}
```
</details>

<details><summary><code>TableProgram</code> - The programs that own an error table (everything except `runtime` and `unknown`).</summary>

```ts
export type TableProgram = Exclude<ErrorProgram, 'runtime' | 'unknown'>
```
</details>

<details><summary><code>SdkErrorCode</code> - Machine-readable codes of client-side (non on-chain) failures.</summary>

```ts
export type SdkErrorCode =
  // decoding
  | 'MANDATE_BAD_LENGTH'
  | 'MANDATE_BAD_DISCRIMINATOR'
  | 'MANDATE_UNSUPPORTED_VERSION'
  | 'MANDATE_BAD_PERMISSION_COUNT'
  | 'MANDATE_BAD_PERMISSION'
  | 'POLICY_BAD_LENGTH'
  | 'POLICY_BAD_DISCRIMINATOR'
  | 'POLICY_UNSUPPORTED_VERSION'
  | 'POLICY_BAD_FLAGS'
  | 'POLICY_BAD_CONFIG'
  | 'TOKEN_ACCOUNT_BAD_LENGTH'
  | 'MINT_BAD_LENGTH'
  | 'WRONG_OWNER_PROGRAM'
  | 'ADDRESS_MISMATCH'
  | 'BAD_ACCOUNT_DATA'
  // validation
  | 'BAD_HEX'
  | 'BAD_TIME'
  | 'U64_RANGE'
  | 'I64_RANGE'
  | 'U32_RANGE'
  | 'BAD_AMOUNT'
  | 'BAD_LIMIT'
  | 'ZERO_LIMIT_AMBIGUOUS'
  | 'BAD_DISCRIMINATOR'
  | 'TOO_MANY_DISCRIMINATORS'
  | 'EMPTY_DISCRIMINATORS'
  | 'DUPLICATE_DISCRIMINATOR'
  | 'BAD_ADDRESS'
  | 'MISSING_ADDRESS'
  | 'SAME_OWNER_AND_AGENT'
  | 'BAD_EXPIRY'
  | 'BAD_CONFIG'
  | 'BAD_UNITS'
  | 'BAD_DECIMALS'
  // transactions / client
  | 'TX_TOO_LARGE'
  | 'TX_SIGNER_UNSUPPORTED'
  | 'TX_EXPIRED'
  | 'TX_TIMEOUT'
  | 'NOT_DEPLOYED'
  | 'NOT_FOUND'
  // plans
  | 'PLAN_REFUSED'
```
</details>

## Pre-flight mirrors (offline checks of what the programs would decide)

#### `checkRelaySwap`

```ts
export function checkRelaySwap(policy: RelayPolicy | null, mandate: Mandate | null, tokenAccounts: RelaySwapTokenAccounts, args: RelaySwapCheckArgs): RelaySwapResult
```

Pre-flight mirror of the relay `swap` check order (RELAY-SPEC 7.5): … → swap enabled (110) →
deadline window (111) → pinned accounts (102) / AMM allowlist and token programs (103) → mints
(103) → input account (103/105) → output account incl. owner field (105) → floor price (114) →
`verify` (AgentAuth). The AMM itself, the post-CPI delta checks (106/112/119) and compute limits
are not simulated.

Throws: never for decoded inputs; returns `{ ok: false, ... }` with the error the program would give.

Example:

```ts
const s = checkRelaySwap(
  policy,
  mandate,
  {},
  {
    agent: agent.address,
    amountIn: 1n,
    minOut: 1n,
    deadlineSlot: 10n,
    currentSlot: 5n,
    now: 1_800_000_000n,
  },
)
```

#### `checkRelayTransfer`

```ts
export function checkRelayTransfer(policy: RelayPolicy | null, mandate: Mandate | null, tokenAccounts: RelayTokenAccounts, args: RelayTransferCheckArgs): RelayTransferResult
```

Pre-flight mirror of the relay `transfer` check order (RELAY-SPEC 7.4). Returns `{ ok: true }`
with the `verify` outcome, or the relay/AgentAuth/Token error the transaction would fail with.

Order: amount (100) → agent signer (107) → AgentAuth program id (103) → policy (101) →
paused (116) / top-level (115) → mandate (117) → bindings (102) → stale policy (118) → pins
(102/103) → recipient (104) → mint and program ownership (103) → source (105) → destination
(105) → `verify` (AgentAuth 2..18) → Token `InsufficientFunds` (token 1).

Not mirrored: the post-CPI balance-delta check (106) and compute/size limits.

Throws: never for decoded inputs; returns `{ ok: false, ... }` with the error the program would give.

Example:

```ts
const t = checkRelayTransfer(
  policy,
  mandate,
  { source: account, destination: account, mint: account },
  { agent: agent.address, amount: 1n, destination, now: 1_800_000_000n },
)
```

#### `checkVerify`

```ts
export function checkVerify(mandate: Mandate | null, call: VerifyCall, opts: CheckVerifyOptions): CheckVerifyResult
```

Pure TypeScript mirror of the core `verify` semantics (idl/core-idl.json v0.2.0 `checks`).
Check ORDER, literally: mandate missing (14) → paused (4) → expired when `now >= expiry` (5) →
owner key (2) → agent key (17) → agent signed (18) → program slot (6) → discriminator (7) →
per-call limit (8) → lifetime limit incl. u64 overflow (9). `0` limits mean unlimited; on an
unlimited permission the counters saturate and `verify` never reverts because of them.

Structural checks of the real program (data length, account count, mandate length/discriminator)
cannot fail for a decoded `Mandate` and are therefore not repeated.

This is a PRE-FLIGHT helper. The cluster Clock, not `opts.now`, decides on chain, and `verify`
itself is advisory unless an integrator gates an action on it.

Parameters:
- `mandate` decoded mandate, or `null` when the account does not exist

Throws: `ValidationError` for malformed `call` values (amount outside u64, bad discriminator)

Example:

```ts
const v = checkVerify(
  mandate,
  {
    owner: owner.address,
    agent: agent.address,
    targetProgram: TOKEN_PROGRAM_ID,
    discriminator: TRANSFER_CHECKED_DISC,
    amount: 1n,
  },
  { now: 1_800_000_000n },
)
```

#### `preflightFailureToError`

```ts
export function preflightFailureToError(failure: PreflightFailure): AgentAuthError
```

Turn a `PreflightFailure` into the same `AgentAuthError` an on-chain failure gives.

Throws: nothing.

Example:

```ts
if (!v.ok) throw preflightFailureToError(v)
```

### Types in this group

<details><summary><code>CheckVerifyOptions</code> - Options of `checkVerify`.</summary>

```ts
export interface CheckVerifyOptions {
  /** Cluster unix time in seconds (the program reads the Clock sysvar). */
  readonly now: bigint | number
  /** Whether the agent account signed. Default true. */
  readonly agentIsSigner?: boolean
}
```
</details>

<details><summary><code>CheckVerifyResult</code> - Result of `checkVerify`.</summary>

```ts
export type CheckVerifyResult = VerifyOk | PreflightFailure
```
</details>

<details><summary><code>PreflightFailure</code> - A pre-flight failure: the error the program would return.</summary>

```ts
export interface PreflightFailure {
  readonly ok: false
  readonly program: 'agent_auth' | 'relay' | 'token'
  readonly code: number
  readonly name: string
  readonly message: string
}
```
</details>

<details><summary><code>RelayCheckCommon</code> - Options common to the relay pre-flights.</summary>

```ts
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
```
</details>

<details><summary><code>RelaySwapCheckArgs</code> - Arguments of `checkRelaySwap`.</summary>

```ts
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
```
</details>

<details><summary><code>RelaySwapOk</code> - Successful relay-swap pre-flight.</summary>

```ts
export interface RelaySwapOk {
  readonly ok: true
  readonly verify: VerifyOk
  /** `ceil(amountIn * floorOut / floorIn)`. */
  readonly requiredMinOut: bigint
  /** `max(minOut, requiredMinOut)`: what the relay passes to the AMM. */
  readonly effectiveMinOut: bigint
}
```
</details>

<details><summary><code>RelaySwapResult</code> - Result of `checkRelaySwap`.</summary>

```ts
export type RelaySwapResult = RelaySwapOk | PreflightFailure
```
</details>

<details><summary><code>RelaySwapTokenAccounts</code> - Token-side accounts of a swap pre-flight.</summary>

```ts
export interface RelaySwapTokenAccounts {
  readonly inAccount?: RawAccount | null
  readonly outAccount?: RawAccount | null
  readonly inMint?: RawAccount | null
  readonly outMint?: RawAccount | null
}
```
</details>

<details><summary><code>RelayTokenAccounts</code> - Token-side accounts a relay pre-flight needs, as raw account data. `null` = does not exist.</summary>

```ts
export interface RelayTokenAccounts {
  readonly source?: RawAccount | null
  readonly destination?: RawAccount | null
  readonly mint?: RawAccount | null
}
```
</details>

<details><summary><code>RelayTransferCheckArgs</code> - Arguments of `checkRelayTransfer`.</summary>

```ts
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
```
</details>

<details><summary><code>RelayTransferOk</code> - Successful relay-transfer pre-flight.</summary>

```ts
export interface RelayTransferOk {
  readonly ok: true
  readonly verify: VerifyOk
}
```
</details>

<details><summary><code>RelayTransferResult</code> - Result of `checkRelayTransfer`.</summary>

```ts
export type RelayTransferResult = RelayTransferOk | PreflightFailure
```
</details>

<details><summary><code>VerifyCall</code> - The call `verify` would see.</summary>

```ts
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
```
</details>

<details><summary><code>VerifyOk</code> - Successful `verify` pre-flight.</summary>

```ts
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
```
</details>

## Units

#### `formatUnits`

```ts
export function formatUnits(base: bigint, decimals: number, opts: FormatUnitsOptions = {}): string
```

Format base units as a canonical decimal string: no exponent, no float, no trailing zeros
(unless `fixed`). The inverse of `parseUnits` for canonical input.

Throws: `ValidationError` `BAD_UNITS | BAD_DECIMALS`

Example:

```ts
formatUnits(1_500_000n, 6) // "1.5"
```

#### `parseLimitInput`

```ts
export function parseLimitInput(input: string, decimals: number): bigint | 'unlimited'
```

Parse a limit typed by a person or an LLM: the exact word `"unlimited"` or a positive decimal
string in token units (`"5"`, `"0.25"`). `"0"` is refused (on chain 0 means unlimited; say so
explicitly). The result is a valid input for the permission builders and plans.

Throws: `ValidationError` `BAD_LIMIT | BAD_UNITS | U64_RANGE`

Example:

```ts
parseLimitInput('250', 6) // 250_000_000n
parseLimitInput('unlimited', 6) // 'unlimited'
```

#### `parseUnits`

```ts
export function parseUnits(human: string, decimals: number): bigint
```

Parse a human decimal string (`"12.5"`) into base units, with no floating point anywhere.

Strict: digits with an optional single `.fraction`; no sign, exponent, whitespace, separators,
`NaN`/`Infinity`, empty integer or fraction part (`".5"`, `"5."`), and no more fraction digits than
`decimals`. The result must fit a u64.

Throws: `ValidationError` `BAD_UNITS | BAD_DECIMALS | U64_RANGE`

Example:

```ts
parseUnits('1.5', 6) // 1_500_000n
```

### Types in this group

<details><summary><code>FormatUnitsOptions</code> - Options of `formatUnits`.</summary>

```ts
export interface FormatUnitsOptions {
  /** Keep trailing fraction zeros (`"1.500000"`). Default false. */
  readonly fixed?: boolean
}
```
</details>

## Time and expiry

#### `MAX_MANDATE_LIFETIME_SECONDS`

```ts
export const MAX_MANDATE_LIFETIME_SECONDS = 365n * 86_400n
```

Default maximum mandate lifetime the plans accept: one year, in seconds.

#### `MAX_SANE_EXPIRY`

```ts
export const MAX_SANE_EXPIRY = 4_102_444_800n
```

2100-01-01T00:00:00Z in unix seconds: no expiry beyond this is ever sensible.

#### `MILLISECOND_SUSPECT_THRESHOLD`

```ts
export const MILLISECOND_SUSPECT_THRESHOLD = 100_000_000_000n
```

Any "seconds" value above this is almost certainly milliseconds (year 5138 in seconds).

#### `checkExpiry`

```ts
export function checkExpiry(expiry: bigint, opts: ExpiryCheckOptions = {}): string[]
```

Sanity-check an expiry. Returns the list of problems (empty when fine): in the past, looks like
milliseconds, beyond the year 2100, or longer than one year without `allowLongExpiry`.

Throws: nothing; returns the list of problems (empty when fine).

Example:

```ts
checkExpiry(1_800_000_000n * 1000n) // ["... looks like MILLISECONDS ..."]
```

#### `expiresIn`

```ts
export function expiresIn(duration: bigint | number | string, now?: bigint | number): bigint
```

The `expiry` value (unix SECONDS, bigint) for a mandate that should last `duration` from `now`.
This is the safe way to build an expiry: it can never produce milliseconds by mistake.

Throws: `ValidationError` `BAD_EXPIRY`

Example:

```ts
const expiry = expiresIn('7d')
```

#### `isoOfSeconds`

```ts
export function isoOfSeconds(seconds: bigint): string
```

ISO-8601 string for unix seconds, or `"out of range"` when JS dates cannot represent it.

Throws: nothing.

Example:

```ts
isoOfSeconds(1_800_000_000n) // "2027-01-15T08:00:00.000Z"
```

#### `parseDuration`

```ts
export function parseDuration(duration: bigint | number | string): bigint
```

Convert a duration into a lifetime in whole seconds. Accepts a number of seconds, a bigint, or a
string such as `"90m"`, `"7d"`, `"2w"` (units s, m, h, d, w).

Throws: `ValidationError` `BAD_EXPIRY`

Example:

```ts
parseDuration('90m') // 5400n
```

#### `parseExpiry`

```ts
export function parseExpiry(input: bigint | number | string, now?: bigint | number): bigint
```

Parse an expiry typed by a person or an LLM into unix seconds: a duration (`"7d"`), an ISO-8601
timestamp (`"2026-12-31T00:00:00Z"`), or a bigint/number of unix seconds. Applies the
milliseconds guard. It does not apply the one-year cap (the plans do).

Throws: `ValidationError` `BAD_EXPIRY`

Example:

```ts
parseExpiry('2030-01-01T00:00:00Z') // 1893456000n
```

### Types in this group

<details><summary><code>ExpiryCheckOptions</code> - Options of `checkExpiry`.</summary>

```ts
export interface ExpiryCheckOptions {
  readonly now?: bigint | number
  /** Allow a lifetime beyond `MAX_MANDATE_LIFETIME_SECONDS` (still capped at the year 2100). */
  readonly allowLongExpiry?: boolean
}
```
</details>

## Explain and registry

#### `explainMandate`

```ts
export function explainMandate(mandate: Mandate, opts: ExplainOptions = {}): Explanation
```

Explain a mandate in plain English: what the agent can and cannot do, the limits, the expiry, and
above all WHICH of it is hard-enforced and which is advisory.

Honesty rules baked in: only the relay's two typed actions (a `TransferChecked` to an allowlisted
token account, and one pinned-pool swap) are labelled hard; everything else depends on whichever
program the agent calls actually calling `verify`, and is labelled advisory. With no relay policy,
nothing is hard.

Throws: nothing (pure, no I/O).

Example:

```ts
const e = explainMandate(mandate, { policy, budgetDecimals: 6 })
console.log(e.headline, e.warnings)
```

`Explanation.warnings` never contains a duplicate. `dedupeWarnings(...lists)` applies the same rule
to lists you merge yourself (for example `plan.warnings` plus `explanation.warnings`): a warning that
is identical to, or a prefix of, another is dropped and the longer text kept.

```ts
export function dedupeWarnings(...lists: readonly (readonly string[])[]): string[]
```

#### `DEFAULT_DENY_RISKS`

```ts
export const DEFAULT_DENY_RISKS: readonly string[]
```

Risk classes that the registry marks default-deny.

#### `builtinRegistry`

```ts
export const builtinRegistry: RegistryLike
```

A tiny built-in registry covering the SPL Token core, the Raydium CP-Swap ABI, the mock AMM and
gated-example. It lets `explain` and `activity` work without the registry package; the real
registry (hundreds of instructions, sources, verification metadata) is preferred when available.

#### `describeInstruction`

```ts
export function describeInstruction(programId: Address | string, disc8: string, registry?: RegistryLike | null): InstructionInfo
```

Look up a (program, disc8) pair in `registry`, falling back to the built-in table. Never throws
on registry errors: a misbehaving registry degrades to "unknown".

Throws: never; an unknown program or a misbehaving registry degrades to `known: false`.

Example:

```ts
describeInstruction(TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC).title // "Transfer (checked)"
```

#### `describeProgram`

```ts
export function describeProgram(programId: Address | string, registry?: RegistryLike | null): string
```

Display name of a program: the registry's name, else the built-in table's, else a short address
(`Abcd…wxyz`). Never throws.

#### `loadRegistry`

```ts
export async function loadRegistry(): Promise<RegistryLike | null>
```

Try to load `@agentauth-sol/registry` without a static dependency. Resolves to `null` when the
package is not installed. The import specifier is intentionally not a literal and carries the
`/* webpackIgnore: true */` and `/* turbopackIgnore: true */` comments (kept in `dist/index.js`), so
bundlers keep it external and do not warn "Can't resolve @agentauth-sol/registry".

Throws: never rejects; resolves to `null` when the registry package is not installed.

Example:

```ts
const registry = await loadRegistry() // the registry package if installed, else null
const c2 = createClient({ registry })
```

### Types in this group

<details><summary><code>DelegationInfo</code> - Live SPL delegation on the policy source account (read it from the token account).</summary>

```ts
export interface DelegationInfo {
  readonly delegate: Address | null
  readonly delegatedAmount: bigint
}
```
</details>

<details><summary><code>EnforcementLevel</code> - Enforcement level labels used by `Explanation.enforcement`.</summary>

```ts
export type EnforcementLevel = 'hard (relay)' | 'advisory (integrator must call verify)'
```
</details>

<details><summary><code>ExplainOptions</code> - Options of `explainMandate`.</summary>

```ts
export interface ExplainOptions {
  /** The relay policy bound to this mandate, if one exists. Without it nothing is hard-enforced. */
  readonly policy?: RelayPolicy | null
  /** Registry for names and risk classes. The built-in table is used as a fallback. */
  readonly registry?: RegistryLike | null
  /** "Now" for expiry maths: unix seconds (bigint/number) or a Date. Defaults to the wall clock. */
  readonly now?: bigint | number | Date
  /** Decimals of the policy budget mint, to print token amounts in human units next to raw units. */
  readonly budgetDecimals?: number
  /**
   * Display symbol of the policy budget mint (for example `"DUSD"`). When given (together with
   * `budgetDecimals`) the relay lines read "Pay DUSD from ..." and amounts of the budget token read
   * "5 DUSD". Without it the output is unchanged.
   */
  readonly budgetSymbol?: string
  /** Display labels per mint address (for example the swap's in/out mints). Overrides `budgetSymbol` for that mint. */
  readonly mintLabels?: Readonly<Record<string, string>>
  /**
   * Live SPL delegation on the policy source account. Without it the relay payment line is labelled
   * "unverified" because the Token program, not the mandate, is the hard cap.
   */
  readonly delegation?: DelegationInfo | null
  /** Address of the mandate account; defaults to `mandate.address`. Used to check policy bindings. */
  readonly mandateAddress?: Address
}
```
</details>

#### type `Explanation`

Plain-English description of a mandate.

```ts
export interface Explanation {
  readonly headline: string
  /** What the agent can do right now (empty when paused or expired). */
  readonly can: string[]
  /** What the agent is not authorised to do. */
  readonly cannot: string[]
  /** What the permissions grant when the mandate is active (independent of status). */
  readonly grants: string[]
  readonly limits: LimitLine[]
  readonly expiry: { readonly iso: string; readonly relative: string; readonly expired: boolean }
  readonly status: 'active' | 'paused' | 'expired'
  readonly enforcement: { readonly action: string; readonly level: EnforcementLevel }[]
  readonly warnings: string[]
}
```

<details><summary><code>LimitLine</code> - One limit row of `Explanation.limits`.</summary>

```ts
export interface LimitLine {
  readonly program: Address
  readonly programName: string
  readonly spendLimit: 'unlimited' | bigint
  readonly perTxLimit: 'unlimited' | bigint
  readonly spendTotal: bigint
  readonly callCount: number
  /** Lifetime budget left, or `'unlimited'`. */
  readonly remaining: 'unlimited' | bigint
  readonly text: string
}
```
</details>

<details><summary><code>InstructionInfo</code> - Everything the SDK knows about one (program, disc8) pair.</summary>

```ts
export interface InstructionInfo {
  readonly programId: string
  readonly programName: string | null
  readonly name: string | null
  readonly title: string | null
  readonly risk: string | null
  readonly defaultDeny: boolean
  /** True when a registry row matched. */
  readonly known: boolean
}
```
</details>

<details><summary><code>RegistryInstructionLike</code> - One instruction row, as the registry exposes it.</summary>

```ts
export interface RegistryInstructionLike {
  readonly name: string
  readonly title?: string
  /** Canonical 8-byte discriminator, lower-case hex. */
  readonly disc8: string
  readonly risk: string
  readonly defaultDeny?: boolean
  readonly rationale?: string
}
```
</details>

<details><summary><code>RegistryLike</code> - The slice of `@agentauth-sol/registry` the SDK uses. The SDK never imports the registry</summary>

```ts
export interface RegistryLike {
  getProgramById(programId: string): RegistryProgramLike | null | undefined
  riskOf?(programId: string, disc8: string): string | null | undefined
  isDefaultDeny?(programId: string, disc8: string): boolean
}
```
</details>

<details><summary><code>RegistryProgramLike</code> - One program entry, as the registry exposes it.</summary>

```ts
export interface RegistryProgramLike {
  readonly slug?: string
  readonly name: string
  readonly instructions: readonly RegistryInstructionLike[]
}
```
</details>

<details><summary><code>RiskClass</code> - Risk classes of the AgentAuth registry (packages/registry/SCHEMA.md).</summary>

```ts
export type RiskClass =
  | 'read_only'
  | 'value_out'
  | 'value_swap'
  | 'position_mgmt'
  | 'authority_change'
  | 'account_close'
  | 'admin'
  | 'other'
```
</details>

## Plans (unsigned, owner-signed transaction sets)

#### `planClosePolicy`

```ts
export async function planClosePolicy(input: ClosePolicyInput): Promise<Plan>
```

Plan relay `close_policy`. The agent fails closed (InvalidPolicy 101); the SPL delegation is NOT revoked.

Throws: `PlanRefusedError` when chain state shows no policy.

Example:

```ts
const closePlan = await planClosePolicy({ owner, agent: agent.address })
```

#### `planOnboarding`

```ts
export async function planOnboarding(input: OnboardingInput): Promise<Plan>
```

Plan the owner onboarding of RELAY-SPEC 12.1: transaction 1 = `[System.Transfer(owner->agent)],
create_mandate, add_permission (Token), add_permission (AMM), other permissions, Approve(source),
Approve(in_account if different)`; the final transaction = relay `init_policy`. The result is
UNSIGNED. If transaction 1 would exceed 1232 bytes it is split in order.

Refuses (throws `PlanRefusedError` listing every reason): unlimited limits unless
`allowUnlimited`; `delegateCap` above the smallest lifetime limit of the permissions that draw on
the account unless `allowOverride`; missing Token/AMM permissions for the configured actions;
an existing mandate or policy (when `chainState` says so); default-deny permissions unless
`allowDefaultDeny`; an expiry in the past; `agent == owner`; invalid policy config.

Throws: `PlanRefusedError` (all `reasons`), `ValidationError`.

Example:

```ts
const plan = await planOnboarding({ owner, agent, expiry, token: { mint, source, delegateCap: 5_000_000n }, permissions, recipients })
```

#### `planPause`

```ts
export function planPause(input: PauseInput): Promise<Plan>
```

Plan a reversible stop: relay `set_paused(1)` and/or core `set_active(0)`, one transaction.

Throws: `PlanRefusedError` when nothing is left to do for the scope.

Example:

```ts
const paused = await planPause({ owner, agent: agent.address, scope: 'both' }) // unsigned
```

#### `planReinitPolicy`

```ts
export async function planReinitPolicy(input: ReinitPolicyInput): Promise<Plan>
```

Plan a policy change: `close_policy` then `init_policy` in two transactions (RELAY-SPEC 12.2; the
config is immutable and a closed account cannot be re-initialised in the same transaction). The
close step is skipped when `chainState.policy` is `null`. Delegations are not touched.

Throws: `ValidationError` for an invalid config.

Example:

```ts
const reinit = await planReinitPolicy({ owner, agent: agent.address, config: policy })
```

#### `planResume`

```ts
export function planResume(input: PauseInput): Promise<Plan>
```

Plan the inverse of `planPause`: relay `set_paused(0)` and/or core `set_active(1)`.

Throws: `PlanRefusedError` when nothing is left to do for the scope.

Example:

```ts
const resumed = await planResume({ owner, agent: agent.address })
```

#### `planRevokeDiscriminator`

```ts
export async function planRevokeDiscriminator(input: RevokeDiscriminatorInput): Promise<Plan>
```

Take ONE (or a few) discriminators away from a permission, keeping the rest and the remaining
budget. Computes the kept list for you; when nothing would be kept it plans a plain
`remove_permission`. Needs `chainState.mandate` (use `client.plan.revokeDiscriminator`).

Throws: `PlanRefusedError` when the mandate state is unknown, the slot is missing, or a discriminator is not in the slot

Example:

```ts
const narrow = await planRevokeDiscriminator({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
  discriminators: [TRANSFER_CHECKED_DISC],
  chainState: { mandate, policy: null },
})
```

#### `planRevokePermission`

```ts
export async function planRevokePermission(input: RevokePermissionInput): Promise<Plan>
```

Plan `remove_permission` (the live per-instruction revoke). Removing a slot deletes ALL of its
discriminators: the next verify for that program fails with ProgramNotAllowed (6). To show
DiscriminatorNotAllowed (7) instead, pass `replaceWith` to re-add the slot with fewer
discriminators; the remaining budget is carried over so the reset counters do not grant a fresh
budget.

Throws: `PlanRefusedError` (slot missing, widening, budget used up, unlimited without `allowUnlimited`).

Example:

```ts
const revokeSlot = await planRevokePermission({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
})
```

#### `planUnwind`

```ts
export async function planUnwind(input: UnwindInput): Promise<Plan>
```

Plan the one-transaction unwind of RELAY-SPEC 12.3: `Revoke(source)`, `Revoke(in_account)` if
different, `revoke_mandate`, `close_policy`. Each element alone already stops the agent; together
they leave no stale delegation, mandate or policy. Elements that `chainState` shows are already
gone are skipped. If the set does not fit 1232 bytes it is split with the kill switch
(`revoke_mandate`) first.

Revoking does not undo past transfers. Use a priority fee for urgency (not set by the SDK).

Throws: `PlanRefusedError` when nothing remains to unwind.

Example:

```ts
const unwind = await planUnwind({
  owner,
  agent: agent.address,
  tokenAccounts: [{ address: source }],
})
```

#### `planUpdateLimits`

```ts
export async function planUpdateLimits(input: UpdateLimitsInput): Promise<Plan>
```

Plan `update_permission`: change the lifetime and per-call limits of one slot. Counters and the
discriminator list are preserved, so changing a limit does not grant a fresh budget. Lowering the
lifetime limit below what was already spent blocks the permission until the owner raises it.

Throws: `PlanRefusedError`.

Example:

```ts
const lower = await planUpdateLimits({
  owner,
  agent: agent.address,
  program: TOKEN_PROGRAM_ID,
  spendLimit: 50_000_000n,
  perTxLimit: 5_000_000n,
})
```

#### `estimateTransactionSize`

```ts
export function estimateTransactionSize(instructions: readonly Instruction[], feePayer: Address, opts: SizeOptions = {}): number
```

Serialized size in bytes of a transaction built from `instructions` with `feePayer` as the first
signer, no address lookup tables. Exact for the default `legacy` format; `version: 0` adds the
version prefix and the empty lookup-table vector (2 bytes), and `computeBudget: true` adds the two
compute-budget instructions (52 bytes). No signatures beyond the distinct signer accounts are counted.

Layout: compact(signatures) + 64 * signatures + 3 header bytes + compact(accounts) + 32 per
account + 32 blockhash + compact(instructions) + per instruction (1 program index +
compact(accounts) + account indexes + compact(data) + data).

Throws: nothing.

Example:

```ts
estimateTransactionSize([ix], owner, { version: 0, computeBudget: true }) <= MAX_TRANSACTION_SIZE
```

#### `fitsInOneTransaction`

```ts
export function fitsInOneTransaction(instructions: readonly Instruction[], feePayer: Address, opts: SizeOptions = {}): boolean
```

True when the estimated size fits the 1232-byte transaction limit.

Throws: nothing.

Example:

```ts
fitsInOneTransaction(plan.steps[0]!.instructions, owner.address, {
  version: 0,
  computeBudget: true,
})
```

### Types in this group

#### type `ChainState`

What the caller already knows about the chain (`undefined` = unknown, `null` = does not exist).

```ts
export interface ChainState {
  readonly mandate?: Mandate | null
  readonly policy?: RelayPolicy | null
  /** Token accounts the plan touches, by address (`null` = account does not exist). */
  readonly tokenAccounts?: Readonly<Record<string, TokenAccountView | null>>
}
```

<details><summary><code>ClosePolicyInput</code> - Input of `planClosePolicy`.</summary>

```ts
export interface ClosePolicyInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
}
```
</details>

<details><summary><code>DelegatedAccount</code> - A token account whose SPL delegation should be revoked.</summary>

```ts
export interface DelegatedAccount {
  readonly address: Address
  /** Defaults to the classic Token program. */
  readonly tokenProgram?: Address
}
```
</details>

#### type `OnboardingInput`

Input of `planOnboarding`.

```ts
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
```

<details><summary><code>OnboardingSwap</code> - Swap configuration for onboarding: the policy swap config plus the delegation cap of `inAccount`.</summary>

```ts
export interface OnboardingSwap extends SwapConfig {
  /**
   * SPL delegation cap for `inAccount`. Required when `inAccount` differs from `token.source`;
   * ignored when they are the same account (then `token.delegateCap` covers both).
   */
  readonly delegateCap?: bigint
}
```
</details>

<details><summary><code>PauseInput</code> - Input of `planPause` and `planResume`.</summary>

```ts
export interface PauseInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  /** Default `"both"`: relay `set_paused` AND core `set_active`. */
  readonly scope?: PauseScope
}
```
</details>

<details><summary><code>PauseScope</code> - Which kill switches `planPause` / `planResume` touch.</summary>

```ts
export type PauseScope = 'relay' | 'mandate' | 'both'
```
</details>

#### type `Plan`

An UNSIGNED plan: transactions to be signed by the owner, in order.

```ts
export interface Plan {
  readonly steps: readonly PlanStep[]
  readonly warnings: readonly string[]
  readonly summary: string
}
```

<details><summary><code>PlanCommon</code> - Options shared by every plan builder.</summary>

```ts
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
```
</details>

#### type `PlanStep`

One transaction of a plan. The SDK never signs or sends.

```ts
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
```

<details><summary><code>ReinitPolicyInput</code> - Input of `planReinitPolicy`.</summary>

```ts
export interface ReinitPolicyInput extends PlanCommon {
  readonly agent: Address
  readonly config: RelayPolicyConfig
  readonly allowCpi?: boolean
  readonly paused?: boolean
  readonly validation?: PolicyConfigOptions
}
```
</details>

<details><summary><code>RevokeDiscriminatorInput</code> - Input of `planRevokeDiscriminator`.</summary>

```ts
export interface RevokeDiscriminatorInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  readonly program: Address
  /** One or more discriminators (8 bytes or 16 hex chars) to take away from the permission. */
  readonly discriminators: readonly (Uint8Array | string)[]
  readonly allowUnlimited?: boolean
}
```
</details>

<details><summary><code>RevokePermissionInput</code> - Input of `planRevokePermission`.</summary>

```ts
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
```
</details>

<details><summary><code>UnwindInput</code> - Input of `planUnwind`.</summary>

```ts
export interface UnwindInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  /** Token accounts to revoke. Defaults to the policy's source (and swap input) account when `chainState.policy` is known. */
  readonly tokenAccounts?: readonly DelegatedAccount[]
}
```
</details>

<details><summary><code>UpdateLimitsInput</code> - Input of `planUpdateLimits`.</summary>

```ts
export interface UpdateLimitsInput extends PlanCommon {
  readonly agent?: Address
  readonly mandate?: Address
  readonly program: Address
  readonly spendLimit: LimitInput
  readonly perTxLimit: LimitInput
  /** Accept `"unlimited"`. Default false: refused. */
  readonly allowUnlimited?: boolean
}
```
</details>

<details><summary><code>SizeOptions</code> - Options of `estimateTransactionSize`.</summary>

```ts
export interface SizeOptions {
  /** `"legacy"` (default) or `0` (what Kit and wallet adapters produce by default: +2 bytes). */
  readonly version?: 0 | 'legacy'
  /** Add a `SetComputeUnitLimit` and a `SetComputeUnitPrice` instruction (+52 bytes). */
  readonly computeBudget?: boolean
  /** Extra bytes a wallet may inject (for example a Lighthouse guard instruction). */
  readonly extraBytes?: number
}
```
</details>

## Compute budget and transactions

#### `COMPUTE_BUDGET_PROGRAM_ID`

```ts
export const COMPUTE_BUDGET_PROGRAM_ID: Address
```

The Compute Budget program.

#### `setComputeUnitLimitIx`

```ts
export function setComputeUnitLimitIx(units: number): BuiltInstruction
```

`SetComputeUnitLimit` (tag 2, u32 LE units). Without it a transaction gets 200,000 CU per
instruction (capped at 1.4M); set it to bound the fee and to guarantee headroom for the relay swap.

Throws: `ValidationError` `U32_RANGE`

Example:

```ts
const ix = setComputeUnitLimitIx(400_000)
```

#### `setComputeUnitPriceIx`

```ts
export function setComputeUnitPriceIx(microLamports: bigint): BuiltInstruction
```

`SetComputeUnitPrice` (tag 3, u64 LE micro-lamports per CU): the priority fee. Priority fee in
lamports = ceil(units * microLamports / 1e6). Use it on kill-switch transactions during congestion.

Throws: `ValidationError` `U64_RANGE`

Example:

```ts
const ix = setComputeUnitPriceIx(50_000n)
```

#### `buildTransactionMessage`

```ts
export function buildTransactionMessage(source: StepLike, opts: BuildMessageOptions)
```

Build a Kit transaction message (fee payer, blockhash lifetime, optional compute-budget
instructions first, then the step's instructions). Pure and browser-safe; no keys involved.

Throws: nothing.

Example:

```ts
const msg = buildTransactionMessage(plan.steps[0], { feePayer: owner, blockhash })
```

#### `compileUnsigned`

```ts
export function compileUnsigned(source: StepLike, opts: BuildMessageOptions): UnsignedTransaction
```

Compile a step into an unsigned base64 wire transaction (for MCP "unsigned transaction" output,
wallet adapters and hardware wallets). Signer objects inside the instructions are ignored.

Throws: `SdkError` `TX_TOO_LARGE` when the compiled transaction exceeds 1232 bytes

Example:

```ts
const { base64 } = compileUnsigned(plan.steps[0]!, { feePayer: owner.address, blockhash })
```

#### `planToUnsignedTransactions`

```ts
export function planToUnsignedTransactions(plan: Plan, opts: BuildMessageOptions): UnsignedPlanStep[]
```

Turn a whole plan into unsigned transactions in order, each with its dependency metadata. A
consumer must not submit step N before every step in `dependsOn` is confirmed, and must wait for
confirmation of steps with `awaitConfirmation`.

The blockhash is shared by all steps: re-compile with a fresh blockhash before submitting a later
step if more than ~60 seconds passed.

Throws: `SdkError` `TX_TOO_LARGE`.

Example:

```ts
const unsigned = planToUnsignedTransactions(plan, {
  feePayer: owner.address,
  blockhash,
  microLamportsPerCu: 10_000n,
})
```

#### `sendAndConfirmStep`

```ts
export async function sendAndConfirmStep(rpc: AgentAuthRpc, source: StepLike, opts: SendOptions): Promise<SendResult>
```

Sign with the given partial signers, send, and poll until the transaction reaches `commitment`,
the blockhash expires, or the timeout elapses. A transaction that lands and FAILS does not throw:
the result has `ok: false` with the decoded `error` and logs (so blocked agent attempts can be
shown). Expiry/timeouts throw `SdkError`.

Throws: `SdkError` `TX_SIGNER_UNSUPPORTED | TX_EXPIRED | TX_TIMEOUT | TX_TOO_LARGE`

Example:

```ts
const sent = await sendAndConfirmStep(rpc, plan.steps[0]!, {
  signers: [owner],
  commitment: 'confirmed',
})
```

#### `simulateStep`

```ts
export async function simulateStep(rpc: AgentAuthRpc, source: StepLike, opts: SimulateOptions): Promise<SimulationResult>
```

Simulate a step WITHOUT signing: the RPC runs it with `sigVerify: false` and a replaced recent
blockhash, returning logs, compute units and the decoded error. A step that depends on an
unconfirmed earlier step will fail here exactly as it would on chain (for example 117).

Throws: `SdkError` `TX_TOO_LARGE`; RPC errors propagate. An on-chain failure is a result (`ok: false`), not an exception.

Example:

```ts
const sim = await simulateStep(rpc, plan.steps[0]!, { feePayer: owner.address })
if (!sim.ok) console.log(sim.error?.name, sim.logs)
```

#### `stripSigners`

```ts
export function stripSigners(value: Plan): Plan export function stripSigners(value: PlanStep): PlanStep export function stripSigners(value: BuiltInstruction): BuiltInstruction export function stripSigners(value: Plan | PlanStep | BuiltInstruction): unknown
export function stripSigners(value: PlanStep): PlanStep export function stripSigners(value: BuiltInstruction): BuiltInstruction export function stripSigners(value: Plan | PlanStep | BuiltInstruction): unknown
export function stripSigners(value: BuiltInstruction): BuiltInstruction export function stripSigners(value: Plan | PlanStep | BuiltInstruction): unknown
```

Remove any `TransactionSigner` objects embedded in instruction account metas (so a plan can be
logged or serialized without touching key material). Addresses and roles are kept.

Throws: nothing.

Example:

```ts
console.log(JSON.stringify(stripSigners(plan))) // safe to log: no signer objects
```

### Types in this group

<details><summary><code>BlockhashLifetime</code> - A blockhash with the last block height at which it is still valid (`getLatestBlockhash().value`).</summary>

```ts
export interface BlockhashLifetime {
  readonly blockhash: string
  readonly lastValidBlockHeight: bigint
}
```
</details>

#### type `BuildMessageOptions`

Options of `buildTransactionMessage` and `compileUnsigned`.

```ts
export interface BuildMessageOptions {
  readonly feePayer: Address
  readonly blockhash: BlockhashLifetime
  /** Message version. Default `0` (what Kit and wallet adapters produce). */
  readonly version?: 0 | 'legacy'
  /** Prepend SetComputeUnitLimit. */
  readonly computeUnitLimit?: number
  /** Prepend SetComputeUnitPrice (priority fee, micro-lamports per CU). */
  readonly microLamportsPerCu?: bigint
}
```

#### type `SendOptions`

Options of `sendAndConfirmStep`.

```ts
export interface SendOptions extends ParseProgramErrorOptions {
  /** Signers: the fee payer first, then everyone else the step needs (owner, agent). */
  readonly signers: readonly TransactionSigner[]
  /** Defaults to `signers[0].address`. */
  readonly feePayer?: Address
  readonly version?: 0 | 'legacy'
  readonly computeUnitLimit?: number
  readonly microLamportsPerCu?: bigint
  /** Skip the RPC preflight simulation so a blocked attempt lands on chain (attack demos). Default false. */
  readonly skipPreflight?: boolean
  /** Confirmation level to wait for. Default `confirmed`. */
  readonly commitment?: Exclude<Commitment, 'processed'>
  /** Give up after this many milliseconds. Default 60000. */
  readonly timeoutMs?: number
  readonly abortSignal?: AbortSignal
  /**
   * Fetch the transaction logs after confirmation so a SUCCESSFUL result carries them too (read relay
   * events such as SwapExecuted from `logs`). Default true; pass false to save one RPC round trip.
   * A failed transaction always fetches its logs (needed to decode the error).
   */
  readonly includeLogs?: boolean
}
```

Failure modes: with the default `skipPreflight: false`, an RPC preflight rejection never lands, so
`sendAndConfirmStep` / `client.sendAndConfirm` THROW a Kit `SolanaError` (decode it with
`parseProgramError`). A transaction that lands and fails (for example with `skipPreflight: true`)
RETURNS `ok: false` with the decoded `error` and `logs`.

#### type `SendResult`

Result of `sendAndConfirmStep`.

```ts
export interface SendResult {
  readonly signature: string
  /** True when the transaction landed and succeeded. */
  readonly ok: boolean
  /** The raw `TransactionError` of a landed-but-failed transaction. */
  readonly err: unknown
  readonly slot: bigint | null
  /** Decoded error of a failed transaction (fetched from the transaction logs). */
  readonly error: AgentAuthError | null
  readonly logs: readonly string[]
}
```

#### type `SimulateOptions`

Options of `simulateStep`.

```ts
export interface SimulateOptions extends ParseProgramErrorOptions {
  readonly feePayer: Address
  readonly version?: 0 | 'legacy'
  readonly computeUnitLimit?: number
  readonly microLamportsPerCu?: bigint
  readonly commitment?: Commitment
  readonly abortSignal?: AbortSignal
}
```

#### type `SimulationResult`

Result of `simulateStep`.

```ts
export interface SimulationResult {
  /** The raw `TransactionError` (`null` on success). */
  readonly err: unknown
  readonly logs: readonly string[]
  readonly unitsConsumed: bigint | null
  /** Decoded program/runtime error (agent_auth, relay, token, system, runtime) or null. */
  readonly error: AgentAuthError | null
  readonly ok: boolean
}
```

<details><summary><code>StepLike</code> - What the builders accept: a plan step or a bare instruction list.</summary>

```ts
export type StepLike = PlanStep | readonly Instruction[]
```
</details>

#### type `UnsignedPlanStep`

One element of `planToUnsignedTransactions`.

```ts
export interface UnsignedPlanStep extends UnsignedTransaction {
  readonly label: string
  readonly description: string
  readonly expectedOutcome: string
  readonly dependsOn: readonly number[]
  readonly awaitConfirmation: boolean
}
```

#### type `UnsignedTransaction`

An unsigned, serialized transaction ready to hand to a wallet.

```ts
export interface UnsignedTransaction {
  /** Base64 of the wire transaction with all-zero signature slots (wallets fill them in). */
  readonly base64: string
  /** The compiled message bytes the signers sign. */
  readonly messageBytes: Uint8Array
  /** Serialized size in bytes. */
  readonly sizeBytes: number
  /** Addresses that must sign, fee payer first. */
  readonly requiredSigners: readonly Address[]
}
```

## JSON serialization

#### `activityToJson`

```ts
export function activityToJson(items: readonly ActivityItem[]): JsonValue
```

JSON form of activity rows (amounts as decimal strings, errors as `{name, code, ...}`).

Throws: nothing.

Example:

```ts
JSON.stringify(activityToJson(await client.activity({ mandate: mandateAddress, limit: 20 })))
```

#### `explanationToJson`

```ts
export function explanationToJson(explanation: Explanation): JsonValue
```

JSON form of an explanation (`can`, `cannot`, `limits`, `enforcement`, `warnings`, ...).

Throws: nothing.

Example:

```ts
JSON.stringify(explanationToJson(client.explain(mandate)))
```

#### `mandateToJson`

```ts
export function mandateToJson(mandate: Mandate): JsonValue
```

JSON form of a mandate: bigints as decimal strings, discriminators as hex.

Throws: nothing.

Example:

```ts
JSON.stringify(mandateToJson(mandate))
```

#### `planToJson`

```ts
export function planToJson(plan: Plan): JsonValue
```

JSON form of a plan: instructions are `{ programAddress, accounts: [{ address, isSigner,
isWritable }], dataHex }` and never contain signer objects.

Throws: nothing.

Example:

```ts
JSON.stringify(planToJson(plan))
```

#### `policyToJson`

```ts
export function policyToJson(policy: RelayPolicy): JsonValue
```

JSON form of a relay policy.

Throws: nothing.

Example:

```ts
JSON.stringify(policyToJson(policy))
```

#### `toJsonSafe`

```ts
export function toJsonSafe(value: unknown, depth = 0): JsonValue
```

Convert any SDK value into plain JSON. Rules, fixed so every consumer agrees:

- `bigint` becomes a DECIMAL STRING (u64 does not fit a JSON number; never a float).
- `Uint8Array` becomes lower-case hex.
- `Address` stays a base58 string.
- `AgentAuthError` / `Error` become `{ name, message, program?, code?, hint?, retryable? }`.
- `Date` becomes an ISO string; `Map` becomes an object; `undefined` and functions are omitted.
- A `signer` key (a `TransactionSigner` embedded in an instruction meta) is dropped.

Throws: nothing.

Example:

```ts
JSON.stringify(toJsonSafe(await client.fetchMandate(address)))
```

### Types in this group

<details><summary><code>JsonValue</code> - Any JSON value.</summary>

```ts
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
```
</details>

## Capacity and seller-side checks

#### `capacity`

```ts
export function capacity(mandate: Mandate, policy: RelayPolicy | null, live: CapacityLive = {}, action: 'transfer' | 'swap' = 'transfer'): Capacity
```

Structured "how much can the agent move through the relay right now" (min of the per-call limit,
the remaining lifetime budget, the SPL delegated amount and the source balance), or the exact
error that blocks it. `action` selects the relay transfer (default) or swap slot.

It mirrors the pre-flight order but cannot see the AMM, the destination account or other
transactions that race for the same budget: it is an upper bound, never a promise.

Throws: nothing.

Example:

```ts
const c = capacity(mandate, policy, { delegation, balance })
if (c.blockedBy) tell(c.blockedBy.name) else console.log(c.maxSpendNow, c.limitedBy)
```

#### `assertMandateAuthorises`

```ts
export function assertMandateAuthorises(mandate: Mandate | null, input: AuthoriseInput): AuthoriseResult
```

Seller-side authorisation check (off-chain pre-check of what the core `verify` would decide),
with the trap closed: `expectedOwner` must be supplied by you, so a mandate created by a stranger
for the agent is rejected with `NotOwner (2)`.

This is ADVISORY: an off-chain read cannot reserve budget (two sellers can both pass it and the
second on-chain `verify` can still fail), and only your program calling `verify` (CPI) enforces
anything on chain. Use it for UX and early rejection, not as the gate.

Throws: `SdkError` `MISSING_ADDRESS` (empty `expectedOwner`); `ValidationError` `U64_RANGE | BAD_DISCRIMINATOR` for malformed input. A denial is a result, not an exception.

Example:

```ts
const r = assertMandateAuthorises(mandate, { expectedOwner, agent, targetProgram, discriminator, amount: 5n, now })
if (!r.ok) throw r.error
```

### Types in this group

#### type `Capacity`

Result of `capacity`.

```ts
export interface Capacity {
  /** Largest raw-unit amount a relay payment could move right now; `0n` when blocked. */
  readonly maxSpendNow: bigint
  /** The binding limits (all that equal the minimum). Empty when blocked or nothing is bounded. */
  readonly limitedBy: readonly LimitedBy[]
  /** Why nothing can move at all, or `null`. */
  readonly blockedBy: {
    readonly program: string
    readonly code: number
    readonly name: string
    readonly why: string
  } | null
  /** Each bound separately (`null` = unbounded or unknown). */
  readonly bounds: {
    readonly perCall: bigint | null
    readonly mandateBudget: bigint | null
    readonly delegation: bigint | null
    readonly balance: bigint | null
  }
  /** True when the delegation or balance was not provided, so the figure may be too high. */
  readonly partial: boolean
}
```

<details><summary><code>CapacityLive</code> - Live facts about the source token account.</summary>

```ts
export interface CapacityLive {
  readonly delegation?: DelegationInfo | null
  readonly balance?: bigint | null
  /** Unix seconds; defaults to the wall clock. */
  readonly now?: bigint | number
}
```
</details>

<details><summary><code>LimitedBy</code> - What limits a relay payment right now.</summary>

```ts
export type LimitedBy = 'per_call_limit' | 'mandate_budget' | 'delegation' | 'balance'
```
</details>

#### type `AuthoriseInput`

Input of `assertMandateAuthorises`.

```ts
export interface AuthoriseInput {
  /**
   * The owner YOU trust for this asset (the wallet whose funds or resources the agent would spend).
   * REQUIRED, and never read from the mandate or from the caller's request: a mandate created by
   * anybody who names the agent verifies fine against itself.
   */
  readonly expectedOwner: Address
  /** The agent that signed your instruction. */
  readonly agent: Address
  /** Your program id, as the mandate permission lists it. */
  readonly targetProgram: Address
  /** The canonical disc8 of the action (8 bytes or 16 hex chars). */
  readonly discriminator: Uint8Array | string
  /** Raw-unit amount the action would book. */
  readonly amount: bigint
  /** Cluster unix seconds. */
  readonly now: bigint | number
}
```

<details><summary><code>AuthoriseResult</code> - Result of `assertMandateAuthorises`.</summary>

```ts
export type AuthoriseResult =
  | (VerifyOk & { readonly advisory: true })
  | {
      readonly ok: false
      readonly failure: PreflightFailure
      readonly error: AgentAuthError
      readonly advisory: true
    }
```
</details>

## Activity feed

#### `decodeRelayEvents`

```ts
export function decodeRelayEvents(logs: readonly string[], relayProgram: Address): LocatedRelayEvent[]
```

Decode relay events from transaction logs (`Program data: <base64>` lines).

A data line counts only when the relay is the program currently executing (the SDK tracks the
`invoke`/`success`/`failed` nesting), so a different program cannot forge a relay event.
Unknown tags and wrong lengths are ignored. Layouts: relay-idl `events` (tags 1..5).

Throws: nothing.

Example:

```ts
const events = decodeRelayEvents(logs, client.programIds.relay) // forgery-proof: stack-aware
```

#### `decodeTransaction`

```ts
export function decodeTransaction(tx: DecodableTransaction, ctx: DecodeContext = {}): ActivityItem[]
```

Decode one transaction into activity rows (pure, offline). One row per recognised top-level
AgentAuth / relay / SPL-Token-transfer instruction; a transaction with none of those yields a
single `unknown` row so nothing is silently dropped. Failed transactions carry
`parseProgramError` output (attributed by failing program id) on every row, and
`ok: false` because the whole transaction reverted.

Throws: never; undecodable instructions are skipped, a transaction with nothing recognised yields one `unknown` row.

Example:

```ts
const rows = decodeTransaction(toDecodableTransaction(signature, tx), { mandate: mandateAddress })
```

#### `getActivity`

```ts
export async function getActivity(rpc: ActivityRpc, opts: GetActivityOptions): Promise<ActivityItem[]>
```

`getActivityPage` without the cursor: just the rows.

Throws: RPC errors of the signature listing propagate; per-transaction failures become rows with `fetchError`.

Example:

```ts
const feed = await getActivity(rpc, { mandate: mandateAddress, limit: 25 })
```

#### `getActivityPage`

```ts
export async function getActivityPage(rpc: ActivityRpc, opts: GetActivityOptions): Promise<ActivityPage>
```

Read the on-chain history of a mandate: `getSignaturesForAddress(mandate)` (plus the policy when
given), then `getTransaction` for each signature, decoded with `decodeTransaction` (top-level
instructions AND CPI `verify` calls). Rows are newest first. Failures are tolerated per
transaction: a signature whose fetch fails after retries yields an `unknown` row with
`fetchError`, never a rejected feed. Transactions the RPC no longer has yield an `unknown` row.

Throws: RPC errors of the signature listing propagate; per-transaction failures become rows with `fetchError`.

Example:

```ts
const page = await getActivityPage(rpc, { mandate: mandateAddress, limit: 25 })
const older =
  page.nextBefore &&
  (await getActivityPage(rpc, { mandate: mandateAddress, limit: 25, before: page.nextBefore }))
```

#### `toDecodableTransaction`

```ts
export function toDecodableTransaction(signature: string, res: RpcTransactionLike): DecodableTransaction
```

Convert an RPC `getTransaction` response (encoding `json`) into a `DecodableTransaction`.

Throws: nothing.

Example:

```ts
const decodable = toDecodableTransaction(signature, tx) // from getTransaction(..., {encoding:'json'})
```

### Types in this group

#### type `ActivityItem`

One row of the activity feed.

```ts
export interface ActivityItem {
  readonly signature: string
  readonly slot: bigint
  readonly blockTime: bigint | null
  readonly kind: ActivityKind
  /** False when the whole transaction failed (everything in it reverted). */
  readonly ok: boolean
  /** The decoded program error of a failed transaction, when it carries a custom code. */
  readonly error?: AgentAuthError
  /** Raw-unit amount (transfer amount, swap `amount_in`, or the amount reported to `verify`). */
  readonly amount?: bigint
  /** Destination token account (transfers) or output account (swaps). */
  readonly recipient?: Address
  /** Target program of the action (token program, AMM, or the program a permission is about). */
  readonly program?: Address
  /** Registry/built-in name of the instruction (for example `transfer_checked`). */
  readonly discriminatorName?: string
  /** Index of the top-level instruction this row comes from; -1 for a transaction without a decoded instruction. */
  readonly instructionIndex: number
  /** The relay event emitted by that instruction, if any. */
  readonly event?: RelayEvent
  /** Fee payer of the transaction (the first account key); the agent for relay calls. */
  readonly feePayer?: Address
  /** All signers of the transaction. */
  readonly signers?: readonly Address[]
  /**
   * Set on rows decoded from a CPI (inner instruction): the program of the top-level instruction
   * that made the call, for example a seller program or the relay calling `verify`.
   */
  readonly viaProgram?: Address
  /** Set when the transaction could not be fetched or decoded (the row is a placeholder). */
  readonly fetchError?: string
  /** Only with `foldVerify`: the nested relay `verify` row folded into this relay row. */
  readonly verify?: ActivityItem
}
```

<details><summary><code>ActivityPage</code> - A page of the activity feed.</summary>

```ts
export interface ActivityPage {
  readonly items: ActivityItem[]
  /** Pass as `before` to read the next (older) page, or `null` when the history is exhausted. */
  readonly nextBefore: string | null
}
```
</details>

<details><summary><code>ActivityKind</code> - What an activity row represents.</summary>

```ts
export type ActivityKind =
  | 'create'
  | 'add_permission'
  | 'remove_permission'
  | 'update_permission'
  | 'set_active'
  | 'revoke'
  | 'verify'
  | 'relay_transfer'
  | 'relay_swap'
  | 'relay_init'
  | 'relay_pause'
  | 'relay_close'
  | 'token_transfer'
  | 'unknown'
```
</details>

<details><summary><code>DecodableTransaction</code> - The pure input of `decodeTransaction`.</summary>

```ts
export interface DecodableTransaction {
  readonly signature: string
  readonly slot: bigint
  readonly blockTime: bigint | null
  /** `meta.err`: `null` on success. */
  readonly err: unknown
  readonly logs: readonly string[]
  /** Static account keys followed by loaded writable then loaded readonly addresses. */
  readonly accountKeys: readonly string[]
  readonly instructions: readonly RawInstruction[]
  /** Inner (CPI) instructions grouped by the index of the top-level instruction. */
  readonly innerInstructions?: readonly {
    readonly index: number
    readonly instructions: readonly RawInstruction[]
  }[]
  /** Number of leading account keys that signed (header.numRequiredSignatures). */
  readonly numRequiredSignatures?: number
}
```
</details>

<details><summary><code>DecodeContext</code> - Context for `decodeTransaction`.</summary>

```ts
export interface DecodeContext {
  /** Keep AgentAuth/relay instructions only if they reference this mandate or `policy`. */
  readonly mandate?: Address
  readonly policy?: Address
  readonly registry?: RegistryLike | null
  readonly programIds?: Partial<ProgramIds>
}
```
</details>

<details><summary><code>GetActivityOptions</code> - Options of `getActivity`.</summary>

```ts
export interface GetActivityOptions {
  readonly mandate: Address
  /** Also scan the relay policy account (captures `init_policy` / `close_policy` history). */
  readonly policy?: Address
  /** Number of signatures to read per address (1..1000). */
  readonly limit: number
  /** Page backwards: only signatures older than this one. */
  readonly before?: string
  /** Live polling: only signatures newer than this one (stop at the last one you already have). */
  readonly until?: string
  /**
   * Cache of decoded rows by signature. Confirmed transactions are immutable, so a live feed that
   * passes the same Map re-fetches nothing it already decoded.
   */
  readonly cache?: Map<string, ActivityItem[]>
  /** Retries per `getTransaction` on a rate-limit/transient error (exponential backoff). Default 3. */
  readonly retries?: number
  readonly registry?: RegistryLike | null
  readonly programIds?: Partial<ProgramIds>
  readonly commitment?: Exclude<Commitment, 'processed'>
  readonly abortSignal?: AbortSignal
  /** Parallel `getTransaction` calls. Default 5. */
  readonly concurrency?: number
  /**
   * Fold a nested `verify` row that has `viaProgram` (the relay calling verify) into the relay row of
   * the same top-level instruction, keeping the verify details in the row's `verify` field, so one
   * relay action is one row. Default false (every decoded row is returned).
   */
  readonly foldVerify?: boolean
  /**
   * Stop after the most recent SUCCESSFUL `create` row of this page (rows of that transaction are
   * kept, older rows are dropped, `nextBefore` becomes null), so a mandate address that was revoked
   * and created again shows only the current generation. Default false. Only rows of the requested
   * page are inspected: when the page holds no create row nothing is dropped.
   */
  readonly stopAtCreation?: boolean
}
```
</details>

<details><summary><code>LocatedRelayEvent</code> - A relay event together with the top-level instruction that emitted it.</summary>

```ts
export interface LocatedRelayEvent {
  /** Index of the top-level instruction (0-based). */
  readonly instructionIndex: number
  readonly event: RelayEvent
}
```
</details>

<details><summary><code>RawInstruction</code> - A top-level instruction in wire form.</summary>

```ts
export interface RawInstruction {
  readonly programIdIndex: number
  readonly accounts: readonly number[]
  /** Base58 instruction data, as `getTransaction` returns it. */
  readonly data: string
}
```
</details>

<details><summary><code>RelayEvent</code> - A relay event decoded from a `Program data:` log line (relay-idl `events`).</summary>

```ts
export type RelayEvent =
  | {
      readonly type: 'TransferExecuted'
      readonly mandate: Address
      readonly destination: Address
      readonly mint: Address
      readonly amount: bigint
    }
  | {
      readonly type: 'SwapExecuted'
      readonly mandate: Address
      readonly poolState: Address
      readonly amountInRequested: bigint
      readonly inDelta: bigint
      readonly outDelta: bigint
    }
  | {
      readonly type: 'PolicyInitialized'
      readonly mandate: Address
      readonly policy: Address
      readonly flags: number
    }
  | { readonly type: 'PolicyClosed'; readonly mandate: Address; readonly policy: Address }
  | { readonly type: 'PausedChanged'; readonly mandate: Address; readonly paused: boolean }
```
</details>

<details><summary><code>RpcTransactionLike</code> - The slice of a `getTransaction` (encoding `json`) response the SDK reads. A Kit response satisfies it.</summary>

```ts
export interface RpcTransactionLike {
  readonly slot: bigint | number
  readonly blockTime: bigint | number | null
  readonly meta: {
    readonly err: unknown
    readonly logMessages?: readonly string[] | null
    readonly loadedAddresses?: {
      readonly writable: readonly string[]
      readonly readonly: readonly string[]
    }
    readonly innerInstructions?:
      readonly { readonly index: number; readonly instructions: readonly RawInstruction[] }[] | null
  } | null
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[]
      readonly instructions: readonly RawInstruction[]
      readonly header?: { readonly numRequiredSignatures: number }
    }
  }
}
```
</details>

## Client

#### `createClient`

```ts
export function createClient(opts: CreateClientOptions = {}): Client
```

Create the convenience client. Three lines to read a mandate:

Throws: `SdkError` `NOT_DEPLOYED` for `mainnet-beta` without program id overrides

Example:

```ts
const client = createClient({ cluster: 'devnet' })
const mandate = await client.fetchMandate(address)
console.log(mandate && client.explain(mandate).headline)
```

#### `parseAddress`

```ts
export function parseAddress(value: string): Address
```

Parse a base58 string into an `Address`, throwing a typed error on failure.

Throws: `SdkError` `BAD_ADDRESS`.

Example:

```ts
parseAddress('11111111111111111111111111111111') // throws SdkError BAD_ADDRESS otherwise
```

### Types in this group

#### type `Client`

The bundled convenience client. It holds only configuration and the RPC; no global state.

```ts
export interface Client {
  readonly cluster: Cluster
  readonly rpc: AgentAuthRpc
  readonly programIds: ProgramIds
  readonly registry: RegistryLike
  /** Fetch a mandate by address; `null` when it does not exist (also for a dusted, system-owned PDA). */
  fetchMandate(address: Address): Promise<Mandate | null>
  /** Fetch the mandate of an (owner, agent) pair. */
  fetchMandateFor(
    owner: Address,
    agent: Address,
  ): Promise<{ address: Address; mandate: Mandate | null }>
  /** Fetch the relay policy of a mandate; `null` when it does not exist. */
  fetchPolicy(mandate: Address): Promise<RelayPolicy | null>
  /** Fetch and decode an SPL mint (decimals, supply, authorities); `null` when it does not exist. */
  fetchMint(mint: Address): Promise<MintView | null>
  /** Current cluster unix time in seconds, from the Clock sysvar. */
  getClusterTime(): Promise<bigint>
  mandatesByOwner(owner: Address, opts?: Pick<ListOptions, 'onSkip' | 'limit'>): Promise<Mandate[]>
  /**
   * Mandates naming `agent`. WARNING: anybody can create a mandate that names any agent; pass
   * `owners` (the owners you trust) before presenting these as authorisations.
   */
  mandatesByAgent(
    agent: Address,
    opts?: Pick<ListOptions, 'onSkip' | 'owners' | 'limit'>,
  ): Promise<Mandate[]>
  /** Explain a mandate you already hold (uses the client's registry). */
  explain(mandate: Mandate, opts?: ExplainOptions): Explanation
  /**
   * Fetch mandate + policy + delegation + mint decimals (3 round trips at most, batched with
   * `getMultipleAccounts`) and explain it. Accepts an address or `{ mandate }` for one you hold.
   */
  inspect(address: Address, opts?: InspectOptions): Promise<MandateView>
  /** Unsigned plans with chain state filled in. */
  readonly plan: ClientPlans
  /** Pre-flight a relay transfer against live chain data. */
  preflightTransfer(
    input: PreflightBase & { destination: Address; amount: bigint },
  ): Promise<RelayTransferResult>
  /** Pre-flight a relay swap against live chain data. */
  preflightSwap(
    input: PreflightBase & { amountIn: bigint; minOut: bigint; deadlineSlot: bigint },
  ): Promise<RelaySwapResult>
  /** Structured "how much can the agent move right now" for an (owner, agent) pair. */
  capacityFor(
    owner: Address,
    agent: Address,
  ): Promise<Capacity & { readonly mandateFound: boolean }>
  /** Activity feed of a mandate (and optionally its policy). */
  activity(opts: Omit<GetActivityOptions, 'registry' | 'programIds'>): Promise<ActivityItem[]>
  /** Like `activity` but with the `nextBefore` cursor for paging. */
  activityPage(opts: Omit<GetActivityOptions, 'registry' | 'programIds'>): Promise<ActivityPage>
  /** Simulate a step or instruction list without signing: logs, units, decoded error. */
  simulate(source: StepLike, opts: SimulateOptions): Promise<SimulationResult>
  /** Sign, send and wait for confirmation; a landed failure returns `ok: false` with the decoded error. */
  sendAndConfirm(source: StepLike, opts: SendOptions): Promise<SendResult>
  /**
   * Find token accounts of `owner` whose SPL delegate is one of `delegates` (for example the relay
   * authority of a mandate whose policy is already closed). Uses `getTokenAccountsByOwner`.
   */
  findDelegationsTo(owner: Address, delegates: readonly Address[]): Promise<FoundDelegation[]>
}
```

#### type `ClientPlans`

Plan builders with the chain state pre-filled from the RPC.

```ts
export interface ClientPlans {
  onboarding(input: Omit<OnboardingInput, 'chainState' | 'programIds' | 'registry'>): Promise<Plan>
  unwind(input: Omit<UnwindInput, 'chainState' | 'programIds'>): Promise<Plan>
  pause(input: Omit<PauseInput, 'chainState' | 'programIds'>): Promise<Plan>
  resume(input: Omit<PauseInput, 'chainState' | 'programIds'>): Promise<Plan>
  revokePermission(input: Omit<RevokePermissionInput, 'chainState' | 'programIds'>): Promise<Plan>
  /** Take one (or a few) discriminators away from a permission, keeping the rest and the budget. */
  revokeDiscriminator(
    input: Omit<RevokeDiscriminatorInput, 'chainState' | 'programIds'>,
  ): Promise<Plan>
  updateLimits(input: Omit<UpdateLimitsInput, 'chainState' | 'programIds'>): Promise<Plan>
  closePolicy(input: Omit<ClosePolicyInput, 'chainState' | 'programIds'>): Promise<Plan>
  reinitPolicy(input: Omit<ReinitPolicyInput, 'chainState' | 'programIds'>): Promise<Plan>
}
```

#### type `CreateClientOptions`

Options of `createClient`.

```ts
export interface CreateClientOptions {
  /** Cluster preset. Default `"devnet"`. Ignored for the RPC when `rpc` or `rpcUrl` is given. */
  readonly cluster?: Cluster
  /** Your own RPC (for example `createSolanaRpc(url)`). */
  readonly rpc?: AgentAuthRpc
  /** RPC URL to build a Kit RPC from. */
  readonly rpcUrl?: string
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
  /** Registry for names and risk classes (the built-in table is the fallback). */
  readonly registry?: RegistryLike | null
  /** Accept version-0 (pre-hardening) mandates. Default false. */
  readonly acceptLegacyMandates?: boolean
  /**
   * Commitment for every read. Default `"confirmed"` (a dashboard that just confirmed a transaction
   * sees its effect; `finalized` lags about 13 seconds).
   */
  readonly commitment?: Exclude<Commitment, 'processed'>
  /**
   * AgentAuth and the relay are deployed on devnet only. `cluster: 'mainnet-beta'` throws
   * `NOT_DEPLOYED` unless both program ids are overridden or this is set to true.
   */
  readonly acknowledgeNoMainnet?: boolean
}
```

<details><summary><code>FoundDelegation</code> - A delegation found by `Client.findDelegationsTo`.</summary>

```ts
export interface FoundDelegation {
  readonly address: Address
  readonly tokenProgram: Address
  readonly delegate: Address
  readonly delegatedAmount: bigint
  readonly mint: Address
}
```
</details>

<details><summary><code>InspectOptions</code> - Options of `Client.inspect`.</summary>

```ts
export interface InspectOptions extends Pick<ExplainOptions, 'budgetDecimals' | 'budgetSymbol' | 'mintLabels' | 'now'> {
  /** An already-fetched mandate (skips refetching it). */
  readonly mandate?: Mandate
}
```
</details>

#### type `MandateView`

A mandate with its related accounts, as `inspect` returns it.

```ts
export interface MandateView {
  readonly address: Address
  readonly mandate: Mandate | null
  readonly policy: RelayPolicy | null
  readonly explanation: Explanation | null
  /** Live SPL delegation on the policy source account, when a policy exists. */
  readonly delegation: { delegate: Address | null; delegatedAmount: bigint } | null
  /** Source account balance (raw units) when it could be read. */
  readonly balance: bigint | null
  /** Structured relay capacity, when a policy exists. */
  readonly capacity: Capacity | null
}
```

## Re-exported Kit types

### Types in this group

- `Address`: re-exported from `@solana/kit`

- `Instruction`: re-exported from `@solana/kit`

- `TransactionSigner`: re-exported from `@solana/kit`

## Consumer recipes

Ten verified snippets. Imports are from the package root; everything else is the code under test.

### Recipe 1: CLI: create a mandate from string inputs

```ts
import type { KeyPairSigner } from '@solana/kit'
import { TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC, createClient, expiresIn, parseAddress, parseLimitInput, parseUnits } from '@agentauth-sol/sdk'

/** 1. CLI: `agentauth create-mandate` - string inputs in, signed and confirmed transactions out. */
export async function cliCreateMandate(args: {
  owner: KeyPairSigner
  agent: string
  mint: string
  source: string
  recipients: string[]
  max: string // "250" tokens, or "unlimited"
  perTx: string // "25"
  cap: string // SPL delegation cap in tokens, e.g. "250"
  lifetime: string // "7d"
}): Promise<string[]> {
  const client = createClient({ cluster: 'devnet' })
  const mint = parseAddress(args.mint)
  const mintInfo = await client.fetchMint(mint)
  if (!mintInfo) throw new Error(`mint ${args.mint} does not exist`)
  const decimals = mintInfo.decimals

  const plan = await client.plan.onboarding({
    owner: args.owner,
    agent: parseAddress(args.agent),
    expiry: expiresIn(args.lifetime), // unix SECONDS, never milliseconds
    fundAgentLamports: 5_000_000n, // 0.005 SOL for the agent's fees
    token: { mint, source: parseAddress(args.source), delegateCap: parseUnits(args.cap, decimals) },
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: parseLimitInput(args.max, decimals),
        perTxLimit: parseLimitInput(args.perTx, decimals),
        discriminators: [TRANSFER_CHECKED_DISC],
      },
    ],
    recipients: args.recipients.map(parseAddress), // token ACCOUNTS, not wallets
  })
  console.log(plan.summary, plan.warnings) // PlanRefusedError is thrown for unsafe input

  const signatures: string[] = []
  for (const step of plan.steps) {
    // Steps run in order; each sendAndConfirm returns only once its step is confirmed, which is
    // what step N+1 (`dependsOn: [N]`) needs.
    const res = await client.sendAndConfirm(step, { signers: [args.owner] })
    if (!res.ok) throw res.error ?? new Error(`step "${step.label}" failed`)
    signatures.push(res.signature)
  }
  return signatures
}
```

### Recipe 2: MCP owner profile: unsigned transactions for a wallet

```ts
import type { Address } from '@solana/kit'
import { planToUnsignedTransactions, toJsonSafe, type Client } from '@agentauth-sol/sdk'

/** 2. MCP owner profile: a plan as unsigned base64 transactions + a JSON-safe summary. */
export async function mcpOwnerPlan(client: Client, owner: Address, agent: Address) {
  const plan = await client.plan.pause({ owner, agent }) // reads chain state itself
  const { value: blockhash } = await client.rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send()
  const transactions = planToUnsignedTransactions(plan, {
    feePayer: owner,
    blockhash,
    computeUnitLimit: 200_000,
    microLamportsPerCu: 20_000n, // priority fee
  })
  return toJsonSafe({
    summary: plan.summary,
    warnings: plan.warnings,
    transactions: transactions.map((t) => ({
      label: t.label,
      base64: t.base64, // hand to the wallet to sign
      requiredSigners: t.requiredSigners,
      dependsOn: t.dependsOn, // submit only after these step indexes are confirmed
      awaitConfirmation: t.awaitConfirmation,
    })),
  })
}
```

### Recipe 3: MCP agent profile: relay transfer with pre-flight

```ts
import type { Address, KeyPairSigner } from '@solana/kit'
import { mandatePda, preflightFailureToError, relayTransferIx, toJsonSafe, type Client } from '@agentauth-sol/sdk'

/** 3. MCP agent profile: relay transfer with a pre-flight that explains a denial. */
export async function mcpAgentPay(
  client: Client,
  agent: KeyPairSigner,
  owner: Address,
  destination: Address,
  amount: bigint, // raw units
) {
  // Pre-flight against live chain data and the CLUSTER clock (no transaction, no fee).
  const pre = await client.preflightTransfer({ owner, agent: agent.address, destination, amount })
  if (!pre.ok) {
    const error = preflightFailureToError(pre) // same shape as an on-chain failure
    return { sent: false as const, error: toJsonSafe(error) }
  }
  const mandate = (await mandatePda(owner, agent.address)).address
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('no relay policy')
  const ix = await relayTransferIx({ agent, policy, destination, amount })
  const res = await client.sendAndConfirm([ix], { signers: [agent], computeUnitLimit: 200_000 })
  return res.ok
    ? { sent: true as const, signature: res.signature }
    : { sent: true as const, signature: res.signature, error: toJsonSafe(res.error) }
}
```

### Recipe 4: MCP agent profile: capacity, trusted owners, explain a denial

```ts
import type { Address } from '@solana/kit'
import { parseProgramError, toJsonSafe, type Client } from '@agentauth-sol/sdk'

/** 4. MCP agent profile: "what may I do?" and "why was I denied?". */
export async function mcpAgentStatus(client: Client, agent: Address, trustedOwners: Address[]) {
  // Anybody can create a mandate naming your agent: only trust owners you know.
  const mandates = await client.mandatesByAgent(agent, { owners: trustedOwners, limit: 20 })
  const rows = []
  for (const m of mandates) {
    const c = await client.capacityFor(m.owner, agent)
    rows.push({
      owner: m.owner,
      maxSpendNow: c.maxSpendNow, // raw units; bigint becomes a string via toJsonSafe
      limitedBy: c.limitedBy, // 'per_call_limit' | 'mandate_budget' | 'delegation' | 'balance'
      blockedBy: c.blockedBy, // { program, code, name, why } or null
    })
  }
  return toJsonSafe(rows)
}

/** Explain any failure (simulation logs, Kit error, TransactionError) to the agent. */
export function explainDenial(failure: unknown) {
  const e = parseProgramError(failure)
  return e
    ? { what: `${e.program}:${e.name}`, why: e.message, fix: e.hint, retryable: e.retryable }
    : { what: 'unknown', why: String(failure), fix: 'inspect the logs', retryable: false }
}
```

### Recipe 5: Dashboard: the mandate page in one call

```ts
import type { Address } from '@solana/kit'
import { type Client } from '@agentauth-sol/sdk'

/** 5. Dashboard: one call for the whole mandate page (3 RPC round trips at most). */
export async function dashboardMandateView(client: Client, mandateAddress: Address) {
  const view = await client.inspect(mandateAddress) // mint decimals and cluster time are read for you
  if (!view.mandate || !view.explanation) return null
  return {
    headline: view.explanation.headline,
    can: view.explanation.can, // already cross-checked against the policy and the live delegation
    cannot: view.explanation.cannot,
    enforcement: view.explanation.enforcement, // 'hard (relay)' vs 'advisory (...)'
    warnings: view.explanation.warnings,
    capacity: view.capacity, // structured numbers for gauges
  }
}
```

### Recipe 6: Dashboard: live activity feed

```ts
import type { Address } from '@solana/kit'
import { type ActivityItem, type Client } from '@agentauth-sol/sdk'

/** 6. Dashboard: live activity feed that only fetches what is new. */
export function createActivityFeed(client: Client, mandate: Address, policy: Address) {
  const cache = new Map<string, ActivityItem[]>() // confirmed transactions are immutable
  let newest: string | undefined
  let rows: ActivityItem[] = []
  return {
    /** Call every few seconds. Returns all rows, newest first. */
    async poll(): Promise<ActivityItem[]> {
      const page = await client.activityPage({
        mandate,
        policy,
        limit: 50,
        until: newest, // only signatures newer than the last poll
        cache,
      })
      if (page.items.length > 0) {
        newest = page.items[0]!.signature
        rows = [...page.items, ...rows]
      }
      return rows
    },
    /** "Load more": older history with the cursor. */
    async older(before: string): Promise<ActivityItem[]> {
      const page = await client.activityPage({ mandate, policy, limit: 50, before, cache })
      return page.items // page.nextBefore is the next cursor, or null at the end
    },
  }
  // Each row: kind, ok, amount, recipient, error (decoded), feePayer, signers, and `viaProgram` for
  // verify calls made by another program (CPI). `fetchError` marks a row whose fetch failed.
}
```

### Recipe 7: Per-instruction revoke

```ts
import type { Address, KeyPairSigner } from '@solana/kit'
import { TRANSFER_CHECKED_DISC, planToJson, type Client } from '@agentauth-sol/sdk'

/** 7. Per-instruction revoke: take ONE discriminator away, keep the rest and the budget. */
export async function revokeOneInstruction(
  client: Client,
  owner: KeyPairSigner,
  agent: Address,
  program: Address,
  discriminatorHex: string, // 16 hex chars, e.g. TRANSFER_CHECKED_DISC
) {
  const plan = await client.plan.revokeDiscriminator({
    owner,
    agent,
    program,
    discriminators: [discriminatorHex],
  })
  // Nothing left? It became a plain remove_permission. A paused mandate is resumed, edited and
  // re-paused inside the same transaction. Show planToJson(plan) for review, then send:
  const res = await client.sendAndConfirm(plan.steps[0]!, { signers: [owner] })
  return { ok: res.ok, preview: planToJson(plan), error: res.error }
}
```

### Recipe 8: One-step kill switch (unwind)

```ts
import type { Address, KeyPairSigner } from '@solana/kit'
import { type Client } from '@agentauth-sol/sdk'

/** 8. The kill switch: one transaction, priority fee, decoded result. */
export async function killSwitch(client: Client, owner: KeyPairSigner, agent: Address) {
  // Reads the chain: revokes the SPL delegation (also after the policy is gone), revoke_mandate,
  // close_policy. If the chain state cannot be read the plan is split so the kill switch is alone.
  const plan = await client.plan.unwind({ owner, agent })
  const results = []
  for (const step of plan.steps) {
    results.push(
      await client.sendAndConfirm(step, {
        signers: [owner],
        computeUnitLimit: 100_000,
        microLamportsPerCu: 200_000n, // pay up: this must land
        commitment: 'confirmed',
      }),
    )
  }
  return { summary: plan.summary, results }
}
```

### Recipe 9: Seller-side authorisation check

```ts
import type { Address } from '@solana/kit'
import { assertMandateAuthorises, type Client } from '@agentauth-sol/sdk'

/** 9. Seller-side authorisation check (advisory pre-check; your program still calls verify). */
export async function sellerCheck(
  client: Client,
  trustedOwner: Address, // the wallet that owns THIS asset: never take it from the request
  agent: Address,
  targetProgram: Address,
  discriminator: string,
  amount: bigint,
) {
  const { mandate } = await client.fetchMandateFor(trustedOwner, agent)
  const now = await client.getClusterTime()
  const r = assertMandateAuthorises(mandate, {
    expectedOwner: trustedOwner,
    agent,
    targetProgram,
    discriminator,
    amount,
    now,
  })
  // An off-chain read cannot reserve budget: two sellers can both pass this and the second
  // on-chain verify can still fail. Treat `ok` as "likely", never as "paid".
  return r.ok ? { allow: true } : { allow: false, name: r.error.name, hint: r.error.hint }
}
```

### Recipe 10: Attack simulator: a blocked attempt that lands on chain

```ts
import type { Address, KeyPairSigner } from '@solana/kit'
import { mandatePda, relayTransferIx, type Client } from '@agentauth-sol/sdk'

/** 10. Attack simulator: let a blocked attempt land on chain so it shows in the feed. */
export async function blockedAttempt(
  client: Client,
  agent: KeyPairSigner,
  owner: Address,
  attackerTokenAccount: Address,
  amount: bigint,
) {
  const mandate = (await mandatePda(owner, agent.address)).address
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('no relay policy')
  const ix = await relayTransferIx({ agent, policy, destination: attackerTokenAccount, amount })
  const res = await client.sendAndConfirm([ix], { signers: [agent], skipPreflight: true })
  // res.ok === false; res.error is e.g. relay:104 RecipientNotAllowed (decoded from the logs).
  return { signature: res.signature, landed: true, ok: res.ok, error: res.error?.describe() }
}
```

## What the SDK does not do

- It never signs with a key it was not handed, never stores keys, and never sends anything you did not ask it to (`sendAndConfirm`/`sendAndConfirmStep` are explicit).
- The pre-flight mirrors (`checkVerify`, `checkRelayTransfer`, `checkRelaySwap`) model the programs' check ORDER and arithmetic. They do not model the AMM, the post-CPI balance deltas (106/112/119), compute limits, or races with other transactions. The cluster decides.
- `explainMandate`, `capacity` and `inspect` describe one moment of chain state. An off-chain read cannot reserve budget.
- It does not make `verify` mandatory: a program that never calls `verify` is not bound by any mandate. Only the relay's two typed actions are hard-enforced.
- `@agentauth-sol/registry` is optional: pass it to `createClient({ registry })` (or use `loadRegistry()`); the built-in table only covers SPL Token, Token-2022, System (value/authority rows), the Raydium CP-Swap ABI, the mock AMM and gated-example.
