import {
  AGENT_AUTH_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  encodeRelayPolicyConfig,
  mandatePda,
  relayAuthorityPda,
  relayPolicyPda,
  type AgentAuthRpc,
  type RelayPolicyConfig,
} from '../src/index'
import type { Address } from '@solana/kit'
import { encodeMandateBytes, fakeAddress, raw } from './helpers'

export const W = {
  owner: fakeAddress(0x01),
  agent: fakeAddress(0x02),
  mint: fakeAddress(0x03),
  source: fakeAddress(0x04),
  dest: fakeAddress(0x05),
  NOW: 1_800_000_000n,
}
export const EXPIRY = W.NOW + 86_400n
export const CLOCK = 'SysvarC1ock11111111111111111111111111111111'

function tokenAccount(o: { delegate?: Address; delegated?: bigint; amount: bigint }): Uint8Array {
  const b = new Uint8Array(165)
  const dv = new DataView(b.buffer)
  b.set(raw(W.mint), 0)
  b.set(raw(W.owner), 32)
  dv.setBigUint64(64, o.amount, true)
  if (o.delegate) {
    dv.setUint32(72, 1, true)
    b.set(raw(o.delegate), 76)
    dv.setBigUint64(121, o.delegated ?? 0n, true)
  }
  b[108] = 1
  return b
}

/** A stub chain with a live mandate, relay policy, delegation, mint and Clock sysvar. */
export async function stubChain() {
  const m = await mandatePda(W.owner, W.agent)
  const pol = await relayPolicyPda(m.address)
  const auth = await relayAuthorityPda(m.address)
  const config: RelayPolicyConfig = {
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: W.mint,
    sourceAccount: W.source,
    recipients: [W.dest],
    swap: null,
  }
  const accounts = new Map<string, { owner: string; data: Uint8Array }>()
  accounts.set(m.address, {
    owner: AGENT_AUTH_PROGRAM_ID,
    data: encodeMandateBytes({
      owner: W.owner,
      agent: W.agent,
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
  const p = new Uint8Array(944)
  p[0] = 0xa7
  p[1] = 1
  p[2] = pol.bump
  p[3] = auth.bump
  p[4] = 2
  p.set(raw(m.address), 8)
  p.set(raw(W.owner), 40)
  p.set(raw(W.agent), 72)
  p.set(raw(auth.address), 104)
  new DataView(p.buffer).setBigInt64(136, EXPIRY, true)
  p.set(encodeRelayPolicyConfig(config), 144)
  accounts.set(pol.address, { owner: RELAY_PROGRAM_ID, data: p })
  accounts.set(W.source, {
    owner: TOKEN_PROGRAM_ID,
    data: tokenAccount({ amount: 4_000_000n, delegate: auth.address, delegated: 3_800_000n }),
  })
  accounts.set(W.dest, { owner: TOKEN_PROGRAM_ID, data: tokenAccount({ amount: 0n }) })
  const mint = new Uint8Array(82)
  mint[44] = 6
  mint[45] = 1
  accounts.set(W.mint, { owner: TOKEN_PROGRAM_ID, data: mint })
  const clock = new Uint8Array(40)
  new DataView(clock.buffer).setBigInt64(32, W.NOW, true)
  accounts.set(CLOCK, { owner: SYSTEM_PROGRAM_ID, data: clock })
  const value = (a: string) => {
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
  }
  const rpc = {
    getAccountInfo: (a: string) => ({ send: async () => ({ value: value(a) }) }),
    getMultipleAccounts: (l: string[]) => ({ send: async () => ({ value: l.map(value) }) }),
    getProgramAccounts: () => ({
      send: async () => [
        {
          pubkey: m.address,
          account: { ...value(m.address)!, owner: AGENT_AUTH_PROGRAM_ID },
        },
      ],
    }),
    getSlot: () => ({ send: async () => 1000n }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4',
          lastValidBlockHeight: 99n,
        },
      }),
    }),
    getSignaturesForAddress: () => ({ send: async () => [] }),
  } as unknown as AgentAuthRpc
  return { rpc, mandate: m.address, policy: pol.address, authority: auth.address, accounts }
}
