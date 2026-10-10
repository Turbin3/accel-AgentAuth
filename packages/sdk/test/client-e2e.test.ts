import { describe, expect, it } from 'vitest'
import { address, type Address } from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  createClient,
  decodeRelayPolicy,
  encodeRelayPolicyConfig,
  mandatePda,
  relayAuthorityPda,
  relayPolicyPda,
  type AgentAuthRpc,
  type RelayPolicyConfig,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, raw } from './helpers'

const owner = fakeAddress(0x01)
const agent = fakeAddress(0x02)
const mint = fakeAddress(0x03)
const source = fakeAddress(0x04)
const dest = fakeAddress(0x05)
const NOW = 1_800_000_000n
const EXPIRY = NOW + 86_400n

function tokenAccount(o: {
  mint: Address
  owner: Address
  amount: bigint
  delegate?: Address
  delegated?: bigint
}): Uint8Array {
  const b = new Uint8Array(165)
  const dv = new DataView(b.buffer)
  b.set(raw(o.mint), 0)
  b.set(raw(o.owner), 32)
  dv.setBigUint64(64, o.amount, true)
  if (o.delegate) {
    dv.setUint32(72, 1, true)
    b.set(raw(o.delegate), 76)
    dv.setBigUint64(121, o.delegated ?? 0n, true)
  }
  b[108] = 1
  return b
}

/** Policy account bytes assembled per RELAY-SPEC 5.2 (header + the SDK-encoded config region). */
function policyBytes(o: {
  mandate: Address
  policyBump: number
  authorityBump: number
  authority: Address
  expiry: bigint
  flags: number
  config: RelayPolicyConfig
}): Uint8Array {
  const b = new Uint8Array(944)
  b[0] = 0xa7
  b[1] = 1
  b[2] = o.policyBump
  b[3] = o.authorityBump
  b[4] = o.flags
  b.set(raw(o.mandate), 8)
  b.set(raw(owner), 40)
  b.set(raw(agent), 72)
  b.set(raw(o.authority), 104)
  new DataView(b.buffer).setBigInt64(136, o.expiry, true)
  b.set(encodeRelayPolicyConfig(o.config), 144)
  return b
}

async function world() {
  const m = await mandatePda(owner, agent)
  const pol = await relayPolicyPda(m.address)
  const auth = await relayAuthorityPda(m.address)
  const config: RelayPolicyConfig = {
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: mint,
    sourceAccount: source,
    recipients: [dest],
    swap: null,
  }
  const accounts = new Map<string, { owner: Address; data: Uint8Array }>()
  accounts.set(m.address, {
    owner: AGENT_AUTH_PROGRAM_ID,
    data: encodeMandateBytes({
      owner,
      agent,
      expiry: EXPIRY,
      bump: m.bump,
      permissions: [
        {
          program: TOKEN_PROGRAM_ID,
          spendLimit: 5_000_000n,
          perTxLimit: 1_000_000n,
          spendTotal: 1_200_000n,
          discs: [TRANSFER_CHECKED_DISC],
        },
      ],
    }),
  })
  accounts.set(pol.address, {
    owner: RELAY_PROGRAM_ID,
    data: policyBytes({
      mandate: m.address,
      policyBump: pol.bump,
      authorityBump: auth.bump,
      authority: auth.address,
      expiry: EXPIRY,
      flags: 2,
      config,
    }),
  })
  accounts.set(source, {
    owner: TOKEN_PROGRAM_ID,
    data: tokenAccount({
      mint,
      owner,
      amount: 4_000_000n,
      delegate: auth.address,
      delegated: 3_800_000n,
    }),
  })
  accounts.set(dest, {
    owner: TOKEN_PROGRAM_ID,
    data: tokenAccount({ mint, owner: fakeAddress(0x77), amount: 0n }),
  })
  const mintBytes = new Uint8Array(82)
  mintBytes[44] = 6
  mintBytes[45] = 1
  accounts.set(mint, { owner: TOKEN_PROGRAM_ID, data: mintBytes })
  const rpc = {
    getAccountInfo: (a: string) => ({
      send: async () => {
        const acc = accounts.get(a)
        return {
          value: acc
            ? {
                owner: acc.owner,
                data: [Buffer.from(acc.data).toString('base64'), 'base64'],
                lamports: 1n,
                executable: false,
                space: BigInt(acc.data.length),
                rentEpoch: 0n,
              }
            : null,
        }
      },
    }),
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({
        value: list.map((a) => {
          const acc = accounts.get(a)
          return acc
            ? {
                owner: acc.owner,
                data: [Buffer.from(acc.data).toString('base64'), 'base64'],
                lamports: 1n,
                executable: false,
                space: BigInt(acc.data.length),
                rentEpoch: 0n,
              }
            : null
        }),
      }),
    }),
    getProgramAccounts: () => ({ send: async () => [] }),
    getSlot: () => ({ send: async () => 1000n }),
  } as unknown as AgentAuthRpc
  return { rpc, mandate: m.address, policy: pol.address, authority: auth.address, accounts }
}

