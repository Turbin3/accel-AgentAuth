import {
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type Commitment,
  type ReadonlyUint8Array,
} from '@solana/kit'
import {
  bytesToAddress,
  readI64,
  readU16,
  readU32,
  readU64,
  readU8,
  toHex,
  bytesEqual,
} from './bytes'
import {
  ACCOUNT_SIZE,
  HEADER_SIZE,
  MANDATE_DISCRIMINATOR,
  MANDATE_VERSION,
  MAX_DEADLINE_SLOTS_CAP,
  MAX_DISCRIMINATORS,
  MAX_PERMISSIONS,
  MAX_RECIPIENTS,
  PERMISSION_SIZE,
  POLICY_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  POLICY_FLAG_PAUSED,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  POLICY_SIZE,
  POLICY_VERSION,
  programIds as defaultProgramIds,
  type ProgramIds,
} from './constants'
import { mandatePda, relayAuthorityPda, relayPolicyPda } from './pda'
import { DecodeError } from './sdk-errors'
import type {
  AccountsRpc,
  Mandate,
  MultipleAccountsRpc,
  Permission,
  ProgramAccountsRpc,
  RelayPolicy,
  SwapConfig,
} from './types'

/** Options of {@link decodeMandate}. */
export interface DecodeMandateOptions {
  /**
   * Accept accounts written before the hardening (version byte 0). Their layout is identical but
   * `bump` is not stored. Default false: fail closed on unknown versions.
   */
  readonly acceptLegacyVersion?: boolean
}

function addr(bytes: ReadonlyUint8Array, offset: number): Address {
  return bytesToAddress(bytes.subarray(offset, offset + 32))
}

/**
 * Decode a 2136-byte `AgentMandate` account.
 *
 * Strict: the length, discriminator, version, permission count and every slot's discriminator
 * count are validated; nothing is trusted. `active` mirrors the program (`byte == 1`).
 *
 * @param bytes raw account data
 * @param address the account address, copied into the result when given
 * @throws DecodeError `MANDATE_BAD_LENGTH | MANDATE_BAD_DISCRIMINATOR | MANDATE_UNSUPPORTED_VERSION | MANDATE_BAD_PERMISSION_COUNT | MANDATE_BAD_PERMISSION`
 */
export function decodeMandate(
  bytes: ReadonlyUint8Array,
  address?: Address,
  opts: DecodeMandateOptions = {},
): Mandate {
  if (bytes.length !== ACCOUNT_SIZE) {
    throw new DecodeError(
      'MANDATE_BAD_LENGTH',
      `mandate account must be ${ACCOUNT_SIZE} bytes, got ${bytes.length}`,
    )
  }
  if (readU8(bytes, 0) !== MANDATE_DISCRIMINATOR) {
    throw new DecodeError(
      'MANDATE_BAD_DISCRIMINATOR',
      `mandate discriminator must be ${MANDATE_DISCRIMINATOR}, got ${readU8(bytes, 0)}`,
    )
  }
  const version = readU8(bytes, 79)
  const versionOk =
    version === MANDATE_VERSION || (opts.acceptLegacyVersion === true && version === 0)
  if (!versionOk) {
    throw new DecodeError(
      'MANDATE_UNSUPPORTED_VERSION',
      `unsupported mandate version ${version} (supported: ${MANDATE_VERSION}${
        opts.acceptLegacyVersion ? ', legacy 0' : ''
      })`,
    )
  }
  const count = readU16(bytes, 77)
  if (count > MAX_PERMISSIONS) {
    throw new DecodeError(
      'MANDATE_BAD_PERMISSION_COUNT',
      `permissions_len ${count} exceeds the maximum ${MAX_PERMISSIONS}`,
    )
  }
  const permissions: Permission[] = []
  for (let i = 0; i < count; i++) {
    const base = HEADER_SIZE + i * PERMISSION_SIZE
    const discLen = readU8(bytes, base + 60)
    if (discLen > MAX_DISCRIMINATORS) {
      throw new DecodeError(
        'MANDATE_BAD_PERMISSION',
        `permission ${i}: discriminators_len ${discLen} exceeds ${MAX_DISCRIMINATORS}`,
      )
    }
    const discriminators: Uint8Array[] = []
    for (let d = 0; d < discLen; d++) {
      discriminators.push(bytes.slice(base + 64 + d * 8, base + 72 + d * 8))
    }
    const spendLimit = readU64(bytes, base + 32)
    const perTxLimit = readU64(bytes, base + 40)
    permissions.push({
      index: i,
      program: addr(bytes, base),
      spendLimit,
      perTxLimit,
      spendUnlimited: spendLimit === 0n,
      perTxUnlimited: perTxLimit === 0n,
      spendTotal: readU64(bytes, base + 48),
      callCount: readU32(bytes, base + 56),
      discriminators,
      discriminatorsHex: discriminators.map(toHex),
    })
  }
  return {
    address,
    owner: addr(bytes, 1),
    agent: addr(bytes, 33),
    expiry: readI64(bytes, 65),
    active: readU8(bytes, 73) === 1,
    version,
    bump: readU8(bytes, 80),
    permissions,
  }
}

