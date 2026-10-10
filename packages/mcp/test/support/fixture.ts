import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connect,
  demoClient,
  tokenBalance,
  demoSwapConfig,
  loadDemoEnv,
  loadDemoSigners,
  mintToCheckedIx,
  type DemoChain,
  type DemoEnv,
  type DemoSigners,
} from '@agentauth-sol/demo'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
} from '@solana/kit'
import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  associatedTokenAddress,
  createAtaIdempotentIx,
  expiresIn,
  mandatePda,
  parseUnits,
  revokeMandateIx,
  type Client,
} from '@agentauth-sol/sdk'
import { randomBytes } from 'node:crypto'
import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Signature,
} from '@solana/kit'
import type { Config } from '../../src/config'
import { silentLogger } from '../../src/log'
import { createServer, type ServerHandle } from '../../src/server'

export const E2E_ENABLED = Boolean(process.env['AA_RPC_URL'] && process.env['AA_MCP_DEMO_DIR'])

/** True when the localnet suite should run; throws when AA_MCP_E2E=1 demands it and it cannot. */
export function requireE2e(): boolean {
  if (E2E_ENABLED) return true
  if (process.env['AA_MCP_E2E'] === '1')
    throw new Error('AA_MCP_E2E=1 but AA_RPC_URL / bootstrap is missing')
  return false
}

export function baseConfig(over: Partial<Config> = {}): Config {
  return {
    profile: 'agent',
    cluster: 'localnet',
    rpcUrl: process.env['AA_RPC_URL'],
    owner: undefined,
    agent: undefined,
    agentKeypairPath: undefined,
    ownerKeypairPath: undefined,
    unsafeDevSign: false,
    landDenied: false,
    stateFile: undefined,
    labelsFile: undefined,
    maxAmount: undefined,
    maxPaysPerMinute: 100,
    maxCallsPerMinute: 1000,
    duplicateWindowSeconds: 60,
    timeoutMs: 20_000,
    logLevel: 'silent',
    ...over,
  }
}

export async function signerFromSeed(seed: Uint8Array): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(seed)
}

/** A random keypair plus the Solana CLI file for it (mode 600). */
export async function randomSigner(
  dir: string,
  name: string,
): Promise<{ signer: KeyPairSigner; file: string }> {
  const seed = new Uint8Array(randomBytes(32))
  const signer = await signerFromSeed(seed)
  const pub = getAddressEncoder().encode(signer.address)
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify([...seed, ...pub]), { mode: 0o600 })
  chmodSync(file, 0o600)
  return { signer, file }
}

export interface Fixture {
  readonly env: DemoEnv
  readonly demo: DemoSigners
  readonly chain: DemoChain
  readonly client: Client
  readonly dir: string
  readonly owner: KeyPairSigner
  readonly agent: KeyPairSigner
  readonly agentFile: string
  readonly mandate: Address
  readonly ownerDusd: Address
  readonly ownerDout: Address
  /** Allowlisted recipient token account. */
  readonly allowed: Address
  readonly attacker: Address
  cleanup(): void
}

export interface FixtureOptions {
  readonly perCall?: string
  readonly lifetime?: string
  readonly swap?: boolean
  readonly balance?: string
  /** SPL allowance; defaults to the lifetime limit. A larger value makes AgentAuth the binding cap. */
  readonly delegateCap?: string
  /** false: only the accounts exist, the owner has not created a mandate yet. */
  readonly onboard?: boolean
}

/**
 * A fresh owner + agent + funded mandate with a relay policy. One owner per fixture: an SPL token
 * account has a single delegate, so two mandates must not share a source account.
 */
export async function createFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  process.env['AA_DEMO_DIR'] = process.env['AA_MCP_DEMO_DIR']
  const env = await loadDemoEnv()
  const demo = await loadDemoSigners(env)
  const chain = connect({ rpcUrl: env.rpcUrl, wsUrl: env.wsUrl })
  const client = demoClient(env)
  const dir = mkdtempSync(join(tmpdir(), 'aa-mcp-fx-'))
  const ownerKey = await randomSigner(dir, 'owner')
  const agentKey = await randomSigner(dir, 'agent')
  const owner = ownerKey.signer
  const agent = agentKey.signer
  await chain.airdrop(owner.address, 2_000_000_000n)

  const dusd = env.mints.dusd.address
  const dout = env.mints.dout.address
  const ownerDusd = (await associatedTokenAddress(owner.address, dusd)).address
  const ownerDout = (await associatedTokenAddress(owner.address, dout)).address
  await chain.send(
    [
      await createAtaIdempotentIx({ payer: demo.harness, owner: owner.address, mint: dusd }),
      await createAtaIdempotentIx({ payer: demo.harness, owner: owner.address, mint: dout }),
      mintToCheckedIx({
        mint: dusd,
        destination: ownerDusd,
        authority: demo.harness,
        amount: parseUnits(opts.balance ?? '100', 6),
        decimals: 6,
      }),
    ],
    demo.harness,
  )
  const lifetime = parseUnits(opts.lifetime ?? '5', 6)
  const perCall = parseUnits(opts.perCall ?? '2', 6)
  const withSwap = opts.swap !== false
  const plan = await client.plan.onboarding({
    owner,
    agent: agent.address,
    expiry: expiresIn('1h'),
    fundAgentLamports: 50_000_000n,
    token: {
      mint: dusd,
      source: ownerDusd,
      delegateCap: parseUnits(opts.delegateCap ?? opts.lifetime ?? '5', 6),
    },
    ...(opts.delegateCap ? { allowOverride: true } : {}),
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: lifetime,
        perTxLimit: perCall,
        discriminators: [TRANSFER_CHECKED_DISC],
      },
      ...(withSwap
        ? [
            {
              program: env.programIds.mockAmm,
              spendLimit: lifetime,
              perTxLimit: perCall,
              discriminators: [SWAP_BASE_INPUT_DISC],
            },
          ]
        : []),
    ],
    recipients: [env.tokenAccounts.recipientDusd],
    ...(withSwap
      ? { swap: { ...demoSwapConfig(env), inAccount: ownerDusd, outAccount: ownerDout } }
      : {}),
  })
  if (opts.onboard !== false)
    for (const step of plan.steps) await chain.send(step.instructions, owner)
  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address
  return {
    env,
    demo,
    chain,
    client,
    dir,
    owner,
    agent,
    agentFile: agentKey.file,
    mandate,
    ownerDusd,
    ownerDout,
    allowed: env.tokenAccounts.recipientDusd,
    attacker: env.tokenAccounts.attackerDusd,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Connect an in-memory MCP client to a server handle. */
export async function connectClient(handle: ServerHandle): Promise<McpClient> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new McpClient({ name: 'test-client', version: '0.0.0' })
  await Promise.all([handle.server.connect(b), client.connect(a)])
  return client
}

