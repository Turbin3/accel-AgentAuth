import type { Address } from '@solana/kit'
import { getAddressEncoder } from '@solana/kit'
import {
  TOKEN_PROGRAM_ID,
  createClient,
  type Client,
  type Mandate,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import { fakeClient } from './helpers'

export const NOW = 1_800_000_000n
export const OWNER = '3YhwEJsgRiwZQ6H8e7iRttvNxmh9gecHbyga9dwcjR1u' as Address
export const AGENT = '9BxwKg2P7NydhASpiSMt2Cahrbfe6rQBDM6i4fw2WPou' as Address
export const MINT = 'BycYxSzMrVVPc66F3rzP1AqLYN3qezLVyErqYuMdRRZ6' as Address
export const SOURCE = 'C3udYWScUbRPYmrQ7gp9MPs1QtbRvK9Vg4Smdf1y1wpZ' as Address
export const RECIPIENT = 'E5gtaymVr9FmjrnWm3HXVCdsZiSnDSkKJFT8m2TWi8VX' as Address
export const ATTACKER = '6XuR9JY9W7Gp513nkwwoqHt5njTqRXT6F5UnYdRbdM1z' as Address
export const MANDATE = '6hkeYMvXRNaqGu5X4acKjNVZLPfybxxphbRhdLuDmN3m' as Address
export const AUTHORITY = 'FF1rzczLh9zX2ZBZYcQuPbdhRKcs1KBVJZfdmmm2Kf9P' as Address

const enc = getAddressEncoder()

function tokenAccountBytes(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const data = new Uint8Array(165)
  data.set(enc.encode(mint), 0)
  data.set(enc.encode(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1
  return data
}

function mintBytes(decimals: number): Uint8Array {
  const data = new Uint8Array(82)
  data[44] = decimals
  data[45] = 1
  return data
}

function toRpcValue(data: Uint8Array) {
  return {
    data: [Buffer.from(data).toString('base64'), 'base64'],
    owner: TOKEN_PROGRAM_ID,
    lamports: 2_039_280n,
    executable: false,
  }
}

/** A tiny RPC that knows the mint and three token accounts (owner source, recipient, attacker). */
export function fakeRpc() {
  const accounts: Record<string, Uint8Array> = {
    [MINT]: mintBytes(6),
    [SOURCE]: tokenAccountBytes(MINT, OWNER, 1_000_000_000n),
    [RECIPIENT]: tokenAccountBytes(MINT, '11111111111111111111111111111112' as Address, 0n),
    [ATTACKER]: tokenAccountBytes(MINT, '11111111111111111111111111111112' as Address, 0n),
  }
  return {
    getAccountInfo: (address: string) => ({
      send: async () => {
        const data = accounts[address]
        return { value: data === undefined ? null : toRpcValue(data) }
      },
    }),
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({
        value: addresses.map((a) => (accounts[a] === undefined ? null : toRpcValue(accounts[a]))),
      }),
    }),
    getSlot: () => ({ send: async () => 1234n }),
  }
}

export const policy: RelayPolicy = {
  address: undefined,
  version: 1,
  policyBump: 255,
  authorityBump: 254,
  flags: 2,
  paused: false,
  strictTopLevel: true,
  mandate: MANDATE,
  owner: OWNER,
  agent: AGENT,
  authority: AUTHORITY,
  mandateExpiry: NOW + 86_400n,
  tokenProgram: TOKEN_PROGRAM_ID,
  budgetMint: MINT,
  sourceAccount: SOURCE,
  recipients: [RECIPIENT],
  swap: null,
}

export const mandate: Mandate = {
  address: MANDATE,
  owner: OWNER,
  agent: AGENT,
  expiry: NOW + 86_400n,
  active: true,
  version: 1,
  bump: 255,
  permissions: [
    {
      index: 0,
      program: TOKEN_PROGRAM_ID,
      spendLimit: 20_000_000n,
      perTxLimit: 5_000_000n,
      spendUnlimited: false,
      perTxUnlimited: false,
      spendTotal: 3_000_000n,
      callCount: 1,
      discriminators: [Uint8Array.from([12, 0, 0, 0, 0, 0, 0, 0])],
      discriminatorsHex: ['0c00000000000000'],
    },
  ],
}

/** The real SDK client on a fake RPC, with chain-dependent methods replaced by the test. */
export function mkClient(overrides: Record<string, unknown> = {}): Client {
  const real = createClient({
    cluster: 'devnet',
    rpc: fakeRpc() as unknown as NonNullable<Parameters<typeof createClient>[0]>['rpc'],
  })
  return fakeClient({
    ...real,
    getClusterTime: async () => NOW,
    fetchMandateFor: async () => ({ address: MANDATE, mandate }),
    fetchMandate: async () => null,
    fetchPolicy: async () => policy,
    ...overrides,
  })
}