describe('client against a stub chain with a live mandate, policy and delegation', () => {
  it('inspect: mandate + policy + delegation => explanation with the honest wording', async () => {
    const w = await world()
    const client = createClient({ rpc: w.rpc })
    const view = await client.inspect(w.mandate, { now: NOW, budgetDecimals: 6 })
    expect(view.mandate?.owner).toBe(owner)
    expect(view.policy?.authority).toBe(w.authority)
    expect(view.explanation?.status).toBe('active')
    expect(view.explanation?.enforcement[0]?.level).toBe('hard (relay)')
    // delegated 3.8 == remaining mandate budget 3.8, so no over-delegation warning
    expect(view.explanation?.warnings.join(' ')).not.toContain(
      'larger than the remaining mandate budget',
    )
    expect(view.explanation?.cannot.join(' ')).toContain('Move more than 3.8 (3800000 raw units)')
  })

  it('policy decodes round-trip through the SDK encoder (config region)', async () => {
    const w = await world()
    const p = decodeRelayPolicy(w.accounts.get(w.policy)!.data, w.policy)
    expect(p.recipients).toEqual([dest])
    expect(p.swap).toBeNull()
    expect(p.strictTopLevel).toBe(true)
  })

  it('preflightTransfer: ok, then each live-state failure maps to the relay/verify code', async () => {
    const w = await world()
    const client = createClient({ rpc: w.rpc })
    const ok = await client.preflightTransfer({
      owner,
      agent,
      destination: dest,
      amount: 1_000_000n,
      now: NOW,
    })
    expect(ok.ok).toBe(true)
    const tooBig = await client.preflightTransfer({
      owner,
      agent,
      destination: dest,
      amount: 1_000_001n,
      now: NOW,
    })
    expect(tooBig).toMatchObject({ ok: false, program: 'agent_auth', code: 8 })
    const notListed = await client.preflightTransfer({
      owner,
      agent,
      destination: fakeAddress(0x66),
      amount: 1n,
      now: NOW,
    })
    expect(notListed).toMatchObject({ ok: false, program: 'relay', code: 104 })
    const expired = await client.preflightTransfer({
      owner,
      agent,
      destination: dest,
      amount: 1n,
      now: EXPIRY,
    })
    expect(expired).toMatchObject({ ok: false, program: 'agent_auth', code: 5 })
    // revoke the delegation on the stub chain => 105
    w.accounts.set(source, {
      owner: TOKEN_PROGRAM_ID,
      data: tokenAccount({ mint, owner, amount: 4_000_000n }),
    })
    expect(
      await client.preflightTransfer({ owner, agent, destination: dest, amount: 1n, now: NOW }),
    ).toMatchObject({ ok: false, program: 'relay', code: 105 })
    // close the policy => 101
    w.accounts.delete(w.policy)
    expect(
      await client.preflightTransfer({ owner, agent, destination: dest, amount: 1n, now: NOW }),
    ).toMatchObject({ ok: false, program: 'relay', code: 101 })
  })

  it('preflightSwap without a swap policy => relay 110', async () => {
    const w = await world()
    const client = createClient({ rpc: w.rpc })
    const r = await client.preflightSwap({
      owner,
      agent,
      amountIn: 1n,
      minOut: 0n,
      deadlineSlot: 1010n,
      now: NOW,
    })
    expect(r).toMatchObject({ ok: false, program: 'relay', code: 110 })
  })

  it('plan helpers read the chain: onboarding refuses because a mandate already exists; unwind skips nothing', async () => {
    const w = await world()
    const client = createClient({ rpc: w.rpc })
    await expect(
      client.plan.onboarding({
        owner,
        agent,
        expiry: EXPIRY + 1n,
        now: NOW,
        token: { mint, source, delegateCap: 1_000_000n },
        permissions: [
          {
            program: TOKEN_PROGRAM_ID,
            spendLimit: 5_000_000n,
            perTxLimit: 1_000_000n,
            discriminators: [TRANSFER_CHECKED_DISC],
          },
        ],
        recipients: [dest],
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFUSED' })
    const unwind = await client.plan.unwind({ owner, agent })
    expect(unwind.steps[0]!.instructions.map((i) => i.data[0])).toEqual([5, 4, 2])
  })

  it('mock AMM / swap permission constants stay wired (guards accidental renames)', () => {
    expect(SWAP_BASE_INPUT_DISC).toHaveLength(16)
    expect(address(MOCK_AMM_PROGRAM_ID)).toBe(MOCK_AMM_PROGRAM_ID)
  })
})
