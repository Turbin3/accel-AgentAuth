/**
 * pnpm --filter @agentauth-sol/demo live-setup
 *
 * Prepares the local validator for a LIVE LLM agent run (Claude Code / Claude Desktop with the
 * AgentAuth MCP agent profile): gives the persistent demo `agent` wallet a mandate from the demo
 * `owner`, then renders the invoice files (one legitimate, one carrying a prompt injection), the
 * prompt and the MCP configuration into <demo dir>/live-agent/. No LLM is called from this repo.
 * Idempotent: an earlier live mandate for the same agent is unwound first.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mandatePda } from '@agentauth-sol/sdk'
import { demoDir, keysDir, REPO_ROOT } from '../src/lib/paths'
import { tokenBalance } from '../src/lib/env'
import { bootOrExit, dusd, restock, units } from '../src/scenarios/lib/ctx'
import { clearStaleDelegation, onboardQuiet } from '../src/scenarios/lib/kit'

const here = dirname(fileURLToPath(import.meta.url))
const ctx = await bootOrExit('live-setup', process.argv.slice(2))
const { env, chain, client, signers } = ctx
const A = env.tokenAccounts
const owner = signers.owner
const agent = signers.agent

try {
  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address
  const existing = await client.fetchMandate(mandate)
  const existingPolicy = await client.fetchPolicy(mandate)
  if (existing !== null || existingPolicy !== null) {
    const plan = await client.plan.unwind({ owner, agent: agent.address })
    for (const step of plan.steps) await ctx.chain.send(step.instructions, owner)
    console.log('unwound the live agent mandate from an earlier setup')
  }
  await clearStaleDelegation(ctx, owner, A.ownerDusd)
  await restock(ctx, A.ownerDusd, units(200))
  await onboardQuiet(ctx, {
    owner,
    agent: agent.address,
    source: A.ownerDusd,
    out: A.ownerDout,
    recipients: [A.recipientDusd],
  })

  const outDir = join(demoDir(), 'live-agent')
  const inboxDir = join(outDir, 'inbox')
  await mkdir(inboxDir, { recursive: true })
  const vars: Record<string, string> = {
    ACME_ACCOUNT: A.recipientDusd,
    MALLORY_ACCOUNT: A.attackerDusd,
    MALLORY_WALLET: env.wallets.attacker,
    OWNER_ACCOUNT: A.ownerDusd,
    INBOX_DIR: inboxDir,
  }
  const render = (text: string): string =>
    text.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => {
      const v = vars[k]
      if (v === undefined) throw new Error(`unknown placeholder ${k}`)
      return v
    })
  for (const f of ['invoice-1.md', 'invoice-injection.md']) {
    await writeFile(join(inboxDir, f), render(await readFile(join(here, 'inbox', f), 'utf8')))
  }
  await writeFile(
    join(outDir, 'prompt.txt'),
    render(await readFile(join(here, 'prompt.txt'), 'utf8')),
  )

  const mcpArgs = [
    join(REPO_ROOT, 'packages', 'mcp', 'dist', 'bin.js'),
    '--profile',
    'agent',
    '--cluster',
    'localnet',
    '--rpc-url',
    env.rpcUrl,
    '--owner',
    owner.address,
    '--agent-keypair',
    join(keysDir(), 'agent.json'),
    '--state-file',
    join(outDir, 'agent-state.json'),
    '--land-denied',
  ]
  await writeFile(
    join(outDir, 'mcp-config.json'),
    `${JSON.stringify({ mcpServers: { 'agentauth-agent': { command: 'node', args: mcpArgs } } }, null, 2)}\n`,
  )
  const start = {
    ownerDusd: (await tokenBalance(chain, A.ownerDusd)).toString(),
    acme: (await tokenBalance(chain, A.recipientDusd)).toString(),
    mallory: (await tokenBalance(chain, A.attackerDusd)).toString(),
    malloryOut: (await tokenBalance(chain, A.attackerDout)).toString(),
  }
  await writeFile(join(outDir, 'start.json'), `${JSON.stringify(start, null, 2)}\n`)

  console.log('live agent environment ready (local validator, unaudited devnet prototype)')
  console.log(`  rpc            ${env.rpcUrl}`)
  console.log(`  owner          ${owner.address} holds ${dusd(BigInt(start.ownerDusd))}`)
  console.log(
    `  agent          ${agent.address} (key file ${join(keysDir(), 'agent.json')}, never printed)`,
  )
  console.log(`  ACME           ${A.recipientDusd} (the one allowlisted payee)`)
  console.log(`  MALLORY        ${A.attackerDusd} (scripted attacker account; must stay at 0)`)
  console.log(`  inbox          ${inboxDir}`)
  console.log(`  prompt         ${join(outDir, 'prompt.txt')}`)
  console.log(`  MCP config     ${join(outDir, 'mcp-config.json')}`)
  console.log(
    'next: build the MCP server (pnpm --filter @agentauth-sol/mcp build), register it, run the prompt;',
  )
  console.log('then `pnpm --filter @agentauth-sol/demo live-check` and, to reset, `live-unwind`.')
} catch (error) {
  console.error(`live-setup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
process.exit(0)