/** An agent-profile server for a fixture, connected to an in-memory client. */
export async function agentSession(fx: Fixture, over: Partial<Config> = {}) {
  const handle = createServer({
    config: baseConfig({
      profile: 'agent',
      owner: fx.owner.address,
      agentKeypairPath: fx.agentFile,
      ...over,
    }),
    log: silentLogger,
    agentSigner: fx.agent,
    client: fx.client,
  })
  await handle.refreshSwap()
  const client = await connectClient(handle)
  return { handle, client, close: () => client.close() }
}

/** Call a tool and parse the JSON text result. */
export async function call(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: Record<string, unknown>; raw: string }> {
  let res
  try {
    res = await client.callTool({ name, arguments: args })
  } catch (e) {
    // The MCP SDK rejects invalid arguments (and unknown or disabled tools) with a protocol error.
    return { isError: true, body: {}, raw: e instanceof Error ? e.message : String(e) }
  }
  const content = res.content as Array<{ type: string; text?: string }>
  const raw = content[0]?.text ?? ''
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = { unparsed: raw }
  }
  return { isError: res.isError === true, body, raw }
}

/** Owner pauses or resumes the relay (scope relay: relay error 116 while paused). */
export async function ownerPause(fx: Fixture, paused: boolean): Promise<void> {
  const input = { owner: fx.owner, agent: fx.agent.address, scope: 'relay' as const }
  const plan = paused ? await fx.client.plan.pause(input) : await fx.client.plan.resume(input)
  for (const step of plan.steps) await fx.chain.send(step.instructions, fx.owner)
}

/** Owner revokes only the mandate (the policy stays: the relay then answers 117). */
export async function ownerRevokeMandate(fx: Fixture): Promise<void> {
  const ix = await revokeMandateIx({
    owner: fx.owner,
    agent: fx.agent.address,
    agentAuthProgram: fx.env.programIds.agentAuth,
  })
  await fx.chain.send([ix], fx.owner)
}

export function balanceOf(fx: Fixture, account: Address): Promise<bigint> {
  return tokenBalance(fx.chain, account)
}

/**
 * What a wallet does with an unsigned plan transaction: decode the base64, sign it with the owner
 * key (here a throwaway local key), send it and wait for confirmation.
 */
export async function walletSignAndSend(fx: Fixture, base64: string): Promise<Signature> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
  const [signed] = await fx.owner.signTransactions([
    tx as Parameters<Fixture['owner']['signTransactions']>[0][number],
  ])
  if (!signed) throw new Error('wallet did not sign')
  const merged = { ...tx, signatures: { ...tx.signatures, ...signed } }
  const wire = getBase64EncodedWireTransaction(
    merged as Parameters<typeof getBase64EncodedWireTransaction>[0],
  )
  const signature = await fx.client.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send()
  for (let i = 0; i < 60; i++) {
    const { value } = await fx.client.rpc.getSignatureStatuses([signature]).send()
    const st = value[0]
    if (st?.err)
      throw new Error(
        `wallet transaction failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
      )
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'))
      return signature
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('wallet transaction was not confirmed')
}

/** An owner-profile server (no keys) for a fixture. */
export async function ownerSession(fx: Fixture, over: Partial<Config> = {}) {
  const handle = createServer({
    config: baseConfig({
      profile: 'owner',
      owner: fx.owner.address,
      agent: fx.agent.address,
      ...over,
    }),
    log: silentLogger,
    client: fx.client,
  })
  const client = await connectClient(handle)
  return { handle, client, close: () => client.close() }
}

/** The transactions of a plan result, in order. */
export function planTransactions(
  body: Record<string, unknown>,
): Array<{ base64: string; required_signers: string[]; depends_on: number[]; step: number }> {
  return body['transactions'] as Array<{
    base64: string
    required_signers: string[]
    depends_on: number[]
    step: number
  }>
}
