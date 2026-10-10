import { describe, expect, it } from 'vitest'
import { AccountRole, isSignerRole, isWritableRole, type Address } from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ValidationError,
  addPermissionIx,
  approveIx,
  associatedTokenAddress,
  closePolicyIx,
  createAtaIdempotentIx,
  createMandateIx,
  decodeRelayPolicy,
  initPolicyIx,
  mandatePda,
  relayAuthorityPda,
  relayPolicyPda,
  relaySwapIx,
  relayTransferIx,
  removePermissionIx,
  revokeDelegateIx,
  revokeMandateIx,
  setActiveIx,
  setPausedIx,
  systemTransferIx,
  transferCheckedIx,
  updatePermissionIx,
  verifyIx,
  type BuiltInstruction,
  type RelayPolicy,
  type RelayPolicyConfig,
} from '../src/index'
import { fakeAddress, fixtureBin, hex, noopSigner, raw, readIdl } from './helpers'

interface IdlArg {
  name: string
  type: string
  offset: number
  size: number | string
}
interface IdlAccount {
  name: string
  isSigner: boolean
  isWritable: boolean
  optional?: boolean
  address?: string
}
interface IdlIx {
  name: string
  tag: number
  dataLength: number | null
  args: IdlArg[]
  accounts: IdlAccount[]
  minAccounts?: number
}

const coreIdl = readIdl('core-idl')
const relayIdl = readIdl('relay-idl')

const owner = fakeAddress(0xa1)
const agent = fakeAddress(0xa2)
const target = fakeAddress(0xa3)
const OWNER = noopSigner(owner)

function readArg(data: Uint8Array, a: IdlArg): unknown {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  switch (a.type) {
    case 'u8':
      return data[a.offset]
    case 'u64':
      return dv.getBigUint64(a.offset, true)
    case 'i64':
      return dv.getBigInt64(a.offset, true)
    case 'pubkey':
      return hex(data.subarray(a.offset, a.offset + 32))
    case '[u8;8]':
      return hex(data.subarray(a.offset, a.offset + 8))
    default:
      return undefined
  }
}

/** Compare a built instruction with the IDL instruction of the same name. */
function assertMatchesIdl(
  built: BuiltInstruction,
  idlIx: IdlIx,
  programId: Address,
  addresses: Record<string, Address>,
  args: Record<string, unknown>,
): void {
  expect(built.programAddress).toBe(programId)
  // accounts: order, address, signer, writable
  const named = idlIx.accounts
  expect(built.accounts.length).toBeGreaterThanOrEqual(idlIx.minAccounts ?? named.length)
  expect(built.accounts.length).toBeLessThanOrEqual(named.length)
  built.accounts.forEach((acc, i) => {
    const want = named[i]!
    const expectedAddress = want.address ?? addresses[want.name]
    expect(acc.address, `${idlIx.name} account #${i} ${want.name}`).toBe(expectedAddress)
    expect(isSignerRole(acc.role), `${idlIx.name} ${want.name} signer`).toBe(want.isSigner)
    expect(isWritableRole(acc.role), `${idlIx.name} ${want.name} writable`).toBe(want.isWritable)
  })
  // data
  expect(built.data[0]).toBe(idlIx.tag)
  if (idlIx.dataLength !== null) expect(built.data.length).toBe(idlIx.dataLength)
  for (const a of idlIx.args) {
    if (a.name === 'tag' || !(a.name in args)) continue
    expect(readArg(built.data, a), `${idlIx.name} arg ${a.name}`).toEqual(args[a.name])
  }
}

const find = (idl: { instructions: IdlIx[] }, name: string): IdlIx => {
  const ix = idl.instructions.find((i) => i.name === name)
  if (!ix) throw new Error(`IDL has no instruction ${name}`)
  return ix
}

