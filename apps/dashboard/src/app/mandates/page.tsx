'use client'

import Link from 'next/link'
import { AsyncBoundary } from '@/components/async-boundary'
import { DemoMandate } from '@/components/demo-mandate'
import { MandateCard } from '@/components/mandate-card'
import { RequireWallet } from '@/components/require-wallet'
import { EmptyState, PageTitle, Skeleton } from '@/components/ui'
import { useClient } from '@/lib/chain'
import { loadOwnerMandates } from '@/lib/mandate-data'
import { useAsync } from '@/lib/use-async'
import type { Address } from '@solana/kit'

function OwnerMandates({ owner }: { owner: Address }) {
  const client = useClient()
  const state = useAsync(() => loadOwnerMandates(client, owner), [owner], { intervalMs: 10000 })
  return (
    <AsyncBoundary
      state={state}
      what="your mandates"
      skeleton={
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      }
    >
      {(details) =>
        details.length === 0 ? (
          <EmptyState
            title="You have no mandates on this cluster yet"
            action={
              <Link
                href="/mandates/new"
                className="inline-flex min-h-10 items-center rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-ink no-underline"
              >
                Create your first mandate
              </Link>
            }
          >
            <p>
              A mandate names one agent key and the exact things it may do. Creating one takes two
              transactions that you sign. Nothing is spent until the agent acts, and you can end it
              at any time.
            </p>
          </EmptyState>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2" aria-label="Your mandates">
            {details.map((d) => (
              <li key={d.address}>
                <MandateCard detail={d} />
              </li>
            ))}
          </ul>
        )
      }
    </AsyncBoundary>
  )
}

export default function MandatesPage() {
  return (
    <main className="space-y-10">
      <PageTitle
        title="Your mandates"
        lead="Every mandate you own on this cluster, read from the chain."
        actions={
          <Link
            href="/mandates/new"
            className="inline-flex min-h-10 items-center rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-ink no-underline"
          >
            New mandate
          </Link>
        }
      />
      <RequireWallet why="Mandates are listed by owner, so the dashboard needs to know which wallet is yours. It only reads until you sign something.">
        {(wallet) => <OwnerMandates owner={wallet.address} />}
      </RequireWallet>
      <DemoMandate />
    </main>
  )
}
