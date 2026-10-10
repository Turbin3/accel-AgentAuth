/**
 * The 60-second tour, step 2: give the demo agent a small mandate on the LOCAL validator, so the
 * `agent` profile of the MCP server has something to talk to. Localnet only, demo keys only.
 *
 *   pnpm --filter @agentauth-sol/demo bootstrap
 *   pnpm --filter @agentauth-sol/mcp tour
 *
 * It signs with the demo owner key from .demo/keys (never printed). A real owner signs plans in
 * their own wallet; this script exists only so that the tour needs no wallet.
 */
import {
  connect,
  demoClient,
  demoSwapConfig,
  keysDir,
  loadDemoEnv,
  loadDemoSigners,
} from '@agentauth-sol/demo'
import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  expiresIn,
  mandatePda,
  parseUnits,
} from '@agentauth-sol/sdk'
import { join } from 'node:path'

const env = await loadDemoEnv()
if (!/^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(env.rpcUrl)) {
  throw new Error('the tour only runs against a local validator')
}
const signers = await loadDemoSigners(env)
const client = demoClient(env)
const chain = connect({ rpcUrl: env.rpcUrl, wsUrl: env.wsUrl })
const { owner, agent } = signers
const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address

if ((await client.fetchMandate(mandate)) === null) {
  const plan = await client.plan.onboarding({
    owner,
    agent: agent.address,
    expiry: expiresIn('24h'),
    token: {
      mint: env.mints.dusd.address,
      source: env.tokenAccounts.ownerDusd,
      delegateCap: parseUnits('50', 6), // larger than the mandate budget, so AgentAuth is the binding cap
    },
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: parseUnits('10', 6),
        perTxLimit: parseUnits('5', 6),
        discriminators: [TRANSFER_CHECKED_DISC],
      },
      {
        program: env.programIds.mockAmm,
        spendLimit: parseUnits('10', 6),
        perTxLimit: parseUnits('5', 6),
        discriminators: [SWAP_BASE_INPUT_DISC],
      },
    ],
    recipients: [env.tokenAccounts.recipientDusd],
    swap: demoSwapConfig(env),
  })
  for (const step of plan.steps) await chain.send(step.instructions, owner)
  process.stdout.write(
    'Mandate created: 5 DUSD per payment, 10 DUSD in total, one allowed recipient (Alice), swap on the mock pool. SPL allowance for the relay: 50 DUSD.\n',
  )
} else {
  process.stdout.write('The demo agent already has a mandate on this ledger; nothing to do.\n')
}

const config = {
  mcpServers: {
    agentauth: {
      command: 'node',
      args: [
        join(import.meta.dirname, '..', 'dist', 'bin.js'),
        '--profile',
        'agent',
        '--cluster',
        'localnet',
        '--rpc-url',
        env.rpcUrl,
        '--owner',
        owner.address,
      ],
      env: { AGENTAUTH_AGENT_KEYPAIR: join(keysDir(), 'agent.json') },
    },
  },
}
process.stdout.write(
  `\nAdd this to .mcp.json (Claude Code) or claude_desktop_config.json:\n\n${JSON.stringify(config, null, 2)}\n`,
)
process.stdout.write(
  '\nThen try, in this order:\n  1. "What is my AgentAuth status?"\n  2. "Pay recipient-1 2.5."\n  3. "Pay 40 to ' +
    env.tokenAccounts.attackerDusd +
    '." (the scripted attacker account: expect relay 104, and a plain-language stop)\n',
)
