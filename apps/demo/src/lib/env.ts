import {
  createClient,
  decodeTokenAccount,
  fetchRawAccount,
  programIds,
  TOKEN_PROGRAM_ID,
  type Client,
  type ProgramIds,
  type SwapConfig,
  type TokenAccountView,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'
import { createConfirmedRpc, type DemoChain } from './chain'
import { endpointsFromEnv } from './config'
import { loadWalletSigners, type DemoSigners } from './keys'
import { readState, type DemoState } from './state'

/**
 * The environment every demo app shares: the public state written by `bootstrap`, the endpoints
 * (honouring `AA_RPC_URL` / `AA_WS_URL`) and the SDK program ids. Contains no secret.
 */
export interface DemoEnv extends DemoState {
  readonly programIds: ProgramIds
}

/**
 * Load the environment written by `pnpm --filter @agentauth-sol/demo bootstrap`.
 * Throws a message telling the user what to run when it does not exist.
 */
export async function loadDemoEnv(): Promise<DemoEnv> {
  const state = await readState()
  const overridden =
    process.env['AA_RPC_URL'] !== undefined || process.env['AA_WS_URL'] !== undefined
  const { rpcUrl, wsUrl } = overridden ? endpointsFromEnv() : state
  return { ...state, rpcUrl, wsUrl, programIds: programIds('localnet') }
}

/** Load the signers of the cast from `.demo/keys` and check them against the public state. */
export async function loadDemoSigners(env: DemoEnv): Promise<DemoSigners> {
  const signers = await loadWalletSigners()
  for (const [role, signer] of Object.entries(signers)) {
    const expected = env.wallets[role as keyof DemoSigners]
    if (signer.address !== expected) {
      throw new Error(
        `.demo/keys/${role}.json does not match .demo/state.json (${role}); delete .demo and bootstrap again`,
      )
    }
  }
  return signers
}

/** An SDK client wired to the local validator (reads at `confirmed`, see {@link createConfirmedRpc}) and the local program ids. */
export function demoClient(env: DemoEnv): Client {
  return createClient({
    cluster: 'localnet',
    rpc: createConfirmedRpc(env.rpcUrl),
    programIds: env.programIds,
  })
}

/** Relay floor price and deadline window used by the scripted demo (DEMO-SCRIPT: 95 out per 100 in, 150 slots). */
export const DEFAULT_SWAP_FLOOR = { floorOut: 95n, floorIn: 100n, maxDeadlineSlots: 150 } as const

/**
 * The relay policy swap config for the bootstrapped pool: DUSD in from the owner's DUSD account,
 * DOUT out to the owner's own DOUT account, through the mock AMM (Raydium CP-Swap ABI).
 * Pass it as `swap` of `client.plan.onboarding` (add `delegateCap` only if `inAccount` differs from
 * the token source; here they are the same account).
 */
export function demoSwapConfig(
  env: DemoEnv,
  floor: { floorOut: bigint; floorIn: bigint; maxDeadlineSlots: number } = DEFAULT_SWAP_FLOOR,
): SwapConfig {
  return {
    ammProgram: env.programIds.mockAmm,
    ammAuthority: env.pool.authority,
    ammConfig: env.pool.config,
    poolState: env.pool.state,
    inputVault: env.pool.vaultDusd,
    outputVault: env.pool.vaultDout,
    observationState: env.pool.observation,
    inMint: env.mints.dusd.address,
    outMint: env.mints.dout.address,
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    inAccount: env.tokenAccounts.ownerDusd,
    outAccount: env.tokenAccounts.ownerDout,
    floorOut: floor.floorOut,
    floorIn: floor.floorIn,
    maxDeadlineSlots: floor.maxDeadlineSlots,
  }
}

/** Decoded token account, or `null` when it does not exist. */
export async function fetchTokenAccount(
  chain: DemoChain,
  address: Address,
): Promise<TokenAccountView | null> {
  const raw = await fetchRawAccount(chain.rpc, address)
  return raw && raw.data.length >= 165 ? decodeTokenAccount(raw.data) : null
}

/** Token balance in raw base units (0n when the account does not exist). */
export async function tokenBalance(chain: DemoChain, address: Address): Promise<bigint> {
  return (await fetchTokenAccount(chain, address))?.amount ?? 0n
}

/**
 * Compare the state file with the chain. Returns human-readable problems (empty = the environment
 * is live and intact): a different genesis hash (the validator was reset), a missing program, mint,
 * token account or pool.
 */
export async function checkDemoEnv(env: DemoEnv, chain: DemoChain): Promise<string[]> {
  const problems: string[] = []
  const genesis = await chain.rpc.getGenesisHash().send()
  if (genesis !== env.genesisHash) {
    problems.push(
      'the validator has a different genesis hash than at bootstrap (it was reset): run bootstrap again',
    )
  }
  const must: Array<[string, Address]> = [
    ['agent_auth program', env.programIds.agentAuth],
    ['relay program', env.programIds.relay],
    ['mock_amm program', env.programIds.mockAmm],
    ['gated_example program', env.programIds.gatedExample],
    ['DUSD mint', env.mints.dusd.address],
    ['DOUT mint', env.mints.dout.address],
    ['pool state', env.pool.state],
    ['gated-example config', env.gated.config],
    ...Object.entries(env.tokenAccounts).map(([k, a]): [string, Address] => [
      `token account ${k}`,
      a,
    ]),
  ]
  const { value } = await chain.rpc
    .getMultipleAccounts(
      must.map(([, a]) => a),
      { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
    )
    .send()
  value.forEach((acct, i) => {
    if (acct === null) problems.push(`missing on chain: ${must[i]?.[0]}`)
  })
  return problems
}
