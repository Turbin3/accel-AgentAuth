import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index'
import {
  DEFAULT_AMM_ALLOWLIST,
  DEFAULT_DENY_RISKS,
  MANDATE_DISCRIMINATOR,
  MANDATE_VERSION,
  MOCK_AMM_ERRORS,
  MOCK_AMM_PROGRAM_ID,
  POLICY_DISCRIMINATOR,
  POLICY_FLAG_PAUSED,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  POLICY_VERSION,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  SYSTEM_ERRORS,
  SYSTEM_PROGRAM_ID,
  U64_MAX,
  ZERO_ADDRESS,
  ValidationError,
  assertValidRelayPolicyConfig,
  fetchRawAccount,
  parseDisc,
  parseDiscList,
  parseLimit,
  TOKEN_PROGRAM_ID,
  type AccountsRpc,
} from '../src/index'
import { fakeAddress, raw, readIdl } from './helpers'

describe('public surface (the CLI, MCP server, dashboard and demo build against these names)', () => {
  const required = [
    // A constants
    'AGENT_AUTH_PROGRAM_ID',
    'RELAY_PROGRAM_ID',
    'MOCK_AMM_PROGRAM_ID',
    'GATED_EXAMPLE_PROGRAM_ID',
    'TOKEN_PROGRAM_ID',
    'TOKEN_2022_PROGRAM_ID',
    'SYSTEM_PROGRAM_ID',
    'RAYDIUM_CPMM_DEVNET_PROGRAM_ID',
    'RAYDIUM_CPMM_MAINNET_PROGRAM_ID',
    'TRANSFER_CHECKED_DISC',
    'SWAP_BASE_INPUT_DISC',
    'ACCOUNT_SIZE',
    'MAX_PERMISSIONS',
    'MAX_DISCRIMINATORS',
    'POLICY_SIZE',
    'CLUSTER_RPC_URLS',
    'programIds',
    // B pda
    'mandatePda',
    'relayPolicyPda',
    'relayAuthorityPda',
    'associatedTokenAddress',
    // C accounts
    'decodeMandate',
    'decodeRelayPolicy',
    'fetchMandate',
    'fetchRelayPolicy',
    'fetchMandatesByOwner',
    'fetchMandatesByAgent',
    'encodeRelayPolicyConfig',
    'encodeInitPolicyData',
    // D core builders
    'createMandateIx',
    'addPermissionIx',
    'removePermissionIx',
    'updatePermissionIx',
    'setActiveIx',
    'revokeMandateIx',
    'verifyIx',
    // E relay builders + token helpers
    'initPolicyIx',
    'setPausedIx',
    'closePolicyIx',
    'relayTransferIx',
    'relaySwapIx',
    'approveIx',
    'revokeDelegateIx',
    'transferCheckedIx',
    'createAtaIdempotentIx',
    // F errors
    'AgentAuthError',
    'parseProgramError',
    // G pre-flight
    'checkVerify',
    'checkRelayTransfer',
    'checkRelaySwap',
    // H units
    'parseUnits',
    'formatUnits',
    // I explain
    'explainMandate',
    // J plans
    'planOnboarding',
    'planUnwind',
    'planPause',
    'planResume',
    'planRevokePermission',
    'planUpdateLimits',
    'planClosePolicy',
    'planReinitPolicy',
    // K activity
    'getActivity',
    'decodeTransaction',
    // L client
    'createClient',
  ]
  it.each(required)('%s is exported', (name) => {
    expect(name in sdk, name).toBe(true)
  })
})

