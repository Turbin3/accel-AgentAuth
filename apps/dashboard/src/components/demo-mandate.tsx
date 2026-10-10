'use client'

import { useClient } from '@/lib/chain'
import { useConfig } from '@/lib/config-context'
import { loadMandateDetail } from '@/lib/mandate-data'
import { useAsync } from '@/lib/use-async'
import { AsyncBoundary } from './async-boundary'
import { MandateCard } from './mandate-card'
import { EmptyState, Skeleton } from './ui'

/** Real, read-only data for a configured demo mandate. Never invented: no address, no panel. */
export function DemoMandate() {
  const config = useConfig()
  const client = useClient()
  const address = config.demoMandate
  const state = useAsync(
    async () => (address ? loadMandateDetail(client, address) : null),
    [address, config.rpcUrl],
    { enabled: address !== null, intervalMs: 10000 },
  )
  if (!address) return null
  return (
    <section aria-labelledby="demo-mandate" className="space-y-3">
      <h2 id="demo-mandate" className="text-xl font-semibold">
        Demo mandate (read-only)
      </h2>
      <p className="text-sm text-muted">
        Live chain data for a mandate the deployer chose to show. Connect a wallet to see your own.
      </p>
      <AsyncBoundary
        state={state}
        what="the demo mandate"
        skeleton={<Skeleton className="h-56 w-full" />}
      >
        {(detail) =>
          detail ? (
            <MandateCard detail={detail} />
          ) : (
            <EmptyState title="The configured demo mandate does not exist on this cluster">
              <p>
                NEXT_PUBLIC_AA_DEMO_MANDATE points at an address with no AgentAuth mandate. It may
                have been revoked.
              </p>
            </EmptyState>
          )
        }
      </AsyncBoundary>
    </section>
  )
}