function isAllZero(bytes: ReadonlyUint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false
  return true
}

/**
 * Decode a 944-byte `RelayPolicy` account (RELAY-SPEC section 5.2).
 *
 * Strict: length, discriminator `0xA7`, version, reserved flag bits, `recipients_len <= 8`,
 * `swap_enabled in {0,1}`, canonical zero padding and (when swap is enabled) a sane deadline cap.
 *
 * @throws DecodeError `POLICY_BAD_LENGTH | POLICY_BAD_DISCRIMINATOR | POLICY_UNSUPPORTED_VERSION | POLICY_BAD_FLAGS | POLICY_BAD_CONFIG`
 */
export function decodeRelayPolicy(bytes: ReadonlyUint8Array, address?: Address): RelayPolicy {
  if (bytes.length !== POLICY_SIZE) {
    throw new DecodeError(
      'POLICY_BAD_LENGTH',
      `relay policy must be ${POLICY_SIZE} bytes, got ${bytes.length}`,
    )
  }
  if (readU8(bytes, 0) !== POLICY_DISCRIMINATOR) {
    throw new DecodeError(
      'POLICY_BAD_DISCRIMINATOR',
      `relay policy discriminator must be 0x${POLICY_DISCRIMINATOR.toString(16)}, got 0x${readU8(bytes, 0).toString(16)}`,
    )
  }
  const version = readU8(bytes, 1)
  if (version !== POLICY_VERSION) {
    throw new DecodeError('POLICY_UNSUPPORTED_VERSION', `unsupported policy version ${version}`)
  }
  const flags = readU8(bytes, 4)
  if ((flags & 0xfc) !== 0) {
    throw new DecodeError('POLICY_BAD_FLAGS', `reserved flag bits set: 0x${flags.toString(16)}`)
  }
  const recipientsLen = readU8(bytes, 240)
  if (recipientsLen > MAX_RECIPIENTS) {
    throw new DecodeError(
      'POLICY_BAD_CONFIG',
      `recipients_len ${recipientsLen} exceeds ${MAX_RECIPIENTS}`,
    )
  }
  const swapEnabled = readU8(bytes, 241)
  if (swapEnabled > 1) {
    throw new DecodeError('POLICY_BAD_CONFIG', `swap_enabled must be 0 or 1, got ${swapEnabled}`)
  }
  if (
    !isAllZero(bytes.subarray(5, 8)) ||
    !isAllZero(bytes.subarray(242, 248)) ||
    !isAllZero(bytes.subarray(940, 944))
  ) {
    throw new DecodeError('POLICY_BAD_CONFIG', 'reserved bytes are not zero')
  }
  const recipients: Address[] = []
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    const slot = bytes.subarray(248 + i * 32, 280 + i * 32)
    if (i < recipientsLen) recipients.push(bytesToAddress(slot))
    else if (!isAllZero(slot)) {
      throw new DecodeError(
        'POLICY_BAD_CONFIG',
        `recipient slot ${i} is beyond recipients_len but not zero`,
      )
    }
  }
  let swap: SwapConfig | null = null
  if (swapEnabled === 1) {
    const maxDeadlineSlots = readU32(bytes, 936)
    if (maxDeadlineSlots < 1 || maxDeadlineSlots > MAX_DEADLINE_SLOTS_CAP) {
      throw new DecodeError(
        'POLICY_BAD_CONFIG',
        `max_deadline_slots ${maxDeadlineSlots} out of range`,
      )
    }
    swap = {
      ammProgram: addr(bytes, 504),
      ammAuthority: addr(bytes, 536),
      ammConfig: addr(bytes, 568),
      poolState: addr(bytes, 600),
      inputVault: addr(bytes, 632),
      outputVault: addr(bytes, 664),
      observationState: addr(bytes, 696),
      inMint: addr(bytes, 728),
      outMint: addr(bytes, 760),
      inTokenProgram: addr(bytes, 792),
      outTokenProgram: addr(bytes, 824),
      inAccount: addr(bytes, 856),
      outAccount: addr(bytes, 888),
      floorOut: readU64(bytes, 920),
      floorIn: readU64(bytes, 928),
      maxDeadlineSlots,
    }
  } else if (!isAllZero(bytes.subarray(504, 944))) {
    throw new DecodeError('POLICY_BAD_CONFIG', 'swap disabled but swap config bytes are not zero')
  }
  return {
    address,
    version,
    policyBump: readU8(bytes, 2),
    authorityBump: readU8(bytes, 3),
    flags,
    paused: (flags & POLICY_FLAG_PAUSED) !== 0,
    strictTopLevel: (flags & POLICY_FLAG_STRICT_TOP_LEVEL) !== 0,
    mandate: addr(bytes, 8),
    owner: addr(bytes, 40),
    agent: addr(bytes, 72),
    authority: addr(bytes, 104),
    mandateExpiry: readI64(bytes, 136),
    tokenProgram: addr(bytes, 144),
    budgetMint: addr(bytes, 176),
    sourceAccount: addr(bytes, 208),
    recipients,
    swap,
  }
}