describe('core instruction builders match idl/core-idl.json', () => {
  it('the IDL still has exactly the 7 instructions the SDK knows', () => {
    expect(coreIdl.instructions.map((i: IdlIx) => `${i.tag}:${i.name}`)).toEqual([
      '0:create_mandate',
      '1:add_permission',
      '2:remove_permission',
      '3:verify',
      '4:revoke_mandate',
      '5:set_active',
      '6:update_permission',
    ])
    expect(coreIdl.addresses.devnet).toBe(AGENT_AUTH_PROGRAM_ID)
  })

  it('create_mandate', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const ix = await createMandateIx({ owner: OWNER, agent, expiry: 1_900_000_000n })
    assertMatchesIdl(
      ix,
      find(coreIdl, 'create_mandate'),
      AGENT_AUTH_PROGRAM_ID,
      { owner, agent, mandate },
      { expiry: 1_900_000_000n },
    )
    expect(ix.accounts[0]).toMatchObject({ signer: OWNER })
  })

  it('add_permission (1 and 8 discriminators)', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    for (const n of [1, 8]) {
      const discs = Array.from({ length: n }, (_, i) => `0${i}00000000000000`)
      const ix = await addPermissionIx({
        owner: OWNER,
        agent,
        program: target,
        spendLimit: 77n,
        perTxLimit: 5n,
        discriminators: discs,
      })
      expect(ix.data.length).toBe(50 + 8 * n)
      assertMatchesIdl(
        ix,
        find(coreIdl, 'add_permission'),
        AGENT_AUTH_PROGRAM_ID,
        { owner, mandate },
        {
          target_program: hex(raw(target)),
          spend_limit: 77n,
          per_tx_limit: 5n,
          disc_len: n,
        },
      )
      expect(hex(ix.data.subarray(50))).toBe(discs.join(''))
    }
  })

  it('remove_permission', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const ix = await removePermissionIx({ owner: OWNER, mandate, program: target })
    assertMatchesIdl(
      ix,
      find(coreIdl, 'remove_permission'),
      AGENT_AUTH_PROGRAM_ID,
      { owner, mandate },
      { target_program: hex(raw(target)) },
    )
  })

  it('verify', () => {
    const mandate = fakeAddress(0xb1)
    const ix = verifyIx({
      mandate,
      owner,
      agent: noopSigner(agent),
      targetProgram: target,
      discriminator: '0c00000000000000',
      amount: 9n,
    })
    assertMatchesIdl(
      ix,
      find(coreIdl, 'verify'),
      AGENT_AUTH_PROGRAM_ID,
      { mandate, owner, agent },
      {
        target_program_id: hex(raw(target)),
        discriminator: '0c00000000000000',
        amount: 9n,
      },
    )
  })

  it('revoke_mandate (3rd account is the optional system program)', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const ix = await revokeMandateIx({ owner: OWNER, agent })
    assertMatchesIdl(
      ix,
      find(coreIdl, 'revoke_mandate'),
      AGENT_AUTH_PROGRAM_ID,
      { owner, mandate, system_program: SYSTEM_PROGRAM_ID },
      {},
    )
    expect(ix.accounts).toHaveLength(3)
  })

  it('set_active (both values)', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    for (const active of [true, false]) {
      const ix = await setActiveIx({ owner: OWNER, agent, active })
      assertMatchesIdl(
        ix,
        find(coreIdl, 'set_active'),
        AGENT_AUTH_PROGRAM_ID,
        { owner, mandate },
        { active: active ? 1 : 0 },
      )
    }
  })

  it('update_permission', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const ix = await updatePermissionIx({
      owner: OWNER,
      mandate,
      program: target,
      spendLimit: 1000n,
      perTxLimit: 'unlimited',
    })
    assertMatchesIdl(
      ix,
      find(coreIdl, 'update_permission'),
      AGENT_AUTH_PROGRAM_ID,
      { owner, mandate },
      {
        target_program: hex(raw(target)),
        spend_limit: 1000n,
        per_tx_limit: 0n,
      },
    )
  })

  it('a bare address works where a signer is expected (role only, no signer object)', async () => {
    const ix = await setActiveIx({ owner, agent, active: true })
    expect(ix.accounts[0]?.role).toBe(AccountRole.READONLY_SIGNER)
    expect('signer' in (ix.accounts[0] as object)).toBe(false)
  })

  it('agentAuthProgram override is used for the program and for the derived PDA', async () => {
    const local = fakeAddress(0xc1)
    const ix = await createMandateIx({ owner, agent, expiry: 5n, agentAuthProgram: local })
    expect(ix.programAddress).toBe(local)
    expect(ix.accounts[2]?.address).toBe((await mandatePda(owner, agent, local)).address)
  })
})

