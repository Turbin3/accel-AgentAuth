import { describe, expect, it } from 'vitest'
import { address } from '@solana/kit'
import {
  ACCOUNT_SIZE,
  AGENT_AUTH_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLUSTER_RPC_URLS,
  GATED_ACTION_DISC,
  GATED_EXAMPLE_PROGRAM_ID,
  HEADER_SIZE,
  INIT_POLICY_DATA_SIZE,
  MAX_DEADLINE_SLOTS_CAP,
  MAX_DISCRIMINATORS,
  MAX_PERMISSIONS,
  MAX_RECIPIENTS,
  MAX_TRANSACTION_SIZE,
  MOCK_AMM_PROGRAM_ID,
  NATIVE_MINT,
  PERMISSION_SIZE,
  POLICY_CONFIG_OFFSET,
  POLICY_CONFIG_SIZE,
  POLICY_SIZE,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  SYSTEM_PROGRAM_ID,
  SdkError,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  ValidationError,
  associatedTokenAddress,
  bytesEqual,
  concatBytes,
  createClient,
  encodePolicyFlags,
  estimateTransactionSize,
  fitsInOneTransaction,
  fromHex,
  isDeployedOn,
  mandatePda,
  parseAddress,
  programIds,
  readI64,
  readU64,
  relayAuthorityPda,
  relayPolicyPda,
  toHex,
  u64ToLe,
  i64ToLe,
  validateRelayPolicyConfig,
  systemTransferIx,
  loadRegistry,
  builtinRegistry,
  describeInstruction,
  type AgentAuthRpc,
  type RelayPolicyConfig,
} from '../src/index'
import { readIdl, fakeAddress } from './helpers'

describe('constants match the IDLs', () => {
  const core = readIdl('core-idl')
  const relay = readIdl('relay-idl')
  it('layout constants', () => {
    expect([
      ACCOUNT_SIZE,
      HEADER_SIZE,
      PERMISSION_SIZE,
      MAX_PERMISSIONS,
      MAX_DISCRIMINATORS,
    ]).toEqual([
      core.constants.accountSize,
      core.constants.headerSize,
      core.constants.permissionSize,
      core.constants.maxPermissions,
      core.constants.maxDiscriminators,
    ])
    const p = relay.constants.policy
    expect([
      POLICY_SIZE,
      POLICY_CONFIG_OFFSET,
      POLICY_CONFIG_SIZE,
      INIT_POLICY_DATA_SIZE,
      MAX_RECIPIENTS,
      MAX_DEADLINE_SLOTS_CAP,
    ]).toEqual([
      p.size,
      p.configOffset,
      p.configLength,
      p.initDataLength,
      p.maxRecipients,
      p.maxDeadlineSlotsCap,
    ])
    expect(POLICY_SIZE).toBe(944)
    expect(ACCOUNT_SIZE).toBe(2136)
    expect(MAX_TRANSACTION_SIZE).toBe(relay.constants.limits.maxTxBytes)
  })
  it('program ids and discriminators', () => {
    const c = relay.constants
    expect(TOKEN_PROGRAM_ID).toBe(c.programIds.token)
    expect(TOKEN_2022_PROGRAM_ID).toBe(c.programIds.token2022)
    expect(SYSTEM_PROGRAM_ID).toBe(c.programIds.system)
    expect(NATIVE_MINT).toBe(c.programIds.nativeMint)
    expect(AGENT_AUTH_PROGRAM_ID).toBe(c.programIds.agentAuth)
    expect(RAYDIUM_CPMM_MAINNET_PROGRAM_ID).toBe(c.programIds.raydiumCpmmMainnet)
    expect(RAYDIUM_CPMM_DEVNET_PROGRAM_ID).toBe(c.programIds.raydiumCpmmDevnet)
    expect(RELAY_PROGRAM_ID).toBe(relay.addresses.agent_auth_relay.devnet)
    expect(MOCK_AMM_PROGRAM_ID).toBe(relay.addresses.mock_amm.devnet)
    expect(GATED_EXAMPLE_PROGRAM_ID).toBe(relay.addresses.gated_example.devnet)
    expect(TRANSFER_CHECKED_DISC).toBe(c.discriminators.transferChecked)
    expect(SWAP_BASE_INPUT_DISC).toBe(c.discriminators.raydiumSwapBaseInput)
    expect(GATED_ACTION_DISC).toBe(c.discriminators.gatedExampleGatedAction)
    expect(ASSOCIATED_TOKEN_PROGRAM_ID).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  })
})

