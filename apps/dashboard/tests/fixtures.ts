import {
  POLICY_FLAG_STRICT_TOP_LEVEL,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  builtinRegistry,
  explainMandate,
  fromHex,
  type Mandate,
  type Permission,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import { address, type Address } from '@solana/kit'
import { resolveConfig } from '@/lib/config'

// Real, valid base58 addresses (program ids and well-known accounts); nothing here is a secret.
export const OWNER = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z')
export const AGENT = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLaPSpXJ3b6Ax')
export const SOURCE = address('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1')
export const RECIPIENT = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
export const MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const MANDATE_ADDR = address('AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if')
export const POLICY_ADDR = address('33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6')
export const AUTHORITY = address('6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw')

export const TEST_CONFIG = resolveConfig({
  NEXT_PUBLIC_AA_CLUSTER: 'localnet',
  AA_RPC_URL: 'http://127.0.0.1:8899',
})

export function permission(over: Partial<Permission> = {}): Permission {
  const disc = fromHex(TRANSFER_CHECKED_DISC)
  return {
    index: 0,
    program: TOKEN_PROGRAM_ID,
    spendLimit: 20_000_000n,
    perTxLimit: 5_000_000n,
    spendUnlimited: false,
    perTxUnlimited: false,
    spendTotal: 3_000_000n,
    callCount: 1,
    discriminators: [disc],
    discriminatorsHex: [TRANSFER_CHECKED_DISC],
    ...over,
  }
}

export function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    address: MANDATE_ADDR,
    owner: OWNER,
    agent: AGENT,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    active: true,
    version: 1,
    bump: 255,
    permissions: [permission()],
    ...over,
  }
}

export function policy(over: Partial<RelayPolicy> = {}): RelayPolicy {
  return {
    address: POLICY_ADDR,
    version: 1,
    policyBump: 255,
    authorityBump: 254,
    flags: POLICY_FLAG_STRICT_TOP_LEVEL,
    paused: false,
    strictTopLevel: true,
    mandate: MANDATE_ADDR,
    owner: OWNER,
    agent: AGENT,
    authority: AUTHORITY,
    mandateExpiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: MINT,
    sourceAccount: SOURCE,
    recipients: [RECIPIENT],
    swap: null,
    ...over,
  }
}

export function explanation(opts: { paused?: boolean; withPolicy?: boolean } = {}) {
  const m = mandate({ active: !opts.paused })
  return explainMandate(m, {
    policy: opts.withPolicy === false ? null : policy(),
    registry: builtinRegistry,
    budgetDecimals: 6,
    delegation: { delegate: AUTHORITY, delegatedAmount: 20_000_000n },
  })
}

export type { Address }
