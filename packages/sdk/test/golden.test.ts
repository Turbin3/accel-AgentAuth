import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  decodeRelayPolicy,
  encodeInitPolicyData,
  encodeRelayPolicyConfig,
  relaySwapIx,
  relayTransferIx,
  verifyIx,
  type RelayPolicy,
  type RelayPolicyConfig,
} from '../src/index'
import { fakeAddress, fixtureBin, fixtureHex, fixturePath, hex } from './helpers'

// Keys of fixtures/policy_example.json: 32 repeated bytes.
const K = {
  mandate: fakeAddress(0x11),
  owner: fakeAddress(0x22),
  agent: fakeAddress(0x33),
  authority: fakeAddress(0x44),
  budgetMint: fakeAddress(0x55),
  source: fakeAddress(0x66),
  recipient0: fakeAddress(0x61),
}

const goldenConfig: RelayPolicyConfig = {
  tokenProgram: TOKEN_PROGRAM_ID,
  budgetMint: K.budgetMint,
  sourceAccount: K.source,
  recipients: [K.recipient0],
  swap: {
    ammProgram: fakeAddress(0x71),
    ammAuthority: fakeAddress(0x72),
    ammConfig: fakeAddress(0x73),
    poolState: fakeAddress(0x74),
    inputVault: fakeAddress(0x75),
    outputVault: fakeAddress(0x76),
    observationState: fakeAddress(0x77),
    inMint: fakeAddress(0x78),
    outMint: fakeAddress(0x79),
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    inAccount: K.source, // == source_account, as in the vector
    outAccount: fakeAddress(0x7a),
    floorOut: 95n,
    floorIn: 100n,
    maxDeadlineSlots: 150,
  },
}

describe('golden vectors (design/golden, byte for byte)', () => {
  it('init_policy data (802 bytes, flags = STRICT_TOP_LEVEL)', () => {
    const expected = fixtureHex('init_policy_ix_data.hex')
    expect(expected.length).toBe(802)
    // The vector has in_account == source_account but in_mint != budget_mint, which the client-side
    // validator (correctly) rejects, so the golden encoding runs with skipValidation.
    const data = encodeInitPolicyData({ strictTopLevel: true }, goldenConfig, {
      skipValidation: true,
    })
    expect(hex(data)).toBe(hex(expected))
  })

  it('init_policy data: raw flags byte and the 800-byte config region agree', () => {
    const expected = fixtureHex('init_policy_ix_data.hex')
    const config = encodeRelayPolicyConfig(goldenConfig, { skipValidation: true })
    expect(config.length).toBe(800)
    expect(hex(config)).toBe(hex(expected.subarray(2)))
    expect(hex(encodeInitPolicyData(2, goldenConfig, { skipValidation: true }))).toBe(hex(expected))
  })

  it('the golden config is rejected by the validator for the in_mint rule, not for anything else', () => {
    expect(() =>
      encodeRelayPolicyConfig(goldenConfig, { ammAllowlist: [fakeAddress(0x71)] }),
    ).toThrow(/inMint must equal budgetMint/)
  })

  it('the 944-byte policy example decodes to the documented values', () => {
    const bin = fixtureBin('policy_example.bin')
    expect(bin.length).toBe(944)
    const p = decodeRelayPolicy(bin)
    expect(p.version).toBe(1)
    expect(p.policyBump).toBe(254)
    expect(p.authorityBump).toBe(253)
    expect(p.flags).toBe(2)
    expect(p.paused).toBe(false)
    expect(p.strictTopLevel).toBe(true)
    expect(p.mandate).toBe(K.mandate)
    expect(p.owner).toBe(K.owner)
    expect(p.agent).toBe(K.agent)
    expect(p.authority).toBe(K.authority)
    expect(p.mandateExpiry).toBe(1_800_000_000n)
    expect(p.tokenProgram).toBe(TOKEN_PROGRAM_ID)
    expect(p.budgetMint).toBe(K.budgetMint)
    expect(p.sourceAccount).toBe(K.source)
    expect(p.recipients).toEqual([K.recipient0])
    expect(p.swap).toEqual(goldenConfig.swap)
    const json = JSON.parse(readFileSync(fixturePath('policy_example.json'), 'utf8'))
    expect(json.values.max_deadline_slots).toBe(p.swap?.maxDeadlineSlots)
    expect(BigInt(json.values.floor_out)).toBe(p.swap?.floorOut)
    expect(BigInt(json.values.floor_in)).toBe(p.swap?.floorIn)
  })

  it('policy bytes = identity header + the very same config bytes as init_policy data', () => {
    const bin = fixtureBin('policy_example.bin')
    const init = fixtureHex('init_policy_ix_data.hex')
    expect(hex(bin.subarray(144))).toBe(hex(init.subarray(2)))
  })

  it('transfer data (amount 3_000_000)', async () => {
    const policy = decodeRelayPolicy(fixtureBin('policy_example.bin'), fakeAddress(0x99))
    const ix = await relayTransferIx({
      agent: K.agent,
      amount: 3_000_000n,
      destination: K.recipient0,
      policy,
    })
    expect(hex(ix.data)).toBe(hex(fixtureHex('transfer_ix_data.hex')))
  })

  it('swap data (amount_in 5_000_000, min_out 0, deadline 123_456_789)', async () => {
    const policy: RelayPolicy = decodeRelayPolicy(
      fixtureBin('policy_example.bin'),
      fakeAddress(0x99),
    )
    const ix = await relaySwapIx({
      agent: K.agent,
      amountIn: 5_000_000n,
      minOut: 0n,
      deadlineSlot: 123_456_789n,
      policy,
    })
    expect(hex(ix.data)).toBe(hex(fixtureHex('swap_ix_data.hex')))
  })

  it('verify data for the transfer case (49 bytes)', () => {
    const ix = verifyIx({
      mandate: K.mandate,
      owner: K.owner,
      agent: K.agent,
      targetProgram: TOKEN_PROGRAM_ID,
      discriminator: TRANSFER_CHECKED_DISC,
      amount: 3_000_000n,
    })
    expect(ix.data.length).toBe(49)
    expect(hex(ix.data)).toBe(hex(fixtureHex('verify_ix_data.hex')))
  })

  it('swap_required_min_out_for_5000000_in = 4_750_000 (ceil(5e6 * 95 / 100))', () => {
    const json = JSON.parse(readFileSync(fixturePath('policy_example.json'), 'utf8'))
    expect(json.swap_required_min_out_for_5000000_in).toBe(4_750_000)
    expect((5_000_000n * 95n + 99n) / 100n).toBe(4_750_000n)
  })
})