describe('programIds(cluster) and presets', () => {
  it('returns the documented ids and picks the cluster-specific Raydium id', () => {
    expect(programIds('devnet').agentAuth).toBe(AGENT_AUTH_PROGRAM_ID)
    expect(programIds('devnet').raydiumCpmm).toBe(RAYDIUM_CPMM_DEVNET_PROGRAM_ID)
    expect(programIds('mainnet-beta').raydiumCpmm).toBe(RAYDIUM_CPMM_MAINNET_PROGRAM_ID)
    expect(programIds('localnet').relay).toBe(RELAY_PROGRAM_ID)
  })
  it('overrides are per call and never mutate the defaults', () => {
    const local = fakeAddress(9)
    expect(programIds('localnet', { relay: local }).relay).toBe(local)
    expect(programIds('localnet').relay).toBe(RELAY_PROGRAM_ID)
  })
  it('RPC presets and deployment status', () => {
    expect(CLUSTER_RPC_URLS.localnet).toBe('http://127.0.0.1:8899')
    expect(CLUSTER_RPC_URLS.devnet).toBe('https://api.devnet.solana.com')
    expect(CLUSTER_RPC_URLS['mainnet-beta']).toBe('https://api.mainnet-beta.solana.com')
    expect(isDeployedOn('devnet')).toBe(true)
    expect(isDeployedOn('mainnet-beta')).toBe(false)
  })
})

describe('PDAs against vectors computed with `solana find-program-derived-address` (Rust implementation)', () => {
  const owner = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z')
  const agent = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLaPSpXJ3b6Ax')
  it('mandate, policy, authority', async () => {
    const m = await mandatePda(owner, agent)
    expect(m.address).toBe('A7DFWgbhiY23cnE5eoBwPvsHC9Esvi6nmVzvGtuizQt5')
    expect((await relayPolicyPda(m.address)).address).toBe(
      'E9ebEddwXFLC6HnB7kfiHsu4KBE9QruuyRZotmKEPeUg',
    )
    expect((await relayAuthorityPda(m.address)).address).toBe(
      'BqCBQypXX1nTz58DPm3D87A7iFBt6BQ87HwnxR1kdFYH',
    )
    expect(m.bump).toBeGreaterThanOrEqual(0)
    expect(m.bump).toBeLessThanOrEqual(255)
  })
  it('associated token address (USDC mint, classic Token)', async () => {
    const usdc = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect((await associatedTokenAddress(owner, usdc, TOKEN_PROGRAM_ID)).address).toBe(
      'D1WrEzar4cqDCQjRFBeqHe7hpDDdP63bgwKCcaFSm4ED',
    )
  })
  it('swapping owner and agent changes the mandate address', async () => {
    expect((await mandatePda(agent, owner)).address).not.toBe(
      (await mandatePda(owner, agent)).address,
    )
  })
})

describe('bytes helpers', () => {
  it('hex round trip and strictness', () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe('000fff')
    expect([...fromHex('0x000FFF')]).toEqual([0, 15, 255])
    expect(() => fromHex('abc')).toThrow(ValidationError)
    expect(() => fromHex('zz')).toThrow(ValidationError)
    expect(() => fromHex('00', 2)).toThrow(/expected 2 bytes/)
  })
  it('u64 / i64 little endian with range checks', () => {
    expect(toHex(u64ToLe(1n))).toBe('0100000000000000')
    expect(readU64(u64ToLe(2n ** 64n - 1n), 0)).toBe(2n ** 64n - 1n)
    expect(() => u64ToLe(-1n)).toThrow(ValidationError)
    expect(() => u64ToLe(2n ** 64n)).toThrow(ValidationError)
    expect(() => u64ToLe(1 as unknown as bigint)).toThrow(ValidationError)
    expect(readI64(i64ToLe(-1n), 0)).toBe(-1n)
    expect(() => i64ToLe(2n ** 63n)).toThrow(ValidationError)
  })
  it('concat and equality', () => {
    expect(toHex(concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3)))).toBe('010203')
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1))).toBe(true)
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(2))).toBe(false)
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 1))).toBe(false)
  })
})