/** Common options of the RPC fetchers. */
export interface FetchOptions {
  readonly commitment?: Commitment
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
  /** Re-derive the PDA and compare address and stored bump. Default true. */
  readonly verifyAddress?: boolean
  /** See {@link DecodeMandateOptions.acceptLegacyVersion}. */
  readonly acceptLegacyVersion?: boolean
  /** Abort signal forwarded to the RPC call. */
  readonly abortSignal?: AbortSignal
}

/** A raw account as the SDK sees it. */
export interface RawAccount {
  readonly address: Address
  readonly ownerProgram: Address
  readonly data: Uint8Array
  readonly lamports: bigint
  readonly executable: boolean
}

function decodeBase64(data: readonly [string, string] | readonly string[]): Uint8Array {
  const b64 = data[0] as string
  return new Uint8Array(getBase64Encoder().encode(b64))
}

/**
 * Fetch one raw account (base64). Returns `null` when it does not exist.
 */
export async function fetchRawAccount(
  rpc: AccountsRpc,
  address: Address,
  opts: Pick<FetchOptions, 'commitment' | 'abortSignal'> = {},
): Promise<RawAccount | null> {
  const res = await rpc
    .getAccountInfo(address, { encoding: 'base64', commitment: opts.commitment })
    .send({ abortSignal: opts.abortSignal })
  const value = res.value
  if (!value) return null
  return {
    address,
    ownerProgram: value.owner,
    data: decodeBase64(value.data),
    lamports: BigInt(value.lamports),
    executable: value.executable,
  }
}

/**
 * True for a system-owned, zero-data account: a PDA address that anyone can pre-fund with lamports
 * (griefing). Such an account is "not created" as far as AgentAuth and the relay are concerned (both
 * programs handle pre-funded PDAs), so the fetchers report it as missing instead of throwing.
 */
export function isDustedEmpty(raw: RawAccount): boolean {
  return raw.ownerProgram === SYSTEM_PROGRAM_ID && raw.data.length === 0
}

/**
 * Fetch many raw accounts in one RPC (`getMultipleAccounts`, base64). Results are in input order;
 * `null` = does not exist. At most 100 addresses per call (the RPC limit); larger inputs are chunked.
 */