describe('client-side validation (nothing invalid is ever encoded)', () => {
  const base = { owner: OWNER, agent, program: target }
  const err = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      return (e as ValidationError).code
    }
    return 'NO_THROW'
  }
  it('0n is never silently unlimited', async () => {
    expect(
      await err(
        addPermissionIx({
          ...base,
          spendLimit: 0n,
          perTxLimit: 1n,
          discriminators: ['0100000000000000'],
        }),
      ),
    ).toBe('ZERO_LIMIT_AMBIGUOUS')
    expect(
      await err(
        addPermissionIx({
          ...base,
          spendLimit: 1n,
          perTxLimit: 0n,
          discriminators: ['0100000000000000'],
        }),
      ),
    ).toBe('ZERO_LIMIT_AMBIGUOUS')
    expect(await err(updatePermissionIx({ ...base, spendLimit: 0n, perTxLimit: 1n }))).toBe(
      'ZERO_LIMIT_AMBIGUOUS',
    )
  })
  it('"unlimited" is the explicit spelling and encodes 0', async () => {
    const ix = await addPermissionIx({
      ...base,
      spendLimit: 'unlimited',
      perTxLimit: 'unlimited',
      discriminators: ['0100000000000000'],
    })
    expect(hex(ix.data.subarray(33, 49))).toBe('00'.repeat(16))
  })
  it('limit range and type', async () => {
    const d = ['0100000000000000']
    expect(
      await err(addPermissionIx({ ...base, spendLimit: -1n, perTxLimit: 1n, discriminators: d })),
    ).toBe('BAD_LIMIT')
    expect(
      await err(
        addPermissionIx({ ...base, spendLimit: 2n ** 64n, perTxLimit: 1n, discriminators: d }),
      ),
    ).toBe('BAD_LIMIT')
    expect(
      await err(
        addPermissionIx({
          ...base,
          spendLimit: 5 as unknown as bigint,
          perTxLimit: 1n,
          discriminators: d,
        }),
      ),
    ).toBe('BAD_LIMIT')
    const max = await addPermissionIx({
      ...base,
      spendLimit: 2n ** 64n - 1n,
      perTxLimit: 1n,
      discriminators: d,
    })
    expect(hex(max.data.subarray(33, 41))).toBe('ff'.repeat(8))
  })
  it('discriminators: empty, > 8, wrong length, bad hex, duplicates', async () => {
    const p = { ...base, spendLimit: 1n, perTxLimit: 1n }
    expect(await err(addPermissionIx({ ...p, discriminators: [] }))).toBe('EMPTY_DISCRIMINATORS')
    expect(
      await err(
        addPermissionIx({
          ...p,
          discriminators: Array.from({ length: 9 }, (_, i) => `0${i}00000000000000`),
        }),
      ),
    ).toBe('TOO_MANY_DISCRIMINATORS')
    expect(await err(addPermissionIx({ ...p, discriminators: ['01'] }))).toBe('BAD_DISCRIMINATOR')
    expect(await err(addPermissionIx({ ...p, discriminators: [new Uint8Array(9)] }))).toBe(
      'BAD_DISCRIMINATOR',
    )
    expect(await err(addPermissionIx({ ...p, discriminators: ['zz00000000000000'] }))).toBe(
      'BAD_HEX',
    )
    expect(
      await err(
        addPermissionIx({ ...p, discriminators: ['0100000000000000', '0100000000000000'] }),
      ),
    ).toBe('DUPLICATE_DISCRIMINATOR')
  })
  it('accepts raw Uint8Array discriminators and copies them', async () => {
    const d = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const ix = await addPermissionIx({
      ...base,
      spendLimit: 1n,
      perTxLimit: 1n,
      discriminators: [d],
    })
    d[0] = 99
    expect(ix.data[50]).toBe(1)
  })
  it('create_mandate: owner == agent and bad expiry', async () => {
    expect(await err(createMandateIx({ owner, agent: owner, expiry: 5n }))).toBe(
      'SAME_OWNER_AND_AGENT',
    )
    expect(await err(createMandateIx({ owner, agent, expiry: 0n }))).toBe('BAD_EXPIRY')
    expect(await err(createMandateIx({ owner, agent, expiry: 5 as unknown as bigint }))).toBe(
      'BAD_EXPIRY',
    )
    expect(await err(createMandateIx({ owner, agent, expiry: 2n ** 63n }))).toBe('BAD_EXPIRY')
    expect(await err(createMandateIx({ owner, agent, expiry: 1_800_000_000_000n }))).toBe(
      'BAD_EXPIRY',
    )
  })
  it('missing mandate/agent is reported', async () => {
    expect(await err(setActiveIx({ owner, active: true }))).toBe('MISSING_ADDRESS')
  })
  it('amount range on verify', () => {
    expect(() =>
      verifyIx({
        mandate: owner,
        owner,
        agent,
        targetProgram: target,
        discriminator: '0c00000000000000',
        amount: -1n,
      }),
    ).toThrow(ValidationError)
    expect(() =>
      verifyIx({
        mandate: owner,
        owner,
        agent,
        targetProgram: target,
        discriminator: '0c00000000000000',
        amount: 2n ** 64n,
      }),
    ).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------------------------
// relay
// ---------------------------------------------------------------------------------------------

const policyBytes = fixtureBin('policy_example.bin')
const policy: RelayPolicy = decodeRelayPolicy(policyBytes, fakeAddress(0x99))

describe('relay instruction builders match idl/relay-idl.json', () => {
  it('the IDL still has the 5 instructions and the program id the SDK knows', () => {
    expect(relayIdl.instructions.map((i: IdlIx) => `${i.tag}:${i.name}`)).toEqual([
      '0:init_policy',
      '1:set_paused',
      '2:close_policy',
      '3:transfer',
      '4:swap',
    ])
    expect(relayIdl.addresses.agent_auth_relay.devnet).toBe(RELAY_PROGRAM_ID)
  })

  const config: RelayPolicyConfig = {
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: fakeAddress(0x55),
    sourceAccount: fakeAddress(0x66),
    recipients: [fakeAddress(0x61), fakeAddress(0x62)],
    swap: null,
  }

  it('init_policy', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const polAddr = (await relayPolicyPda(mandate)).address
    const ix = await initPolicyIx({ owner: OWNER, agent, config })
    assertMatchesIdl(
      ix,
      find(relayIdl, 'init_policy'),
      RELAY_PROGRAM_ID,
      { owner, mandate, policy: polAddr },
      { flags: 2 },
    )
    expect(ix.data.length).toBe(802)
  })

  it('init_policy flags: STRICT_TOP_LEVEL by default, paused and allowCpi are explicit', async () => {
    const f = async (extra: object): Promise<number> =>
      (await initPolicyIx({ owner, agent, config, ...extra })).data[1]!
    expect(await f({})).toBe(2)
    expect(await f({ allowCpi: true })).toBe(0)
    expect(await f({ paused: true })).toBe(3)
    expect(await f({ paused: true, allowCpi: true })).toBe(1)
  })

  it('init_policy refuses invalid configs with relay code 113 before encoding', async () => {
    const bad = async (c: RelayPolicyConfig, extra: object = {}): Promise<ValidationError> => {
      try {
        await initPolicyIx({ owner, agent, config: c, ...extra })
      } catch (e) {
        return e as ValidationError
      }
      throw new Error('did not throw')
    }
    const nine = Array.from({ length: 9 }, (_, i) => fakeAddress(0x80 + i))
    expect((await bad({ ...config, recipients: nine })).relayCode).toBe(113)
    expect(
      (await bad({ ...config, recipients: [config.recipients[0]!, config.recipients[0]!] }))
        .message,
    ).toMatch(/duplicates/)
    expect((await bad({ ...config, recipients: [config.sourceAccount] })).message).toMatch(
      /sourceAccount/,
    )
    expect((await bad({ ...config, tokenProgram: fakeAddress(1) })).message).toMatch(
      /Token or Token-2022/,
    )
    expect(
      (
        await bad({
          ...config,
          budgetMint: 'So11111111111111111111111111111111111111112' as Address,
        })
      ).message,
    ).toMatch(/native/)
    expect((await bad(config, { agent: owner })).message).toMatch(/agent must differ/)
    // the policy's own PDA as a recipient violates the distinctness rule
    const mandate = (await mandatePda(owner, agent)).address
    const polAddr = (await relayPolicyPda(mandate)).address
    expect((await bad({ ...config, recipients: [polAddr] })).message).toMatch(/different accounts/)
    expect((await bad({ ...config, recipients: [owner] })).message).toMatch(/different accounts/)
  })

  it('init_policy accepts exactly 8 recipients and a Token-2022 program', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => fakeAddress(0x80 + i))
    const ix = await initPolicyIx({
      owner,
      agent,
      config: { ...config, recipients: eight, tokenProgram: TOKEN_2022_PROGRAM_ID },
    })
    expect(ix.data[2 + 96]).toBe(8)
  })

  it('set_paused', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const polAddr = (await relayPolicyPda(mandate)).address
    for (const paused of [true, false]) {
      const ix = await setPausedIx({ owner: OWNER, agent, paused })
      assertMatchesIdl(
        ix,
        find(relayIdl, 'set_paused'),
        RELAY_PROGRAM_ID,
        { owner, policy: polAddr },
        { paused: paused ? 1 : 0 },
      )
    }
    const explicit = await setPausedIx({ owner, policy: fakeAddress(7), paused: true })
    expect(explicit.accounts[1]?.address).toBe(fakeAddress(7))
  })

  it('close_policy', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const polAddr = (await relayPolicyPda(mandate)).address
    const ix = await closePolicyIx({ owner: OWNER, mandate })
    assertMatchesIdl(
      ix,
      find(relayIdl, 'close_policy'),
      RELAY_PROGRAM_ID,
      { owner, policy: polAddr },
      {},
    )
  })

  it('transfer: all 10 accounts in IDL order, derived PDAs filled in', async () => {
    const dest = fakeAddress(0x61)
    const ix = await relayTransferIx({
      agent: noopSigner(policy.agent),
      amount: 3_000_000n,
      destination: dest,
      policy,
    })
    assertMatchesIdl(
      ix,
      find(relayIdl, 'transfer'),
      RELAY_PROGRAM_ID,
      {
        agent: policy.agent,
        mandate: policy.mandate,
        owner: policy.owner,
        policy: fakeAddress(0x99),
        authority: policy.authority,
        source: policy.sourceAccount,
        destination: dest,
        mint: policy.budgetMint,
        token_program: policy.tokenProgram,
        agentauth_program: AGENT_AUTH_PROGRAM_ID,
      },
      { amount: 3_000_000n },
    )
    expect(ix.accounts).toHaveLength(10)
  })

  it('transfer without a decoded policy derives mandate/policy/authority PDAs from owner + agent', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const ix = await relayTransferIx({
      agent,
      owner,
      amount: 1n,
      destination: fakeAddress(0x61),
      source: fakeAddress(0x66),
      mint: fakeAddress(0x55),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    expect(ix.accounts[1]?.address).toBe(mandate)
    expect(ix.accounts[3]?.address).toBe((await relayPolicyPda(mandate)).address)
    expect(ix.accounts[4]?.address).toBe((await relayAuthorityPda(mandate)).address)
  })

  it('transfer: zero / out-of-range amounts and missing accounts are rejected', async () => {
    const common = { agent, destination: fakeAddress(0x61), policy }
    await expect(relayTransferIx({ ...common, amount: 0n })).rejects.toMatchObject({
      code: 'BAD_AMOUNT',
    })
    await expect(relayTransferIx({ ...common, amount: 2n ** 64n })).rejects.toMatchObject({
      code: 'BAD_AMOUNT',
    })
    await expect(
      relayTransferIx({ agent, destination: fakeAddress(1), amount: 1n }),
    ).rejects.toMatchObject({ code: 'MISSING_ADDRESS' })
  })

  it('swap: all 19 accounts in IDL order', async () => {
    const s = policy.swap!
    const ix = await relaySwapIx({
      agent: noopSigner(policy.agent),
      amountIn: 5_000_000n,
      minOut: 4_750_000n,
      deadlineSlot: 99n,
      policy,
    })
    assertMatchesIdl(
      ix,
      find(relayIdl, 'swap'),
      RELAY_PROGRAM_ID,
      {
        agent: policy.agent,
        mandate: policy.mandate,
        owner: policy.owner,
        policy: fakeAddress(0x99),
        authority: policy.authority,
        in_account: s.inAccount,
        out_account: s.outAccount,
        amm_program: s.ammProgram,
        amm_authority: s.ammAuthority,
        amm_config: s.ammConfig,
        pool_state: s.poolState,
        input_vault: s.inputVault,
        output_vault: s.outputVault,
        in_token_program: s.inTokenProgram,
        out_token_program: s.outTokenProgram,
        in_mint: s.inMint,
        out_mint: s.outMint,
        observation_state: s.observationState,
        agentauth_program: AGENT_AUTH_PROGRAM_ID,
      },
      { amount_in: 5_000_000n, min_out: 4_750_000n, deadline_slot: 99n },
    )
    expect(ix.accounts).toHaveLength(19)
  })

  it('swap on a policy without swap config is refused with relay code 110', async () => {
    const noSwap: RelayPolicy = { ...policy, swap: null }
    await expect(
      relaySwapIx({ agent, amountIn: 1n, minOut: 0n, deadlineSlot: 1n, policy: noSwap }),
    ).rejects.toMatchObject({ relayCode: 110 })
  })
})

