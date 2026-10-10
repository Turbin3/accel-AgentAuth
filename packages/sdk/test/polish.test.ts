import { describe, expect, it } from 'vitest'
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AGENT_AUTH_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  createMandateIx,
  dedupeWarnings,
  decodeMandate,
  decodeRelayPolicy,
  describeProgram,
  explainMandate,
  fetchMandatesByAgent,
  fetchMandatesByOwner,
  getActivity,
  getActivityPage,
  relayTransferIx,
  sendAndConfirmStep,
  verifyIx,
  type ActivityRpc,
  type AgentAuthRpc,
  type BuiltInstruction,
  type RegistryLike,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, fixtureBin } from './helpers'

const BLOCKHASH = {
  blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4',
  lastValidBlockHeight: 99n,
}

describe('F11 wording', () => {
  it('the plan no longer calls the mandate or the config immutable', async () => {
    const src = readFileSync(fileURLToPath(new URL('../src/plans.ts', import.meta.url)), 'utf8')
    expect(src).not.toContain('immutable afterwards')
    expect(src).toContain('cannot be edited in place; close the policy and initialise a new one')
  })
})

describe('sendAndConfirmStep includeLogs', () => {
  function sendRpc(logs: string[]) {
    let txFetches = 0
    const rpc = {
      getLatestBlockhash: () => ({ send: async () => ({ value: BLOCKHASH }) }),
      sendTransaction: () => ({ send: async () => 'sig' }),
      getSignatureStatuses: () => ({
        send: async () => ({ value: [{ slot: 5n, confirmationStatus: 'confirmed', err: null }] }),
      }),
      getBlockHeight: () => ({ send: async () => 1n }),
      getTransaction: () => ({
        send: async () => {
          txFetches++
          return { meta: { logMessages: logs } }
        },
      }),
    } as unknown as AgentAuthRpc
    return { rpc, fetches: () => txFetches }
  }
  it('a successful transaction carries its logs by default and skips the fetch with includeLogs:false', async () => {
    const owner = await generateKeyPairSigner()
    const ix = await createMandateIx({
      owner: owner.address,
      agent: fakeAddress(2),
      expiry: 1_900_000_000n,
    })
    const a = sendRpc(['Program log: hello'])
    const r = await sendAndConfirmStep(a.rpc, [ix], { signers: [owner] })
    expect(r).toMatchObject({ ok: true, logs: ['Program log: hello'] })
    expect(a.fetches()).toBe(1)
    const b = sendRpc(['Program log: hello'])
    const r2 = await sendAndConfirmStep(b.rpc, [ix], { signers: [owner], includeLogs: false })
    expect(r2.logs).toEqual([])
    expect(b.fetches()).toBe(0)
  })
})

const fixturePolicy = decodeRelayPolicy(fixtureBin('policy_example.bin'), fakeAddress(0xa4))

function mandateFor(policy = fixturePolicy) {
  return decodeMandate(
    encodeMandateBytes({
      owner: policy.owner,
      agent: policy.agent,
      expiry: policy.mandateExpiry,
      permissions: [
        {
          program: policy.tokenProgram,
          spendLimit: 5_000_000n,
          perTxLimit: 1_000_000n,
          spendTotal: 1_000_000n,
          callCount: 1,
          discs: [TRANSFER_CHECKED_DISC],
        },
      ],
    }),
    policy.mandate,
  )
}

describe('explainMandate budgetSymbol / mintLabels / de-duplicated warnings', () => {
  const now = fixturePolicy.mandateExpiry - 86_400n
  const mandate = mandateFor()
  it('unchanged without a symbol', () => {
    const e = explainMandate(mandate, { policy: fixturePolicy, budgetDecimals: 6, now })
    expect(e.can.join('\n')).toMatch(/Pay token /)
    expect(e.limits[0]?.text).toMatch(/raw units/)
  })
  it('reads "Pay DUSD ..." and "4 DUSD" with a symbol', () => {
    const e = explainMandate(mandate, {
      policy: fixturePolicy,
      budgetDecimals: 6,
      budgetSymbol: 'DUSD',
      now,
    })
    expect(e.can.concat(e.cannot).join('\n')).toContain('Pay DUSD from')
    expect(e.limits[0]?.text).toContain('1 DUSD')
    expect(e.limits[0]?.text).toContain('4 DUSD of 5 DUSD lifetime budget left')
    expect(e.limits[0]?.text).not.toContain('raw units')
  })
  it('mintLabels override the symbol for that mint', () => {
    const e = explainMandate(mandate, {
      policy: fixturePolicy,
      budgetSymbol: 'DUSD',
      mintLabels: { [fixturePolicy.budgetMint]: 'Dummy USD' },
      now,
    })
    expect(e.can.concat(e.cannot).join('\n')).toContain('Pay Dummy USD from')
  })
  it('drops a warning that is a prefix of another and keeps the longer text', () => {
    const e = explainMandate(mandate, { policy: fixturePolicy, now })
    const short =
      'Recipients are token accounts, not wallets: the relay pins the account, not its owner.'
    const merged = dedupeWarnings([short], e.warnings)
    expect(merged.filter((w) => w.startsWith('Recipients are token accounts'))).toHaveLength(1)
    expect(merged.some((w) => w.length > short.length && w.startsWith(short.slice(0, -1)))).toBe(
      true,
    )
    expect(dedupeWarnings(['a.', 'a.', 'b'])).toEqual(['a.', 'b'])
    expect(new Set(e.warnings).size).toBe(e.warnings.length)
  })
})

