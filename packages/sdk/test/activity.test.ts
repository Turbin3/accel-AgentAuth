import { describe, expect, it } from 'vitest'
import { getBase58Decoder, type Address } from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  addPermissionIx,
  closePolicyIx,
  createMandateIx,
  decodeRelayEvents,
  decodeRelayPolicy,
  decodeTransaction,
  getActivity,
  initPolicyIx,
  removePermissionIx,
  revokeMandateIx,
  setActiveIx,
  setPausedIx,
  relaySwapIx,
  relayTransferIx,
  toDecodableTransaction,
  transferCheckedIx,
  updatePermissionIx,
  verifyIx,
  type ActivityRpc,
  type BuiltInstruction,
  type DecodableTransaction,
} from '../src/index'
import { fakeAddress, fixtureBin, raw } from './helpers'

const owner = fakeAddress(0xa1)
const agent = fakeAddress(0xa2)
const mandate = fakeAddress(0xa3)
const policyAddr = fakeAddress(0xa4)
const SIG = '5'.repeat(88)
const b58 = (bytes: Uint8Array): string => getBase58Decoder().decode(bytes)

/** Turn built instructions into the wire form `getTransaction` returns. */
function wire(
  ixs: BuiltInstruction[],
  extra: Partial<DecodableTransaction> = {},
): DecodableTransaction {
  const keys: string[] = []
  const idx = (k: string): number => {
    let i = keys.indexOf(k)
    if (i < 0) {
      keys.push(k)
      i = keys.length - 1
    }
    return i
  }
  idx(owner)
  const instructions = ixs.map((ix) => ({
    programIdIndex: idx(ix.programAddress),
    accounts: ix.accounts.map((a) => idx(a.address)),
    data: b58(ix.data),
  }))
  return {
    signature: SIG,
    slot: 100n,
    blockTime: 1_800_000_000n,
    err: null,
    logs: [],
    accountKeys: keys,
    instructions,
    ...extra,
  }
}

function eventLine(bytes: number[]): string {
  return `Program data: ${Buffer.from(Uint8Array.from(bytes)).toString('base64')}`
}
function transferEvent(m: Address, destination: Address, mint: Address, amount: bigint): number[] {
  const b = new Uint8Array(105)
  b[0] = 1
  b.set(raw(m), 1)
  b.set(raw(destination), 33)
  b.set(raw(mint), 65)
  new DataView(b.buffer).setBigUint64(97, amount, true)
  return [...b]
}
function swapEvent(m: Address, pool: Address, req: bigint, inD: bigint, outD: bigint): number[] {
  const b = new Uint8Array(89)
  b[0] = 2
  b.set(raw(m), 1)
  b.set(raw(pool), 33)
  const dv = new DataView(b.buffer)
  dv.setBigUint64(65, req, true)
  dv.setBigUint64(73, inD, true)
  dv.setBigUint64(81, outD, true)
  return [...b]
}

const policy = decodeRelayPolicy(fixtureBin('policy_example.bin'), policyAddr)
const kinds = (txs: DecodableTransaction): string[] => decodeTransaction(txs).map((i) => i.kind)

