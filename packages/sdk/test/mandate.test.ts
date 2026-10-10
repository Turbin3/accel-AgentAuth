import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_SIZE,
  AGENT_AUTH_PROGRAM_ID,
  DecodeError,
  RELAY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeMandate,
  decodeMandateAccount,
  decodeRelayPolicy,
  decodeRelayPolicyAccount,
  fetchMandate,
  fetchMandatesByAgent,
  fetchMandatesByOwner,
  fetchRelayPolicy,
  mandatePda,
  mandatesEqual,
  relayAuthorityPda,
  relayPolicyPda,
  type AccountsRpc,
  type ProgramAccountsRpc,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, fixtureBin, readIdl, type TestMandate } from './helpers'

const owner = fakeAddress(0x21)
const agent = fakeAddress(0x22)
const prog = fakeAddress(0x23)
const prog2 = fakeAddress(0x24)

const sample: TestMandate = {
  owner,
  agent,
  expiry: 1_900_000_000n,
  active: true,
  version: 1,
  bump: 253,
  permissions: [
    {
      program: prog,
      spendLimit: 5_000_000n,
      perTxLimit: 1_000_000n,
      spendTotal: 123n,
      callCount: 7,
      discs: ['0c00000000000000', '8fbe5adac41e33de'],
    },
    {
      program: prog2,
      spendLimit: 0n,
      perTxLimit: 0n,
      spendTotal: 18_446_744_073_709_551_615n,
      callCount: 4_294_967_295,
      discs: ['0100000000000000'],
    },
  ],
}

