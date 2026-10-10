import { describe, expect, it } from 'vitest'
import { DecodeError, decodeMandate } from '../src/index'
import { fakeAddress, fixtureBin } from './helpers'

describe('real core goldens (fixtures/golden_mandate*.bin, pinned by the Rust tests)', () => {
  it('golden_mandate_v1.bin: version 1, stored bump, counters, two slots', () => {
    const m = decodeMandate(fixtureBin('golden_mandate_v1.bin'))
    expect(m.version).toBe(1)
    expect(m.bump).toBe(254)
    expect(m.owner).toBe(fakeAddress(1))
    expect(m.agent).toBe(fakeAddress(2))
    expect(m.expiry).toBe(1_900_000_000n)
    expect(m.active).toBe(true)
    expect(m.permissions).toHaveLength(2)
    const [a, b] = m.permissions
    expect(a).toMatchObject({
      program: fakeAddress(0xaa),
      spendLimit: 1_000_000n,
      perTxLimit: 50_000n,
      spendTotal: 123_456n,
      callCount: 77,
    })
    expect(a?.discriminatorsHex).toEqual(['0102030405060708', '0909090909090909'])
    expect(b).toMatchObject({
      program: fakeAddress(0xbb),
      spendLimit: 0n,
      perTxLimit: 0n,
      spendUnlimited: true,
      perTxUnlimited: true,
      spendTotal: 0n,
      callCount: 0,
    })
    expect(b?.discriminatorsHex).toEqual(['ffffffffffffffff'])
  })

  it('golden_mandate.bin is the legacy (version 0) layout: refused by default, readable on request', () => {
    const bytes = fixtureBin('golden_mandate.bin')
    expect(() => decodeMandate(bytes)).toThrow(DecodeError)
    const m = decodeMandate(bytes, undefined, { acceptLegacyVersion: true })
    expect(m.version).toBe(0)
    expect(m.permissions).toHaveLength(2)
    expect(m.permissions[0]).toMatchObject({
      program: fakeAddress(0xaa),
      spendLimit: 1_000_000n,
      perTxLimit: 50_000n,
    })
  })
})
