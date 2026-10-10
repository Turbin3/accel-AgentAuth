import { fetchRawAccount, TOKEN_PROGRAM_ID, type Client } from '@agentauth-sol/sdk'
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from '@solana/kit'
import type { SwapPoolInfo } from './wizard'

/** Raydium CP-Swap `PoolState` field offsets (8-byte Anchor discriminator, then 32-byte keys). */
const OFFSETS = {
  ammConfig: 8,
  token0Vault: 72,
  token1Vault: 104,
  token0Mint: 168,
  token1Mint: 200,
  token0Program: 232,
  token1Program: 264,
  observation: 296,
} as const
const MIN_LEN = 328

export interface CpmmPool {
  readonly ammConfig: Address
  readonly token0Vault: Address
  readonly token1Vault: Address
  readonly token0Mint: Address
  readonly token1Mint: Address
  readonly token0Program: Address
  readonly token1Program: Address
  readonly observation: Address
}

/** Decode the fields the relay pins from a Raydium CPMM pool-state account. */
export function decodeCpmmPool(data: Uint8Array): CpmmPool {
  if (data.length < MIN_LEN) {
    throw new Error(
      `This account is ${data.length} bytes; a Raydium CPMM pool state is at least ${MIN_LEN}.`,
    )
  }
  const decoder = getAddressDecoder()
  const at = (offset: number): Address => decoder.decode(data.subarray(offset, offset + 32))
  return {
    ammConfig: at(OFFSETS.ammConfig),
    token0Vault: at(OFFSETS.token0Vault),
    token1Vault: at(OFFSETS.token1Vault),
    token0Mint: at(OFFSETS.token0Mint),
    token1Mint: at(OFFSETS.token1Mint),
    token0Program: at(OFFSETS.token0Program),
    token1Program: at(OFFSETS.token1Program),
    observation: at(OFFSETS.observation),
  }
}

async function cpmmAuthority(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
  })
  return pda
}

/**
 * Read a pool from the chain and resolve its direction from the mint of the owner's source account.
 * Checks the account is owned by the Raydium CPMM program and that both legs are classic SPL Token.
 */
export async function resolveCpmmPool(
  client: Client,
  poolState: Address,
  sourceMint: Address,
): Promise<SwapPoolInfo> {
  const program = client.programIds.raydiumCpmm
  const raw = await fetchRawAccount(client.rpc, poolState)
  if (!raw) throw new Error('No account exists at that address on this cluster.')
  if (raw.ownerProgram !== program) {
    throw new Error(`That account is not owned by the Raydium CPMM program (${program}).`)
  }
  const pool = decodeCpmmPool(raw.data)
  if (pool.token0Program !== TOKEN_PROGRAM_ID || pool.token1Program !== TOKEN_PROGRAM_ID) {
    throw new Error('Only pools of two classic SPL Token mints are supported by the relay.')
  }
  const forward = sourceMint === pool.token0Mint
  if (!forward && sourceMint !== pool.token1Mint) {
    throw new Error('Your source account holds a mint that this pool does not trade.')
  }
  const outMint = forward ? pool.token1Mint : pool.token0Mint
  const out = await client.fetchMint(outMint)
  if (!out) throw new Error('The pool output mint does not exist on this cluster.')
  return {
    kind: 'cpmm',
    label: 'Raydium CPMM pool',
    ammProgram: program,
    ammAuthority: await cpmmAuthority(program),
    ammConfig: pool.ammConfig,
    poolState,
    inputVault: forward ? pool.token0Vault : pool.token1Vault,
    outputVault: forward ? pool.token1Vault : pool.token0Vault,
    observationState: pool.observation,
    inMint: sourceMint,
    outMint,
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    outDecimals: out.decimals,
  }
}

/** Test helper: encode keys at the CPMM offsets. */
export function encodeCpmmPoolForTest(pool: CpmmPool): Uint8Array {
  const out = new Uint8Array(MIN_LEN + 64)
  const enc = getAddressEncoder()
  const put = (offset: number, a: Address) => out.set(enc.encode(a), offset)
  put(OFFSETS.ammConfig, pool.ammConfig)
  put(OFFSETS.token0Vault, pool.token0Vault)
  put(OFFSETS.token1Vault, pool.token1Vault)
  put(OFFSETS.token0Mint, pool.token0Mint)
  put(OFFSETS.token1Mint, pool.token1Mint)
  put(OFFSETS.token0Program, pool.token0Program)
  put(OFFSETS.token1Program, pool.token1Program)
  put(OFFSETS.observation, pool.observation)
  return out
}