describe('decodeMandate (independent layout encoder)', () => {
  it('decodes every field', () => {
    const m = decodeMandate(encodeMandateBytes(sample), fakeAddress(0x30))
    expect(m.address).toBe(fakeAddress(0x30))
    expect(m.owner).toBe(owner)
    expect(m.agent).toBe(agent)
    expect(m.expiry).toBe(1_900_000_000n)
    expect(m.active).toBe(true)
    expect(m.version).toBe(1)
    expect(m.bump).toBe(253)
    expect(m.permissions).toHaveLength(2)
    const [a, b] = m.permissions
    expect(a?.index).toBe(0)
    expect(a?.program).toBe(prog)
    expect(a?.spendLimit).toBe(5_000_000n)
    expect(a?.perTxLimit).toBe(1_000_000n)
    expect(a?.spendUnlimited).toBe(false)
    expect(a?.perTxUnlimited).toBe(false)
    expect(a?.spendTotal).toBe(123n)
    expect(a?.callCount).toBe(7)
    expect(a?.discriminatorsHex).toEqual(['0c00000000000000', '8fbe5adac41e33de'])
    expect(a?.discriminators.map((d) => d.length)).toEqual([8, 8])
    expect(b?.spendUnlimited).toBe(true)
    expect(b?.perTxUnlimited).toBe(true)
    expect(b?.spendTotal).toBe(2n ** 64n - 1n)
    expect(b?.callCount).toBe(4_294_967_295)
  })

  it('reads a paused mandate and a negative expiry as bigint', () => {
    const m = decodeMandate(encodeMandateBytes({ ...sample, active: false, expiry: -5n }))
    expect(m.active).toBe(false)
    expect(m.expiry).toBe(-5n)
  })

  it('an empty mandate and a full one (16 slots x 8 discriminators) decode', () => {
    expect(decodeMandate(encodeMandateBytes({ ...sample, permissions: [] })).permissions).toEqual(
      [],
    )
    const full = Array.from({ length: 16 }, (_, i) => ({
      program: fakeAddress(0x40 + i),
      spendLimit: BigInt(i + 1),
      perTxLimit: 1n,
      discs: Array.from(
        { length: 8 },
        (_, j) => `${(i + 1).toString(16).padStart(2, '0')}0${j}000000000000`,
      ),
    }))
    const m = decodeMandate(encodeMandateBytes({ ...sample, permissions: full }))
    expect(m.permissions).toHaveLength(16)
    expect(m.permissions[15]?.discriminators).toHaveLength(8)
    expect(m.permissions[15]?.discriminatorsHex[7]).toBe('1007000000000000')
  })

  it('round-trips through the independent encoder', () => {
    const bytes = encodeMandateBytes(sample)
    const m = decodeMandate(bytes)
    const again = encodeMandateBytes({
      owner: m.owner,
      agent: m.agent,
      expiry: m.expiry,
      active: m.active,
      version: m.version,
      bump: m.bump,
      permissions: m.permissions.map((p) => ({
        program: p.program,
        spendLimit: p.spendLimit,
        perTxLimit: p.perTxLimit,
        spendTotal: p.spendTotal,
        callCount: p.callCount,
        discs: [...p.discriminatorsHex],
      })),
    })
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true)
    expect(mandatesEqual(m, decodeMandate(again))).toBe(true)
  })

  it('mandatesEqual detects a changed counter', () => {
    const a = decodeMandate(encodeMandateBytes(sample))
    const changed = structuredClone(sample)
    changed.permissions[0]!.spendTotal = 124n
    expect(mandatesEqual(a, decodeMandate(encodeMandateBytes(changed)))).toBe(false)
  })

  it('layout constants match idl/core-idl.json', () => {
    const idl = readIdl('core-idl')
    const acc = idl.accounts[0]
    expect(acc.size).toBe(ACCOUNT_SIZE)
    const off = (n: string): number => acc.fields.find((f: { name: string }) => f.name === n).offset
    expect([
      off('owner'),
      off('agent'),
      off('expiry'),
      off('active'),
      off('permissions_len'),
      off('version'),
      off('bump'),
    ]).toEqual([1, 33, 65, 73, 77, 79, 80])
  })

  describe('corrupt input fails with typed errors', () => {
    const good = encodeMandateBytes(sample)
    const code = (fn: () => unknown): string => {
      try {
        fn()
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError)
        return (e as DecodeError).code
      }
      return 'NO_THROW'
    }
    it.each([0, 1, 87, 88, 2135, 2137, 4096])('length %i', (len) => {
      expect(code(() => decodeMandate(new Uint8Array(len)))).toBe('MANDATE_BAD_LENGTH')
    })
    it('discriminator', () => {
      for (const d of [0, 2, 255]) {
        const b = good.slice()
        b[0] = d
        expect(code(() => decodeMandate(b))).toBe('MANDATE_BAD_DISCRIMINATOR')
      }
    })
    it('version (0 only with the legacy opt-in)', () => {
      for (const v of [0, 2, 255]) {
        const b = good.slice()
        b[79] = v
        expect(code(() => decodeMandate(b))).toBe('MANDATE_UNSUPPORTED_VERSION')
      }
      const legacy = good.slice()
      legacy[79] = 0
      expect(decodeMandate(legacy, undefined, { acceptLegacyVersion: true }).version).toBe(0)
    })
    it('permissions_len > 16', () => {
      for (const n of [17, 255, 65535]) {
        const b = good.slice()
        new DataView(b.buffer).setUint16(77, n, true)
        expect(code(() => decodeMandate(b))).toBe('MANDATE_BAD_PERMISSION_COUNT')
      }
    })
    it('discriminators_len > 8', () => {
      const b = good.slice()
      b[88 + 60] = 9
      expect(code(() => decodeMandate(b))).toBe('MANDATE_BAD_PERMISSION')
    })
  })
})