export async function fetchRawAccounts(
  rpc: MultipleAccountsRpc,
  addresses: readonly Address[],
  opts: Pick<FetchOptions, 'commitment' | 'abortSignal'> = {},
): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = []
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100)
    const res = await rpc
      .getMultipleAccounts(chunk, { encoding: 'base64', commitment: opts.commitment })
      .send({ abortSignal: opts.abortSignal })
    chunk.forEach((address, j) => {
      const value = res.value[j]
      out.push(
        value
          ? {
              address,
              ownerProgram: value.owner,
              data: decodeBase64(value.data),
              lamports: BigInt(value.lamports),
              executable: value.executable,
            }
          : null,
      )
    })
  }
  return out
}

function idsOf(opts: FetchOptions): ProgramIds {
  return defaultProgramIds('devnet', opts.programIds)
}

async function checkMandateAddress(
  mandate: Mandate,
  address: Address,
  ids: ProgramIds,
): Promise<void> {
  const derived = await mandatePda(mandate.owner, mandate.agent, ids.agentAuth)
  if (derived.address !== address) {
    throw new DecodeError(
      'ADDRESS_MISMATCH',
      `mandate account ${address} is not the PDA of (owner, agent); expected ${derived.address}`,
    )
  }
  if (mandate.version >= 1 && derived.bump !== mandate.bump) {
    throw new DecodeError(
      'ADDRESS_MISMATCH',
      `stored bump ${mandate.bump} differs from the derived bump ${derived.bump}`,
    )
  }
}

/**
 * Decode a mandate from a {@link RawAccount}, checking the owner program and (by default) that the
 * address really is the PDA of its (owner, agent). A forged account that merely *looks* like a
 * mandate is rejected.
 */
export async function decodeMandateAccount(
  account: RawAccount,
  opts: FetchOptions = {},
): Promise<Mandate> {
  const ids = idsOf(opts)
  if (account.ownerProgram !== ids.agentAuth) {
    throw new DecodeError(
      'WRONG_OWNER_PROGRAM',
      `account ${account.address} is owned by ${account.ownerProgram}, not AgentAuth ${ids.agentAuth}`,
    )
  }
  const mandate = decodeMandate(account.data, account.address, opts)
  if (opts.verifyAddress !== false) await checkMandateAddress(mandate, account.address, ids)
  return mandate
}

/**
 * Decode a relay policy from a {@link RawAccount}, checking the owner program and that the address
 * and authority are the PDAs of the mandate recorded inside.
 */
export async function decodeRelayPolicyAccount(
  account: RawAccount,
  opts: FetchOptions = {},
): Promise<RelayPolicy> {
  const ids = idsOf(opts)
  if (account.ownerProgram !== ids.relay) {
    throw new DecodeError(
      'WRONG_OWNER_PROGRAM',
      `account ${account.address} is owned by ${account.ownerProgram}, not the relay ${ids.relay}`,
    )
  }
  const policy = decodeRelayPolicy(account.data, account.address)
  if (opts.verifyAddress !== false) {
    const [pol, auth] = await Promise.all([
      relayPolicyPda(policy.mandate, ids.relay),
      relayAuthorityPda(policy.mandate, ids.relay),
    ])
    if (pol.address !== account.address || pol.bump !== policy.policyBump) {
      throw new DecodeError(
        'ADDRESS_MISMATCH',
        `policy ${account.address} is not the policy PDA of mandate ${policy.mandate}`,
      )
    }
    if (auth.address !== policy.authority || auth.bump !== policy.authorityBump) {
      throw new DecodeError(
        'ADDRESS_MISMATCH',
        `policy authority ${policy.authority} is not the authority PDA of mandate ${policy.mandate}`,
      )
    }
  }
  return policy
}

/**
 * Fetch and decode a mandate. `null` when the account does not exist (never created, or revoked).
 * @throws DecodeError when the account exists but is not a valid mandate for this program.
 */
export async function fetchMandate(
  rpc: AccountsRpc,
  address: Address,
  opts: FetchOptions = {},
): Promise<Mandate | null> {
  const raw = await fetchRawAccount(rpc, address, opts)
  if (!raw || isDustedEmpty(raw)) return null
  return decodeMandateAccount(raw, opts)
}