describe('decodeTransaction: one fixture per kind', () => {
  it('create + add_permission in one transaction', async () => {
    const tx = wire([
      await createMandateIx({ owner, agent, expiry: 1_900_000_000n, mandate }),
      await addPermissionIx({
        owner,
        mandate,
        program: TOKEN_PROGRAM_ID,
        spendLimit: 5n,
        perTxLimit: 1n,
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ])
    const items = decodeTransaction(tx)
    expect(items.map((i) => i.kind)).toEqual(['create', 'add_permission'])
    expect(items[1]).toMatchObject({
      program: TOKEN_PROGRAM_ID,
      discriminatorName: 'transfer_checked',
      ok: true,
      slot: 100n,
      blockTime: 1_800_000_000n,
      signature: SIG,
      instructionIndex: 1,
    })
  })

  it('remove_permission, update_permission, set_active, revoke', async () => {
    const prog = fakeAddress(0xb1)
    const items = decodeTransaction(
      wire([
        await removePermissionIx({ owner, mandate, program: prog }),
        await updatePermissionIx({ owner, mandate, program: prog, spendLimit: 1n, perTxLimit: 1n }),
        await setActiveIx({ owner, mandate, active: false }),
        await revokeMandateIx({ owner, mandate }),
      ]),
    )
    expect(items.map((i) => i.kind)).toEqual([
      'remove_permission',
      'update_permission',
      'set_active',
      'revoke',
    ])
    expect(items[0]?.program).toBe(prog)
    expect(items[1]?.program).toBe(prog)
  })

  it('verify carries program, amount and the registry name', () => {
    const items = decodeTransaction(
      wire([
        verifyIx({
          mandate,
          owner,
          agent,
          targetProgram: TOKEN_PROGRAM_ID,
          discriminator: TRANSFER_CHECKED_DISC,
          amount: 123n,
        }),
      ]),
    )
    expect(items[0]).toMatchObject({
      kind: 'verify',
      program: TOKEN_PROGRAM_ID,
      amount: 123n,
      discriminatorName: 'transfer_checked',
    })
  })

  it('relay init / pause / close', async () => {
    const config = {
      tokenProgram: TOKEN_PROGRAM_ID,
      budgetMint: fakeAddress(0xc1),
      sourceAccount: fakeAddress(0xc2),
      recipients: [fakeAddress(0xc3)],
      swap: null,
    }
    expect(
      kinds(
        wire([
          await initPolicyIx({ owner, agent, mandate, config }),
          await setPausedIx({ owner, mandate, paused: true }),
          await closePolicyIx({ owner, mandate }),
        ]),
      ),
    ).toEqual(['relay_init', 'relay_pause', 'relay_close'])
  })

  it('relay transfer: amount, recipient, token program; the event overrides with exact numbers', async () => {
    const dest = policy.recipients[0]!
    const ix = await relayTransferIx({ agent, amount: 3_000_000n, destination: dest, policy })
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${AGENT_AUTH_PROGRAM_ID} invoke [2]`,
      `Program ${AGENT_AUTH_PROGRAM_ID} success`,
      `Program ${TOKEN_PROGRAM_ID} invoke [2]`,
      `Program ${TOKEN_PROGRAM_ID} success`,
      eventLine(transferEvent(policy.mandate, dest, policy.budgetMint, 3_000_000n)),
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    const [item] = decodeTransaction(wire([ix], { logs }))
    expect(item).toMatchObject({
      kind: 'relay_transfer',
      ok: true,
      amount: 3_000_000n,
      recipient: dest,
      program: TOKEN_PROGRAM_ID,
      discriminatorName: 'transfer_checked',
    })
    expect(item?.event).toEqual({
      type: 'TransferExecuted',
      mandate: policy.mandate,
      destination: dest,
      mint: policy.budgetMint,
      amount: 3_000_000n,
    })
  })

  it('relay swap with its event', async () => {
    const ix = await relaySwapIx({
      agent,
      amountIn: 5_000_000n,
      minOut: 4_750_000n,
      deadlineSlot: 9n,
      policy,
    })
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      eventLine(
        swapEvent(policy.mandate, policy.swap!.poolState, 5_000_000n, 5_000_000n, 4_900_000n),
      ),
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    const [item] = decodeTransaction(wire([ix], { logs }))
    expect(item).toMatchObject({
      kind: 'relay_swap',
      amount: 5_000_000n,
      recipient: policy.swap!.outAccount,
      program: policy.swap!.ammProgram,
    })
    expect(item?.event).toMatchObject({
      type: 'SwapExecuted',
      amountInRequested: 5_000_000n,
      inDelta: 5_000_000n,
      outDelta: 4_900_000n,
    })
  })

  it('a raw SPL transfer_checked by the agent (the contrast demo) is a token_transfer', () => {
    const dest = fakeAddress(0xd1)
    const ix = transferCheckedIx({
      source: fakeAddress(0xd2),
      mint: fakeAddress(0xd3),
      destination: dest,
      authority: agent,
      amount: 77n,
      decimals: 6,
    })
    expect(decodeTransaction(wire([ix]))[0]).toMatchObject({
      kind: 'token_transfer',
      amount: 77n,
      recipient: dest,
      discriminatorName: 'transfer_checked',
    })
  })

  it('swap on the mock AMM resolves the registry name', async () => {
    const [item] = decodeTransaction(
      wire([
        verifyIx({
          mandate,
          owner,
          agent,
          targetProgram: MOCK_AMM_PROGRAM_ID,
          discriminator: SWAP_BASE_INPUT_DISC,
          amount: 5n,
        }),
      ]),
    )
    expect(item?.discriminatorName).toBe('swap_base_input')
  })

  it('a transaction with nothing recognisable yields one unknown row (nothing silently dropped)', () => {
    const items = decodeTransaction({
      signature: SIG,
      slot: 1n,
      blockTime: null,
      err: null,
      logs: [],
      accountKeys: [owner, fakeAddress(0xee)],
      instructions: [{ programIdIndex: 1, accounts: [0], data: b58(Uint8Array.of(1, 2, 3)) }],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'unknown', instructionIndex: -1, blockTime: null })
  })

  it('unknown AgentAuth / relay tags are rows of kind unknown, not crashes', () => {
    const tx = wire([
      { programAddress: AGENT_AUTH_PROGRAM_ID, accounts: [], data: Uint8Array.of(99) },
      { programAddress: RELAY_PROGRAM_ID, accounts: [], data: Uint8Array.of(77) },
    ])
    expect(kinds(tx)).toEqual(['unknown', 'unknown'])
  })

  it('truncated data never throws', () => {
    for (const programAddress of [AGENT_AUTH_PROGRAM_ID, RELAY_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
      for (let tag = 0; tag < 8; tag++) {
        expect(() =>
          decodeTransaction(wire([{ programAddress, accounts: [], data: Uint8Array.of(tag, 1) }])),
        ).not.toThrow()
      }
    }
  })
})

describe('failed transactions carry the decoded program error', () => {
  const failLine = (p: string, c: number): string =>
    `Program ${p} failed: custom program error: 0x${c.toString(16)}`

  it('verify failing with SpendLimitExceeded', () => {
    const tx = wire(
      [
        verifyIx({
          mandate,
          owner,
          agent,
          targetProgram: TOKEN_PROGRAM_ID,
          discriminator: TRANSFER_CHECKED_DISC,
          amount: 99n,
        }),
      ],
      {
        err: { InstructionError: [0, { Custom: 9 }] },
        logs: [`Program ${AGENT_AUTH_PROGRAM_ID} invoke [1]`, failLine(AGENT_AUTH_PROGRAM_ID, 9)],
      },
    )
    const [item] = decodeTransaction(tx)
    expect(item).toMatchObject({ kind: 'verify', ok: false, amount: 99n })
    expect(item?.error).toMatchObject({
      program: 'agent_auth',
      code: 9,
      name: 'SpendLimitExceeded',
    })
  })

  it('relay transfer rejected by the allowlist (relay 104) vs the same number from the Token program', async () => {
    const ix = await relayTransferIx({ agent, amount: 1n, destination: fakeAddress(0xf1), policy })
    const relayFail = decodeTransaction(
      wire([ix], {
        err: { InstructionError: [0, { Custom: 104 }] },
        logs: [`Program ${RELAY_PROGRAM_ID} invoke [1]`, failLine(RELAY_PROGRAM_ID, 104)],
      }),
    )[0]
    expect(relayFail?.error).toMatchObject({ program: 'relay', name: 'RecipientNotAllowed' })
    const tokenFail = decodeTransaction(
      wire([ix], {
        err: { InstructionError: [0, { Custom: 4 }] },
        logs: [
          `Program ${TOKEN_PROGRAM_ID} invoke [2]`,
          failLine(TOKEN_PROGRAM_ID, 4),
          failLine(RELAY_PROGRAM_ID, 4),
        ],
      }),
    )[0]
    expect(tokenFail?.error).toMatchObject({ program: 'token', name: 'OwnerMismatch' })
  })

  it('a direct agent transfer_checked that the Token program rejects (hot-wallet contrast)', () => {
    const ix = transferCheckedIx({
      source: fakeAddress(0xd2),
      mint: fakeAddress(0xd3),
      destination: fakeAddress(0xd1),
      authority: agent,
      amount: 5n,
      decimals: 6,
    })
    const [item] = decodeTransaction(
      wire([ix], {
        err: { InstructionError: [0, { Custom: 4 }] },
        logs: [`Program ${TOKEN_PROGRAM_ID} invoke [1]`, failLine(TOKEN_PROGRAM_ID, 4)],
      }),
    )
    expect(item).toMatchObject({ kind: 'token_transfer', ok: false })
    expect(item?.error?.name).toBe('OwnerMismatch')
  })

  it('a failed transaction without custom errors (e.g. blockhash) has ok:false and no error', () => {
    const [item] = decodeTransaction(
      wire(
        [
          verifyIx({
            mandate,
            owner,
            agent,
            targetProgram: TOKEN_PROGRAM_ID,
            discriminator: TRANSFER_CHECKED_DISC,
            amount: 1n,
          }),
        ],
        { err: 'BlockhashNotFound' },
      ),
    )
    expect(item?.ok).toBe(false)
    expect(item?.error).toBeUndefined()
  })
})

describe('relay events (Program data lines)', () => {
  it('decodes tags 1..5 with the documented layouts', () => {
    const m = fakeAddress(1)
    const p = fakeAddress(2)
    const e3 = new Uint8Array(66)
    e3[0] = 3
    e3.set(raw(m), 1)
    e3.set(raw(p), 33)
    e3[65] = 2
    const e4 = new Uint8Array(65)
    e4[0] = 4
    e4.set(raw(m), 1)
    e4.set(raw(p), 33)
    const e5 = new Uint8Array(34)
    e5[0] = 5
    e5.set(raw(m), 1)
    e5[33] = 1
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      eventLine([...e3]),
      eventLine([...e4]),
      eventLine([...e5]),
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    expect(decodeRelayEvents(logs, RELAY_PROGRAM_ID).map((e) => e.event)).toEqual([
      { type: 'PolicyInitialized', mandate: m, policy: p, flags: 2 },
      { type: 'PolicyClosed', mandate: m, policy: p },
      { type: 'PausedChanged', mandate: m, paused: true },
    ])
  })

  it('a data line printed by ANOTHER program cannot forge a relay event', () => {
    const forged = eventLine(transferEvent(mandate, fakeAddress(1), fakeAddress(2), 999n))
    const logs = [
      `Program ${fakeAddress(0x77)} invoke [1]`,
      forged,
      `Program ${fakeAddress(0x77)} success`,
    ]
    expect(decodeRelayEvents(logs, RELAY_PROGRAM_ID)).toEqual([])
    // ...and one printed by a program the relay called (nested) is also ignored
    const nested = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${fakeAddress(0x77)} invoke [2]`,
      forged,
      `Program ${fakeAddress(0x77)} success`,
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    expect(decodeRelayEvents(nested, RELAY_PROGRAM_ID)).toEqual([])
  })

  it('wrong lengths, unknown tags and garbage base64 are ignored', () => {
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      eventLine([1, 2, 3]),
      eventLine([...transferEvent(mandate, mandate, mandate, 1n), 0]),
      eventLine([9, ...new Array(104).fill(0)]),
      'Program data: !!!not base64!!!',
      'Program data: ',
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    expect(decodeRelayEvents(logs, RELAY_PROGRAM_ID)).toEqual([])
  })

  it('instruction index follows top-level invocations', () => {
    const ev = eventLine(transferEvent(mandate, fakeAddress(1), fakeAddress(2), 5n))
    const logs = [
      `Program ${fakeAddress(0x55)} invoke [1]`,
      `Program ${fakeAddress(0x55)} success`,
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      ev,
      `Program ${RELAY_PROGRAM_ID} success`,
    ]
    expect(decodeRelayEvents(logs, RELAY_PROGRAM_ID)[0]?.instructionIndex).toBe(1)
  })
})

describe('mandate filter', () => {
  it('keeps only instructions that reference the mandate or policy', async () => {
    const other = fakeAddress(0xbb)
    const tx = wire([
      await setActiveIx({ owner, mandate, active: true }),
      await setActiveIx({ owner, mandate: other, active: true }),
      await closePolicyIx({ owner, policy: policyAddr }),
    ])
    const items = decodeTransaction(tx, { mandate, policy: policyAddr })
    expect(items.map((i) => [i.kind, i.instructionIndex])).toEqual([
      ['set_active', 0],
      ['relay_close', 2],
    ])
  })
})

describe('toDecodableTransaction / getActivity (stub RPC)', () => {
  const rpcTx = (
    ixs: BuiltInstruction[],
    over: {
      err?: unknown
      logs?: string[]
      loaded?: { writable: string[]; readonly: string[] }
    } = {},
  ) => {
    const d = wire(ixs)
    return {
      slot: 100,
      blockTime: 1_800_000_000,
      meta: { err: over.err ?? null, logMessages: over.logs ?? [], loadedAddresses: over.loaded },
      transaction: { message: { accountKeys: d.accountKeys, instructions: d.instructions } },
    }
  }

  it('appends loaded (lookup table) addresses after the static keys', async () => {
    const t = toDecodableTransaction(SIG, {
      ...rpcTx([await setActiveIx({ owner, mandate, active: true })]),
      meta: {
        err: null,
        logMessages: null,
        loadedAddresses: { writable: ['W1'], readonly: ['R1'] },
      },
    })
    expect(t.accountKeys.slice(-2)).toEqual(['W1', 'R1'])
    expect(t.slot).toBe(100n)
    expect(t.logs).toEqual([])
  })

  it('getActivity merges mandate + policy signatures, newest first, with one row per instruction', async () => {
    const setActive = await setActiveIx({ owner, mandate, active: false })
    const close = await closePolicyIx({ owner, policy: policyAddr })
    const txs: Record<string, ReturnType<typeof rpcTx> | null> = {
      sigA: rpcTx([setActive]),
      sigB: rpcTx([close]),
      sigGone: null,
    }
    const sigInfo = (signature: string, slot: number, err: unknown = null) => ({
      signature,
      slot,
      blockTime: 1_800_000_000 + slot,
      err,
      confirmationStatus: 'finalized',
      memo: null,
    })
    const calls: string[] = []
    const rpc = {
      getSignaturesForAddress: (a: string) => ({
        send: async () =>
          a === mandate
            ? [sigInfo('sigA', 300), sigInfo('sigGone', 100)]
            : [sigInfo('sigB', 200), sigInfo('sigA', 300)],
      }),
      getTransaction: (sig: string) => {
        calls.push(sig)
        return { send: async () => txs[sig] ?? null }
      },
    } as unknown as ActivityRpc
    const items = await getActivity(rpc, { mandate, policy: policyAddr, limit: 10, concurrency: 2 })
    expect(items.map((i) => [i.signature, i.kind])).toEqual([
      ['sigA', 'set_active'],
      ['sigB', 'relay_close'],
      ['sigGone', 'unknown'],
    ])
    expect(calls.sort()).toEqual(['sigA', 'sigB', 'sigGone']) // sigA fetched once although listed twice
  })

  it('getActivity honours the limit, passes `before`, and keeps the failure flag of vanished transactions', async () => {
    const seen: unknown[] = []
    const rpc = {
      getSignaturesForAddress: (_a: string, cfg: unknown) => {
        seen.push(cfg)
        return {
          send: async () =>
            [1, 2, 3].map((n) => ({
              signature: `s${n}`,
              slot: n,
              blockTime: null,
              err: n === 2 ? { InstructionError: [0, { Custom: 9 }] } : null,
            })),
        }
      },
      getTransaction: () => ({ send: async () => null }),
    } as unknown as ActivityRpc
    const items = await getActivity(rpc, { mandate, limit: 2, before: 'prevSig' })
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.signature)).toEqual(['s3', 's2'])
    expect(items[1]?.ok).toBe(false)
    expect(seen[0]).toMatchObject({ limit: 2, before: 'prevSig' })
  })
})