describe('describeProgram', () => {
  it('uses the registry, then the built-in table, then a short address', () => {
    const reg: RegistryLike = {
      getProgramById: (id) => (id === fakeAddress(9) ? { name: 'Mine', instructions: [] } : null),
    }
    expect(describeProgram(fakeAddress(9), reg)).toBe('Mine')
    expect(describeProgram(TOKEN_PROGRAM_ID)).toBe('SPL Token')
    const unknown = fakeAddress(7)
    expect(describeProgram(unknown)).toBe(`${unknown.slice(0, 4)}…${unknown.slice(-4)}`)
    const bad: RegistryLike = {
      getProgramById: () => {
        throw new Error('boom')
      },
    }
    expect(describeProgram(TOKEN_PROGRAM_ID, bad)).toBe('SPL Token')
  })
})

describe('Mandate.address is populated by the listings', () => {
  it('fetchMandatesByOwner / ByAgent return the account key', async () => {
    const pubkey = fakeAddress(0x61)
    const owner = fakeAddress(0x62)
    const agent = fakeAddress(0x63)
    const bytes = encodeMandateBytes({ owner, agent, expiry: 1_900_000_000n, permissions: [] })
    const rpc = {
      getProgramAccounts: () => ({
        send: async () => [
          {
            pubkey,
            account: {
              owner: AGENT_AUTH_PROGRAM_ID,
              lamports: 1n,
              executable: false,
              data: [Buffer.from(bytes).toString('base64'), 'base64'],
            },
          },
        ],
      }),
    } as never
    for (const list of [
      fetchMandatesByOwner(rpc, owner, { verifyAddress: false }),
      fetchMandatesByAgent(rpc, agent, { verifyAddress: false }),
    ]) {
      const [m] = await list
      expect(m?.address).toBe(pubkey)
    }
  })
})

describe('getActivity foldVerify / stopAtCreation', () => {
  const b58 = (b: Uint8Array): string => getBase58Decoder().decode(b)
  const sigInfo = (signature: string, slot: number) => ({
    signature,
    slot,
    blockTime: null,
    err: null,
  })
  function txOf(top: BuiltInstruction[], inner: { index: number; ix: BuiltInstruction }[]) {
    const keys: string[] = []
    const idx = (k: string): number => {
      let i = keys.indexOf(k)
      if (i < 0) {
        keys.push(k)
        i = keys.length - 1
      }
      return i
    }
    const wire = (ix: BuiltInstruction) => ({
      programIdIndex: idx(ix.programAddress),
      accounts: ix.accounts.map((a) => idx(a.address)),
      data: b58(ix.data),
    })
    const instructions = top.map(wire)
    const innerInstructions = inner.map((i) => ({ index: i.index, instructions: [wire(i.ix)] }))
    return {
      slot: 10,
      blockTime: null,
      meta: { err: null, logMessages: [], innerInstructions },
      transaction: { message: { accountKeys: keys, instructions } },
    }
  }
  const mandate = fixturePolicy.mandate
  async function relayTx() {
    const top = await relayTransferIx({
      agent: fixturePolicy.agent,
      amount: 3_000_000n,
      destination: fixturePolicy.recipients[0]!,
      policy: fixturePolicy,
    })
    const v = verifyIx({
      mandate,
      owner: fixturePolicy.owner,
      agent: fixturePolicy.agent,
      targetProgram: TOKEN_PROGRAM_ID,
      discriminator: TRANSFER_CHECKED_DISC,
      amount: 3_000_000n,
    })
    return txOf([top], [{ index: 0, ix: v }])
  }
  function rpcFor(txs: Record<string, unknown>, sigs: ReturnType<typeof sigInfo>[]) {
    return {
      getSignaturesForAddress: () => ({ send: async () => sigs }),
      getTransaction: (s: string) => ({ send: async () => txs[s] ?? null }),
    } as unknown as ActivityRpc
  }

  it('foldVerify merges the nested relay verify row into the relay row', async () => {
    const rpc = rpcFor({ s1: await relayTx() }, [sigInfo('s1', 10)])
    const plain = await getActivity(rpc, { mandate, limit: 5 })
    expect(plain.map((r) => r.kind).sort()).toEqual(['relay_transfer', 'verify'])
    const folded = await getActivity(rpc, { mandate, limit: 5, foldVerify: true })
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ kind: 'relay_transfer' })
    expect(folded[0]?.verify).toMatchObject({
      kind: 'verify',
      viaProgram: RELAY_PROGRAM_ID,
      amount: 3_000_000n,
      program: TOKEN_PROGRAM_ID,
    })
  })

  it('stopAtCreation drops rows older than the latest successful create', async () => {
    const agent = fixturePolicy.agent
    const owner = fixturePolicy.owner
    const create = await createMandateIx({ owner, agent, expiry: 1_900_000_000n, mandate })
    const txs = {
      sNew: txOf([create], []),
      sMid: await relayTx(),
      sOldCreate: txOf([create], []),
      sOld: await relayTx(),
    }
    const rpc = rpcFor(txs, [
      sigInfo('sMid', 30),
      sigInfo('sNew', 20),
      sigInfo('sOldCreate', 10),
      sigInfo('sOld', 5),
    ])
    const all = await getActivity(rpc, { mandate, limit: 10 })
    expect(all.some((r) => r.signature === 'sOld')).toBe(true)
    const page = await getActivityPage(rpc, { mandate, limit: 10, stopAtCreation: true })
    expect(page.nextBefore).toBeNull()
    expect([...new Set(page.items.map((r) => r.signature))]).toEqual(['sMid', 'sNew'])
    expect(page.items.at(-1)).toMatchObject({ kind: 'create', signature: 'sNew' })
  })
})

describe('loadRegistry keeps the bundler-ignore comments in the build', () => {
  it('src has both magic comments next to the dynamic import', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/registry.ts', import.meta.url)), 'utf8')
    expect(src).toContain('webpackIgnore: true')
    expect(src).toContain('turbopackIgnore: true')
  })
})
