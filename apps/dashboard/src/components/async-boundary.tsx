'use client'

import type { ReactNode } from 'react'
import { useConfig } from '@/lib/config-context'
import { toDisplayError } from '@/lib/tx-runner'
import type { AsyncState } from '@/lib/use-async'
import { Button, ErrorBox, Skeleton } from './ui'

/** Loading skeleton, decoded error with retry, or the content. Keeps every chain read honest. */
export function AsyncBoundary<T>({
  state,
  skeleton,
  children,
  what,
}: {
  state: AsyncState<T>
  skeleton?: ReactNode
  children: (data: T) => ReactNode
  what: string
}) {
  const { rpcUrl } = useConfig()
  if (state.loading) {
    return (
      <div aria-busy="true" aria-label={`Loading ${what}`}>
        {skeleton ?? <Skeleton className="h-32 w-full" />}
      </div>
    )
  }
  if (state.error !== undefined && state.data === undefined) {
    return (
      <div className="space-y-3">
        <ErrorBox error={toDisplayError(state.error, rpcUrl)} title={`Could not load ${what}`} />
        <Button onClick={state.refresh}>Retry</Button>
      </div>
    )
  }
  if (state.data === undefined) return null
  return <>{children(state.data)}</>
}