describe('account-level decoding checks owner program and PDA', () => {
  it('rejects a forged account owned by the wrong program', async () => {
    const { address, bump } = await mandatePda(owner, agent)
    const bytes = encodeMandateBytes({ ...sample, bump })
    await expect(
      decodeMandateAccount({
        address,
        ownerProgram: fakeAddress(1),
        data: bytes,
        lamports: 1n,
        executable: false,
      }),
    ).rejects.toMatchObject({ code: 'WRONG_OWNER_PROGRAM' })
  })

  it('rejects an account at the wrong address, and a wrong stored bump', async () => {
    const { address, bump } = await mandatePda(owner, agent)
    const data = encodeMandateBytes({ ...sample, bump })
    await expect(
      decodeMandateAccount({
        address: fakeAddress(9),
        ownerProgram: AGENT_AUTH_PROGRAM_ID,
        data,
        lamports: 1n,
        executable: false,
      }),
    ).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' })
    const badBump = encodeMandateBytes({ ...sample, bump: (bump + 1) % 256 })
    await expect(
      decodeMandateAccount({
        address,
        ownerProgram: AGENT_AUTH_PROGRAM_ID,
        data: badBump,
        lamports: 1n,
        executable: false,
      }),
    ).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' })
    const ok = await decodeMandateAccount({
      address,
      ownerProgram: AGENT_AUTH_PROGRAM_ID,
      data,
      lamports: 1n,
      executable: false,
    })
    expect(ok.owner).toBe(owner)
  })

  it('localnet program-id override is honoured', async () => {
    const local = fakeAddress(0x77)
    const { address, bump } = await mandatePda(owner, agent, local)
    const data = encodeMandateBytes({ ...sample, bump })
    const m = await decodeMandateAccount(
      { address, ownerProgram: local, data, lamports: 1n, executable: false },
      { programIds: { agentAuth: local } },
    )
    expect(m.address).toBe(address)
  })
})

function b64(bytes: Uint8Array): [string, 'base64'] {
  return [Buffer.from(bytes).toString('base64'), 'base64']
}

describe('RPC fetchers (stub RPC)', () => {
  it('fetchMandate: null when missing, decoded when present', async () => {
    const { address, bump } = await mandatePda(owner, agent)
    const data = encodeMandateBytes({ ...sample, bump })
    const present = {
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            owner: AGENT_AUTH_PROGRAM_ID,
            data: b64(data),
            lamports: 5n,
            executable: false,
            space: 2136n,
            rentEpoch: 0n,
          },
        }),
      }),
    } as unknown as AccountsRpc
    const missing = {
      getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    } as unknown as AccountsRpc
    expect(await fetchMandate(missing, address)).toBeNull()
    expect((await fetchMandate(present, address))?.expiry).toBe(1_900_000_000n)
    expect(await fetchRelayPolicy(missing, address)).toBeNull()
  })

  it('fetchMandatesByOwner / ByAgent use dataSize 2136 and memcmp offsets 1 / 33, and skip garbage', async () => {
    const { address, bump } = await mandatePda(owner, agent)
    const good = encodeMandateBytes({ ...sample, bump })
    const calls: { program: string; config: any }[] = []
    const rpc = {
      getProgramAccounts: (program: string, config: any) => {
        calls.push({ program, config })
        return {
          send: async () => [
            {
              pubkey: address,
              account: {
                owner: AGENT_AUTH_PROGRAM_ID,
                data: b64(good),
                lamports: 1n,
                executable: false,
              },
            },
            {
              pubkey: fakeAddress(5),
              account: {
                owner: AGENT_AUTH_PROGRAM_ID,
                data: b64(good),
                lamports: 1n,
                executable: false,
              },
            },
          ],
        }
      },
    } as unknown as ProgramAccountsRpc
    const skipped: string[] = []
    const byOwner = await fetchMandatesByOwner(rpc, owner, { onSkip: (a) => skipped.push(a) })
    const byAgent = await fetchMandatesByAgent(rpc, agent)
    expect(byOwner).toHaveLength(1) // the second account is at a non-PDA address and is skipped
    expect(skipped).toEqual([fakeAddress(5)])
    expect(byAgent).toHaveLength(1)
    expect(calls[0]?.program).toBe(AGENT_AUTH_PROGRAM_ID)
    expect(calls[0]?.config.filters).toEqual([
      { dataSize: 2136n },
      { memcmp: { offset: 1n, bytes: owner, encoding: 'base58' } },
    ])
    expect(calls[1]?.config.filters[1].memcmp.offset).toBe(33n)
  })
})

