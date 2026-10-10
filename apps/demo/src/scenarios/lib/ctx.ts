/**
 * Shared context of the scenarios: environment, chain, SDK client, signers and the runner, plus the
 * fixtures they have in common (restocking the demo wallets, throwaway victims, the onboarding plan).
 */
import {
  associatedTokenAddress,
  createAtaIdempotentIx,
  formatUnits,
  GATED_ACTION_DISC,
  parseUnits,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  type Client,
  type Plan,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit'
import { connect, type DemoChain } from '../../lib/chain'
import {
  checkDemoEnv,
  demoClient,
  demoSwapConfig,
  loadDemoEnv,
  loadDemoSigners,
  tokenBalance,
  type DemoEnv,
} from '../../lib/env'
import type { DemoSigners } from '../../lib/keys'
import { mintToCheckedIx } from '../../lib/instructions'
import { Run, parseRunOptions } from './run'

export const DECIMALS = 6
/** Whole DUSD (or DOUT) to raw base units. */
export const units = (whole: number | string): bigint => parseUnits(String(whole), DECIMALS)
/** Raw base units to a short human string, no symbol. */
export const fmt = (raw: bigint): string =>
  raw < 0n ? `-${formatUnits(-raw, DECIMALS)}` : formatUnits(raw, DECIMALS)
export const dusd = (raw: bigint): string => `${fmt(raw)} DUSD`
export const dout = (raw: bigint): string => `${fmt(raw)} DOUT`

export interface Ctx {
  readonly env: DemoEnv
  readonly chain: DemoChain
  readonly client: Client
  readonly signers: DemoSigners
  readonly run: Run
}

/** Parse the CLI flags, load and verify the bootstrapped environment, connect. */
export async function bootCtx(name: string, argv: readonly string[]): Promise<Ctx> {
  const opts = parseRunOptions(name, argv)
  const env = await loadDemoEnv()
  const chain = connect({ rpcUrl: env.rpcUrl, wsUrl: env.wsUrl })
  const problems = await checkDemoEnv(env, chain)
  if (problems.length > 0) {
    throw new Error(
      `the demo environment is not ready: ${problems.join('; ')}. Run scripts/localnet.sh start and \`pnpm --filter @agentauth-sol/demo bootstrap\`.`,
    )
  }
  const signers = await loadDemoSigners(env)
  const client = demoClient(env)
  return { env, chain, client, signers, run: new Run(opts, client, env.rpcUrl) }
}

/** {@link bootCtx}, but a failure prints one readable line and exits 1 (no stack trace). */
export async function bootOrExit(name: string, argv: readonly string[]): Promise<Ctx> {
  try {
    return await bootCtx(name, argv)
  } catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

/** Mint DUSD from the harness (the mint authority of the demo mint) until `account` holds `atLeast`. */
export async function restock(ctx: Ctx, account: Address, atLeast: bigint): Promise<bigint> {
  const have = await tokenBalance(ctx.chain, account)
  if (have >= atLeast) return 0n
  const amount = atLeast - have
  await ctx.chain.send(
    [
      mintToCheckedIx({
        mint: ctx.env.mints.dusd.address,
        destination: account,
        authority: ctx.signers.harness,
        amount,
        decimals: DECIMALS,
      }),
    ],
    ctx.signers.harness,
  )
  return amount
}

/** A throwaway owner with its own DUSD and DOUT token accounts (so a run never drifts the demo wallets). */
export interface Victim {
  readonly owner: KeyPairSigner
  readonly dusd: Address
  readonly dout: Address
}

export async function makeVictim(ctx: Ctx, dusdAmount: bigint): Promise<Victim> {
  const owner = await generateKeyPairSigner()
  await ctx.chain.airdrop(owner.address, 2_000_000_000n)
  const mintDusd = ctx.env.mints.dusd.address
  const mintDout = ctx.env.mints.dout.address
  const dusdAta = (await associatedTokenAddress(owner.address, mintDusd)).address
  const doutAta = (await associatedTokenAddress(owner.address, mintDout)).address
  await ctx.chain.send(
    [
      await createAtaIdempotentIx({
        payer: ctx.signers.harness,
        owner: owner.address,
        mint: mintDusd,
      }),
      await createAtaIdempotentIx({
        payer: ctx.signers.harness,
        owner: owner.address,
        mint: mintDout,
      }),
      mintToCheckedIx({
        mint: mintDusd,
        destination: dusdAta,
        authority: ctx.signers.harness,
        amount: dusdAmount,
        decimals: DECIMALS,
      }),
    ],
    ctx.signers.harness,
  )
  return { owner, dusd: dusdAta, dout: doutAta }
}

export interface OnboardParams {
  readonly owner: KeyPairSigner
  readonly agent: Address
  readonly source: Address
  readonly out: Address
  readonly recipients: readonly Address[]
  /** Lifetime / per-call caps of the Token slot (default 20 / 5 DUSD, the demo script). */
  readonly tokenSpend?: bigint
  readonly tokenPerTx?: bigint
  /** SPL delegation cap (default 50 DUSD: deliberately above the mandate's lifetime limit). */
  readonly delegateCap?: bigint
  /** Add the mock-AMM swap permission and pinned pool (default true). */
  readonly swap?: boolean
  /** Add the gated-example permission (only the demo owner is honoured by gated-example). */
  readonly gated?: boolean
  readonly ammSpend?: bigint
  readonly ammPerTx?: bigint
  readonly fundAgentLamports?: bigint
}

/** The two-transaction onboarding plan of DEMO-SCRIPT S1/S2 with chain time as the clock. */
export async function planOnboarding(ctx: Ctx, p: OnboardParams): Promise<Plan> {
  const now = await ctx.client.getClusterTime()
  const withSwap = p.swap !== false
  const permissions = [
    {
      program: TOKEN_PROGRAM_ID,
      spendLimit: p.tokenSpend ?? units(20),
      perTxLimit: p.tokenPerTx ?? units(5),
      discriminators: [TRANSFER_CHECKED_DISC],
    },
    ...(withSwap
      ? [
          {
            program: ctx.env.programIds.mockAmm,
            spendLimit: p.ammSpend ?? units(10),
            perTxLimit: p.ammPerTx ?? units(5),
            discriminators: [SWAP_BASE_INPUT_DISC],
          },
        ]
      : []),
    ...(p.gated === true
      ? [
          {
            program: ctx.env.programIds.gatedExample,
            spendLimit: 100n,
            perTxLimit: 10n,
            discriminators: [GATED_ACTION_DISC],
          },
        ]
      : []),
  ]
  return ctx.client.plan.onboarding({
    owner: p.owner,
    agent: p.agent,
    expiry: now + 24n * 3600n,
    now,
    fundAgentLamports: p.fundAgentLamports ?? 50_000_000n,
    // The demo delegates more than the mandate's lifetime limit on purpose, so that AgentAuth is the
    // binding cap and the SPL delegation is the independent backstop (DEMO-SCRIPT section 0).
    allowOverride: p.delegateCap === undefined || p.delegateCap > (p.tokenSpend ?? units(20)),
    token: {
      mint: ctx.env.mints.dusd.address,
      source: p.source,
      delegateCap: p.delegateCap ?? units(50),
    },
    permissions,
    recipients: p.recipients,
    ...(withSwap
      ? { swap: { ...demoSwapConfig(ctx.env), inAccount: p.source, outAccount: p.out } }
      : {}),
  })
}

/** Raw balances of several token accounts. */
export async function balancesOf(
  ctx: Ctx,
  accounts: Readonly<Record<string, Address>>,
): Promise<Record<string, bigint>> {
  const entries = await Promise.all(
    Object.entries(accounts).map(async ([k, a]) => [k, await tokenBalance(ctx.chain, a)] as const),
  )
  return Object.fromEntries(entries)
}

/**
 * "Funds lost": how much the attacker accounts hold now compared with when this was called
 * (DUSD and DOUT summed in whole tokens; both mints have 6 decimals).
 */
export async function fundsLostTracker(
  ctx: Ctx,
  attackerAccounts: readonly Address[],
  label = 'DUSD/DOUT',
): Promise<() => Promise<string>> {
  const total = async (): Promise<bigint> => {
    const all = await Promise.all(attackerAccounts.map((a) => tokenBalance(ctx.chain, a)))
    return all.reduce((s, v) => s + v, 0n)
  }
  const baseline = await total()
  return async () => `${fmt((await total()) - baseline)} ${label}`
}