describe('token helper instructions', () => {
  const source = fakeAddress(0x66)
  const mint = fakeAddress(0x55)
  const dest = fakeAddress(0x61)

  it('approve: bounded delegation to the relay authority PDA', async () => {
    const mandate = fakeAddress(0x11)
    const authority = (await relayAuthorityPda(mandate)).address
    const ix = await approveIx({ source, owner: OWNER, mandate, amount: 5_000_000n })
    expect(ix.programAddress).toBe(TOKEN_PROGRAM_ID)
    expect(
      ix.accounts.map((a) => [a.address, isSignerRole(a.role), isWritableRole(a.role)]),
    ).toEqual([
      [source, false, true],
      [authority, false, false],
      [owner, true, false],
    ])
    expect(hex(ix.data)).toBe('04' + '404b4c0000000000')
  })

  it('approve: zero amount and missing delegate are rejected; Token-2022 selectable', async () => {
    await expect(
      approveIx({ source, owner, mandate: fakeAddress(1), amount: 0n }),
    ).rejects.toMatchObject({ code: 'BAD_AMOUNT' })
    await expect(approveIx({ source, owner, amount: 1n })).rejects.toMatchObject({
      code: 'MISSING_ADDRESS',
    })
    const ix = await approveIx({
      source,
      owner,
      delegate: dest,
      amount: 1n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    expect(ix.programAddress).toBe(TOKEN_2022_PROGRAM_ID)
    expect(ix.accounts[1]?.address).toBe(dest)
  })

  it('revoke', () => {
    const ix = revokeDelegateIx({ source, owner: OWNER })
    expect(hex(ix.data)).toBe('05')
    expect(
      ix.accounts.map((a) => [a.address, isSignerRole(a.role), isWritableRole(a.role)]),
    ).toEqual([
      [source, false, true],
      [owner, true, false],
    ])
  })

  it('transfer_checked', () => {
    const ix = transferCheckedIx({
      source,
      mint,
      destination: dest,
      authority: OWNER,
      amount: 3_000_000n,
      decimals: 6,
    })
    expect(hex(ix.data)).toBe('0c' + 'c0c62d0000000000' + '06')
    expect(
      ix.accounts.map((a) => [a.address, isSignerRole(a.role), isWritableRole(a.role)]),
    ).toEqual([
      [source, false, true],
      [mint, false, false],
      [dest, false, true],
      [owner, true, false],
    ])
    expect(() =>
      transferCheckedIx({
        source,
        mint,
        destination: dest,
        authority: owner,
        amount: 1n,
        decimals: 256,
      }),
    ).toThrow(ValidationError)
    expect(() =>
      transferCheckedIx({
        source,
        mint,
        destination: dest,
        authority: owner,
        amount: 0n,
        decimals: 6,
      }),
    ).toThrow(ValidationError)
  })

  it('create ATA idempotent', async () => {
    const wallet = fakeAddress(0x31)
    const ata = (await associatedTokenAddress(wallet, mint, TOKEN_PROGRAM_ID)).address
    const ix = await createAtaIdempotentIx({ payer: OWNER, owner: wallet, mint })
    expect(ix.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ID)
    expect(hex(ix.data)).toBe('01')
    expect(
      ix.accounts.map((a) => [a.address, isSignerRole(a.role), isWritableRole(a.role)]),
    ).toEqual([
      [owner, true, true],
      [ata, false, true],
      [wallet, false, false],
      [mint, false, false],
      [SYSTEM_PROGRAM_ID, false, false],
      [TOKEN_PROGRAM_ID, false, false],
    ])
    const t22 = await createAtaIdempotentIx({
      payer: owner,
      owner: wallet,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    expect(t22.accounts[1]?.address).toBe(
      (await associatedTokenAddress(wallet, mint, TOKEN_2022_PROGRAM_ID)).address,
    )
    expect(t22.accounts[1]?.address).not.toBe(ata)
  })

  it('system transfer', () => {
    const ix = systemTransferIx({ from: OWNER, to: agent, lamports: 1_000_000n })
    expect(hex(ix.data)).toBe('02000000' + '40420f0000000000')
    expect(() => systemTransferIx({ from: owner, to: agent, lamports: 0n })).toThrow(
      ValidationError,
    )
  })
})