describe('policy config validation (RELAY-SPEC 5.2)', () => {
  const swapBase = {
    ammProgram: MOCK_AMM_PROGRAM_ID,
    ammAuthority: fakeAddress(0x72),
    ammConfig: fakeAddress(0x73),
    poolState: fakeAddress(0x74),
    inputVault: fakeAddress(0x75),
    outputVault: fakeAddress(0x76),
    observationState: fakeAddress(0x77),
    inMint: fakeAddress(0x55),
    outMint: fakeAddress(0x79),
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    inAccount: fakeAddress(0x66),
    outAccount: fakeAddress(0x7a),
    floorOut: 95n,
    floorIn: 100n,
    maxDeadlineSlots: 150,
  }
  const base: RelayPolicyConfig = {
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: fakeAddress(0x55),
    sourceAccount: fakeAddress(0x66),
    recipients: [fakeAddress(0x61)],
    swap: swapBase,
  }
  const problems = (c: RelayPolicyConfig, ctx = {}): string =>
    validateRelayPolicyConfig(c, ctx).join(' | ')

  it('a sound config (including in_account == source with matching mint) is valid', () => {
    expect(validateRelayPolicyConfig(base)).toEqual([])
  })
  it('swap rules', () => {
    const s = (over: object): RelayPolicyConfig => ({ ...base, swap: { ...swapBase, ...over } })
    expect(problems(s({ ammProgram: fakeAddress(1) }))).toMatch(/allowlist/)
    expect(problems(s({ inputVault: swapBase.outputVault }))).toMatch(
      /inputVault must differ from outputVault/,
    )
    expect(problems(s({ inMint: NATIVE_MINT }))).toMatch(/native/)
    expect(problems(s({ outMint: swapBase.inMint }))).toMatch(/inMint must differ from outMint/)
    expect(problems(s({ floorOut: 0n }))).toMatch(/floorOut/)
    expect(problems(s({ floorIn: 0n }))).toMatch(/floorIn/)
    expect(problems(s({ maxDeadlineSlots: 0 }))).toMatch(/maxDeadlineSlots/)
    expect(problems(s({ maxDeadlineSlots: 9001 }))).toMatch(/maxDeadlineSlots/)
    expect(validateRelayPolicyConfig(s({ maxDeadlineSlots: 9000 }))).toEqual([])
    expect(problems(s({ inTokenProgram: fakeAddress(2) }))).toMatch(/inTokenProgram/)
    expect(problems(s({ inAccount: fakeAddress(0x66), inMint: fakeAddress(0x42) }))).toMatch(
      /inMint must equal budgetMint/,
    )
    expect(
      problems(s({ inAccount: fakeAddress(0x66), inTokenProgram: TOKEN_2022_PROGRAM_ID })),
    ).toMatch(/inTokenProgram must equal tokenProgram/)
    expect(problems(s({ outAccount: swapBase.inAccount }))).toMatch(/outAccount must differ/)
    expect(problems(s({ ammAuthority: swapBase.poolState }))).toMatch(/different accounts/)
    expect(problems(s({ outAccount: fakeAddress(0x61) }))).toMatch(/different accounts/) // collides with a recipient
  })
  it('a separate in_account is allowed to use a different mint', () => {
    expect(
      validateRelayPolicyConfig({
        ...base,
        swap: { ...swapBase, inAccount: fakeAddress(0x67), inMint: fakeAddress(0x68) },
      }),
    ).toEqual([])
  })
  it('distinctness includes mandate, policy, authority, owner, agent', () => {
    expect(problems(base, { owner: fakeAddress(0x66) })).toMatch(/different accounts/)
    expect(problems(base, { mandate: fakeAddress(0x61) })).toMatch(/different accounts/)
    expect(problems(base, { policy: fakeAddress(0x72) })).toMatch(/different accounts/)
    expect(problems(base, { authority: fakeAddress(0x7a) })).toMatch(/different accounts/)
    expect(problems(base, { owner: fakeAddress(1), agent: fakeAddress(1) })).toMatch(
      /agent must differ from owner/,
    )
  })
  it('mints and token programs are exempt from distinctness', () => {
    expect(
      validateRelayPolicyConfig({ ...base, swap: { ...swapBase, outMint: fakeAddress(0x55 + 1) } }),
    ).toEqual([])
  })
  it('flags: only bits 0 and 1', () => {
    expect(encodePolicyFlags({ paused: true, strictTopLevel: true })).toBe(3)
    expect(encodePolicyFlags({})).toBe(0)
    expect(encodePolicyFlags(2)).toBe(2)
    expect(() => encodePolicyFlags(4)).toThrow(ValidationError)
    expect(() => encodePolicyFlags(256)).toThrow(ValidationError)
    expect(() => encodePolicyFlags(-1)).toThrow(ValidationError)
  })
})