describe('small exports', () => {
  it('layout and flag constants', () => {
    expect([
      MANDATE_DISCRIMINATOR,
      MANDATE_VERSION,
      POLICY_DISCRIMINATOR,
      POLICY_VERSION,
      POLICY_FLAG_PAUSED,
      POLICY_FLAG_STRICT_TOP_LEVEL,
    ]).toEqual([1, 1, 0xa7, 1, 1, 2])
    expect(readIdl('relay-idl').constants.policy.disc).toBe(POLICY_DISCRIMINATOR)
    expect(readIdl('relay-idl').constants.policy.flags).toEqual({
      PAUSED: POLICY_FLAG_PAUSED,
      STRICT_TOP_LEVEL: POLICY_FLAG_STRICT_TOP_LEVEL,
    })
    expect(readIdl('core-idl').constants.currentVersion).toBe(MANDATE_VERSION)
    expect(U64_MAX).toBe(18446744073709551615n)
    expect(ZERO_ADDRESS).toBe(SYSTEM_PROGRAM_ID)
    expect(raw(ZERO_ADDRESS)).toEqual(new Uint8Array(32))
  })
  it('default AMM allowlist = Raydium devnet + mainnet + mock', () => {
    expect([...DEFAULT_AMM_ALLOWLIST].sort()).toEqual(
      [MOCK_AMM_PROGRAM_ID, RAYDIUM_CPMM_DEVNET_PROGRAM_ID, RAYDIUM_CPMM_MAINNET_PROGRAM_ID].sort(),
    )
  })
  it('default-deny risk classes', () => {
    expect([...DEFAULT_DENY_RISKS].sort()).toEqual(['account_close', 'admin', 'authority_change'])
  })
  it('error tables for the test programs', () => {
    expect(MOCK_AMM_ERRORS.map((e) => e.code)).toEqual([7001, 7002, 7003, 7004, 7005])
    expect(SYSTEM_ERRORS[0]?.name).toBe('AccountAlreadyInUse')
  })
  it('parseLimit', () => {
    expect(parseLimit('unlimited', 'x')).toBe(0n)
    expect(parseLimit(7n, 'x')).toBe(7n)
    expect(() => parseLimit(0n, 'x')).toThrow(/UNLIMITED/)
    expect(() => parseLimit(-1n, 'x')).toThrow(ValidationError)
    expect(() => parseLimit('0' as never, 'x')).toThrow(ValidationError)
  })
  it('parseDisc / parseDiscList', () => {
    expect([...parseDisc('0c00000000000000')]).toEqual([12, 0, 0, 0, 0, 0, 0, 0])
    expect(() => parseDisc('0c')).toThrow(ValidationError)
    expect(parseDiscList(['0100000000000000', new Uint8Array(8)])).toHaveLength(2)
    expect(() => parseDiscList([])).toThrow(ValidationError)
  })
  it('assertValidRelayPolicyConfig throws a 113-coded error listing every problem', () => {
    const bad = {
      tokenProgram: fakeAddress(1),
      budgetMint: ZERO_ADDRESS,
      sourceAccount: ZERO_ADDRESS,
      recipients: [],
      swap: null,
    }
    try {
      assertValidRelayPolicyConfig(bad)
      throw new Error('no throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).relayCode).toBe(113)
      expect((e as ValidationError).message).toMatch(/tokenProgram.*budgetMint.*sourceAccount/)
    }
    expect(() => assertValidRelayPolicyConfig(bad, {}, { skipValidation: true })).not.toThrow()
    expect(() =>
      assertValidRelayPolicyConfig({
        tokenProgram: TOKEN_PROGRAM_ID,
        budgetMint: fakeAddress(2),
        sourceAccount: fakeAddress(3),
        recipients: [],
        swap: null,
      }),
    ).not.toThrow()
  })
  it('fetchRawAccount returns bytes, owner and lamports as bigint', async () => {
    const rpc = {
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            owner: TOKEN_PROGRAM_ID,
            data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'],
            lamports: 5n,
            executable: false,
          },
        }),
      }),
    } as unknown as AccountsRpc
    const acc = await fetchRawAccount(rpc, fakeAddress(1))
    expect(acc).toMatchObject({
      address: fakeAddress(1),
      ownerProgram: TOKEN_PROGRAM_ID,
      lamports: 5n,
      executable: false,
    })
    expect([...acc!.data]).toEqual([1, 2, 3])
  })
})
