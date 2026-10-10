/**
 * Example 1: a plain @solana/kit agent whose signer is wrapped by the guard.
 *
 *   AA_LOCALNET_INSTANCE=<n> scripts/localnet.sh start && eval "$(... env)" && pnpm --filter @agentauth-sol/demo bootstrap
 *   pnpm --filter @agentauth-sol/guard exec tsx examples/01-kit-agent.ts
 *
 * COOPERATIVE CLIENT-SIDE GUARD: it only protects transactions signed through the wrapper. The
 * relay is the enforcement tier.
 */
import { GuardRefusedError, guardSigner } from '../src'
import { systemTransferIx, setComputeUnitLimitIx, approveIx } from '@agentauth-sol/sdk'
import { rootCause, setupMandate, SOL } from './_setup'

const { chain, programIds, agent, recipient, mandate, owner } = await setupMandate()

// One line to adopt: wrap the signer you already have.
const signer = guardSigner(agent, {
  rpc: chain.rpc,
  mandate,
  cluster: 'localnet',
  programIds,
})

async function attempt(label: string, ixs: Parameters<typeof chain.send>[0]) {
  try {
    const sig = await chain.send(ixs, signer)
    console.log(`  sent    ${label}: ${sig.slice(0, 16)}...`)
  } catch (error) {
    const cause = rootCause(error)
    if (cause instanceof GuardRefusedError) {
      console.log(`  REFUSED ${label}: ${cause.program}/${cause.name}`)
      console.log(
        cause
          .explain()
          .split('\n')
          .map((l) => `          ${l}`)
          .join('\n'),
      )
    } else {
      console.log(`  FAILED  ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

console.log('Guard (cooperative, client-side) in front of the agent key:')
await attempt('0.2 SOL transfer (inside the mandate)', [
  setComputeUnitLimitIx(200_000),
  systemTransferIx({ from: signer, to: recipient.address, lamports: SOL / 5n }),
])
await attempt('0.6 SOL transfer (over the 0.5 SOL per-call cap)', [
  systemTransferIx({ from: signer, to: recipient.address, lamports: (SOL * 6n) / 10n }),
])
await attempt('token Approve to a stranger (authority change)', [
  await approveIx({
    source: recipient.address,
    owner: signer,
    delegate: owner.address,
    amount: 1n,
  }),
])

const { mandate: live } = await signer.guard.loadMandate()
console.log(
  `mandate on chain: System spend_total ${live?.permissions[0]?.spendTotal} lamports, call_count ${live?.permissions[0]?.callCount}`,
)
console.log(
  'Reminder: anyone holding the raw agent key can skip this guard. Hard enforcement is the relay.',
)