describe('tx-size', () => {
  it('matches the legacy wire format for a trivial transaction', () => {
    const ix = systemTransferIx({ from: fakeAddress(1), to: fakeAddress(2), lamports: 1n })
    // 1 sig count + 64 sig + 3 header + 1 key count + 3*32 keys + 32 blockhash + 1 ix count + (1 + 1 + 2 + 1 + 12)
    expect(estimateTransactionSize([ix], fakeAddress(1))).toBe(1 + 64 + 3 + 1 + 96 + 32 + 1 + 17)
    expect(fitsInOneTransaction([ix], fakeAddress(1))).toBe(true)
  })
})

describe('parseAddress', () => {
  it('accepts valid and rejects invalid', () => {
    expect(parseAddress(TOKEN_PROGRAM_ID)).toBe(TOKEN_PROGRAM_ID)
    expect(() => parseAddress('nope')).toThrow(SdkError)
  })
})

describe('registry fallback', () => {
  it('built-in table names the SPL / swap instructions the relay uses', () => {
    expect(describeInstruction(TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC)).toMatchObject({
      name: 'transfer_checked',
      risk: 'value_out',
      defaultDeny: false,
      known: true,
    })
    expect(describeInstruction(TOKEN_PROGRAM_ID, '0600000000000000')).toMatchObject({
      name: 'set_authority',
      defaultDeny: true,
    })
    expect(describeInstruction(RAYDIUM_CPMM_DEVNET_PROGRAM_ID, SWAP_BASE_INPUT_DISC)).toMatchObject(
      { name: 'swap_base_input', risk: 'value_swap' },
    )
    expect(describeInstruction(fakeAddress(1), '00')).toMatchObject({
      known: false,
      programName: null,
    })
    expect(describeInstruction(TOKEN_PROGRAM_ID, 'ffffffffffffffff')).toMatchObject({
      known: false,
      programName: 'SPL Token',
    })
    expect(builtinRegistry.getProgramById(fakeAddress(1))).toBeNull()
  })
  it('loadRegistry resolves to a registry or null, never throws', async () => {
    const r = await loadRegistry()
    expect(r === null || typeof r.getProgramById === 'function').toBe(true)
  })
})

describe('createClient (stub RPC, no network)', () => {
  const owner = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z')
  const agent = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLaPSpXJ3b6Ax')
  const missingRpc = {
    getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({ value: list.map(() => null) }),
    }),
    getProgramAccounts: () => ({ send: async () => [] }),
    getSlot: () => ({ send: async () => 1n }),
  } as unknown as AgentAuthRpc

  it('three lines: create, fetch, explain', async () => {
    const client = createClient({ rpc: missingRpc })
    const { address: a, mandate } = await client.fetchMandateFor(owner, agent)
    expect(a).toBe('A7DFWgbhiY23cnE5eoBwPvsHC9Esvi6nmVzvGtuizQt5')
    expect(mandate).toBeNull()
    expect(await client.fetchPolicy(a)).toBeNull()
    expect(await client.mandatesByOwner(owner)).toEqual([])
    expect(await client.inspect(a)).toEqual({
      address: a,
      mandate: null,
      policy: null,
      explanation: null,
      delegation: null,
      balance: null,
      capacity: null,
    })
  })

  it('has no global state: two clients with different program ids are independent', async () => {
    const local = fakeAddress(0x42)
    const c1 = createClient({
      rpc: missingRpc,
      cluster: 'localnet',
      programIds: { agentAuth: local },
    })
    const c2 = createClient({ rpc: missingRpc })
    expect(c1.programIds.agentAuth).toBe(local)
    expect(c2.programIds.agentAuth).toBe(AGENT_AUTH_PROGRAM_ID)
    expect((await c1.fetchMandateFor(owner, agent)).address).not.toBe(
      (await c2.fetchMandateFor(owner, agent)).address,
    )
  })

  it('plans get chain state filled in (an unwind with nothing on chain is refused)', async () => {
    const client = createClient({ rpc: missingRpc })
    await expect(client.plan.unwind({ owner, agent })).rejects.toMatchObject({
      code: 'PLAN_REFUSED',
    })
    const pause = await client.plan.pause({ owner, agent })
    expect(pause.steps[0]!.instructions).toHaveLength(1) // policy missing => set_paused skipped, core set_active kept
  })

  it('builds a Kit RPC from a URL without touching the network', () => {
    const client = createClient({ cluster: 'devnet' })
    expect(client.cluster).toBe('devnet')
    expect(typeof client.rpc.getAccountInfo).toBe('function')
  })
})
