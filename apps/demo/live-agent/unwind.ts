/**
 * pnpm --filter @agentauth-sol/demo live-unwind
 *
 * The owner closes the live agent's mandate and relay policy and revokes the SPL delegation in one
 * transaction (the same unwind the scenarios use).
 */
import { mandatePda } from '@agentauth-sol/sdk'
import { bootOrExit } from '../src/scenarios/lib/ctx'

const ctx = await bootOrExit('live-unwind', process.argv.slice(2))
const { env, client, signers } = ctx
try {
  const mandate = (
    await mandatePda(signers.owner.address, signers.agent.address, env.programIds.agentAuth)
  ).address
  if (
    (await client.fetchMandate(mandate)) === null &&
    (await client.fetchPolicy(mandate)) === null
  ) {
    console.log('nothing to unwind: no mandate or policy for the live agent')
  } else {
    const plan = await client.plan.unwind({ owner: signers.owner, agent: signers.agent.address })
    for (const step of plan.steps) {
      const res = await client.sendAndConfirm(step, { signers: [signers.owner] })
      if (!res.ok) throw new Error(res.error?.describe() ?? 'unwind failed')
      console.log(`unwound in one transaction: ${res.signature}`)
    }
  }
} catch (error) {
  console.error(`live-unwind failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
process.exit(0)