/**
 * Fetch and decode a relay policy. `null` when the account does not exist.
 * @throws DecodeError when the account exists but is not a valid policy of this relay.
 */
export async function fetchRelayPolicy(
  rpc: AccountsRpc,
  address: Address,
  opts: FetchOptions = {},
): Promise<RelayPolicy | null> {
  const raw = await fetchRawAccount(rpc, address, opts)
  if (!raw || isDustedEmpty(raw)) return null
  return decodeRelayPolicyAccount(raw, opts)
}

/** Options for the `getProgramAccounts` based listings. */
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

async function listMandates(
  rpc: ProgramAccountsRpc,
  offset: bigint,
  key: Address,
  opts: ListOptions,
): Promise<Mandate[]> {
  const ids = idsOf(opts)
  const limit = Math.max(1, Math.floor(opts.limit ?? 1000))
  const owners = opts.owners && opts.owners.length > 0 ? new Set<string>(opts.owners) : null
  const serverOwner = offset === 33n && opts.owners?.length === 1 ? opts.owners[0] : undefined
  const accounts = await rpc
    .getProgramAccounts(ids.agentAuth, {
      encoding: 'base64',
      commitment: opts.commitment,
      filters: [
        { dataSize: BigInt(ACCOUNT_SIZE) },
        { memcmp: { offset, bytes: key as unknown as Base58EncodedBytes, encoding: 'base58' } },
        ...(serverOwner
          ? [
              {
                memcmp: {
                  offset: 1n,
                  bytes: serverOwner as unknown as Base58EncodedBytes,
                  encoding: 'base58' as const,
                },
              },
            ]
          : []),
      ],
    })
    .send({ abortSignal: opts.abortSignal })
  const out: Mandate[] = []
  for (const { pubkey, account } of accounts) {
    if (out.length >= limit) break
    try {
      const decoded = await decodeMandateAccount(
        {
          address: pubkey,
          ownerProgram: account.owner,
          data: decodeBase64(account.data),
          lamports: BigInt(account.lamports),
          executable: account.executable,
        },
        opts,
      )
      if (owners && !owners.has(decoded.owner)) continue
      out.push(decoded.address === pubkey ? decoded : { ...decoded, address: pubkey })
    } catch (error) {
      opts.onSkip?.(pubkey, error)
    }
  }
  return out
}

/**
 * All mandates of an owner (`getProgramAccounts` with `dataSize 2136` and `memcmp` at offset 1).
 * Undecodable accounts are skipped (see `onSkip`).
 */
export function fetchMandatesByOwner(
  rpc: ProgramAccountsRpc,
  owner: Address,
  opts: ListOptions = {},
): Promise<Mandate[]> {
  return listMandates(rpc, 1n, owner, opts)
}

/**
 * All mandates naming an agent (`getProgramAccounts` with `dataSize 2136` and `memcmp` at offset 33).
 * Undecodable accounts are skipped (see `onSkip`).
 */
export function fetchMandatesByAgent(
  rpc: ProgramAccountsRpc,
  agent: Address,
  opts: ListOptions = {},
): Promise<Mandate[]> {
  return listMandates(rpc, 33n, agent, opts)
}

/** Structural equality of two mandates' state (for tests and change detection). */
export function mandatesEqual(a: Mandate, b: Mandate): boolean {
  if (
    a.owner !== b.owner ||
    a.agent !== b.agent ||
    a.expiry !== b.expiry ||
    a.active !== b.active ||
    a.version !== b.version ||
    a.bump !== b.bump ||
    a.permissions.length !== b.permissions.length
  ) {
    return false
  }
  return a.permissions.every((p, i) => {
    const q = b.permissions[i] as Permission
    return (
      p.program === q.program &&
      p.spendLimit === q.spendLimit &&
      p.perTxLimit === q.perTxLimit &&
      p.spendTotal === q.spendTotal &&
      p.callCount === q.callCount &&
      p.discriminators.length === q.discriminators.length &&
      p.discriminators.every((d, j) => bytesEqual(d, q.discriminators[j] as Uint8Array))
    )
  })
}