describe('decodeRelayPolicy strictness', () => {
  const good = fixtureBin('policy_example.bin')
  const code = (bytes: Uint8Array): string => {
    try {
      decodeRelayPolicy(bytes)
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError)
      return (e as DecodeError).code
    }
    return 'NO_THROW'
  }
  const mutate = (i: number, v: number): Uint8Array => {
    const b = good.slice()
    b[i] = v
    return b
  }
  it.each([0, 943, 945])('length %i', (n) =>
    expect(code(new Uint8Array(n))).toBe('POLICY_BAD_LENGTH'),
  )
  it('discriminator', () => expect(code(mutate(0, 0xa6))).toBe('POLICY_BAD_DISCRIMINATOR'))
  it('version', () => expect(code(mutate(1, 2))).toBe('POLICY_UNSUPPORTED_VERSION'))
  it('reserved flag bits', () => expect(code(mutate(4, 0x06))).toBe('POLICY_BAD_FLAGS'))
  it('recipients_len > 8', () => expect(code(mutate(240, 9))).toBe('POLICY_BAD_CONFIG'))
  it('swap_enabled not 0/1', () => expect(code(mutate(241, 2))).toBe('POLICY_BAD_CONFIG'))
  it('non-zero reserved bytes', () => {
    expect(code(mutate(5, 1))).toBe('POLICY_BAD_CONFIG')
    expect(code(mutate(244, 1))).toBe('POLICY_BAD_CONFIG')
    expect(code(mutate(941, 1))).toBe('POLICY_BAD_CONFIG')
  })
  it('recipient slot beyond recipients_len must be zero', () =>
    expect(code(mutate(248 + 32, 1))).toBe('POLICY_BAD_CONFIG'))
  it('max_deadline_slots out of range', () => {
    const b = good.slice()
    new DataView(b.buffer).setUint32(936, 9001, true)
    expect(code(b)).toBe('POLICY_BAD_CONFIG')
    new DataView(b.buffer).setUint32(936, 0, true)
    expect(code(b)).toBe('POLICY_BAD_CONFIG')
  })
  it('swap disabled but swap bytes set', () => {
    const b = good.slice()
    b[241] = 0
    expect(code(b)).toBe('POLICY_BAD_CONFIG')
    b.fill(0, 504, 944)
    expect(decodeRelayPolicy(b).swap).toBeNull()
  })
  it('paused flag decodes', () => {
    const p = decodeRelayPolicy(mutate(4, 0x03))
    expect(p.paused).toBe(true)
    expect(p.strictTopLevel).toBe(true)
  })
})

describe('relay policy account checks (PDA binding)', () => {
  it('accepts a policy at its PDA, rejects a policy at another address', async () => {
    const mandate = fakeAddress(0x11)
    const pol = await relayPolicyPda(mandate)
    const auth = await relayAuthorityPda(mandate)
    const bytes = fixtureBin('policy_example.bin').slice()
    bytes.set(new Uint8Array(32).fill(0x11), 8)
    bytes[2] = pol.bump
    bytes[3] = auth.bump
    // authority at 104..136
    const { getAddressEncoder } = await import('@solana/kit')
    bytes.set(new Uint8Array(getAddressEncoder().encode(auth.address)), 104)
    const raw = {
      address: pol.address,
      ownerProgram: RELAY_PROGRAM_ID,
      data: bytes,
      lamports: 1n,
      executable: false,
    }
    const ok = await decodeRelayPolicyAccount(raw)
    expect(ok.mandate).toBe(mandate)
    expect(ok.tokenProgram).toBe(TOKEN_PROGRAM_ID)
    await expect(
      decodeRelayPolicyAccount({ ...raw, address: fakeAddress(2) }),
    ).rejects.toMatchObject({ code: 'ADDRESS_MISMATCH' })
    await expect(
      decodeRelayPolicyAccount({ ...raw, ownerProgram: fakeAddress(2) }),
    ).rejects.toMatchObject({ code: 'WRONG_OWNER_PROGRAM' })
  })
})
