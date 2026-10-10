'use client'

import { useClient } from '@/lib/chain'
import { useConfig } from '@/lib/config-context'
import { useAsync } from '@/lib/use-async'
import { AddressText } from './address'
import { Chip, Skeleton } from './ui'

interface Row {
  readonly name: string
  readonly id: string
  readonly note: string
}

/** Is each program actually deployed (executable) on the configured cluster? A live read, no assumptions. */
export function ProgramStatus() {
  const client = useClient()
  const config = useConfig()
  const rows: Row[] = [
    { name: 'AgentAuth core', id: client.programIds.agentAuth, note: 'mandates and verify' },
    { name: 'Relay', id: client.programIds.relay, note: 'hard enforcement point' },
    ...(config.cluster === 'localnet'
      ? [
          { name: 'Mock AMM', id: client.programIds.mockAmm, note: 'test pool (localnet only)' },
          { name: 'Gated example', id: client.programIds.gatedExample, note: 'second integrator' },
        ]
      : []),
  ]
  const status = useAsync(
    async (signal) => {
      const res = await client.rpc
        .getMultipleAccounts(
          rows.map((r) => r.id as never),
          { encoding: 'base64', dataSlice: { offset: 0, length: 0 } } as never,
        )
        .send({ abortSignal: signal })
      return res.value.map((a) =>
        a === null
          ? 'missing'
          : (a as { executable: boolean }).executable
            ? 'live'
            : 'not-executable',
      )
    },
    [config.cluster, config.rpcUrl],
    { intervalMs: 15000 },
  )
  return (
    <ul className="divide-y divide-line" aria-label="Live program status">
      {rows.map((r, i) => {
        const s = status.data?.[i]
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 py-3"
            data-testid="program-row"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.name}</p>
              <p className="text-xs text-muted">{r.note}</p>
              <AddressText value={r.id} link />
            </div>
            {status.loading ? (
              <Skeleton className="h-6 w-24" />
            ) : status.error ? (
              <Chip tone="warn">unreachable</Chip>
            ) : s === 'live' ? (
              <Chip tone="ok">deployed</Chip>
            ) : s === 'missing' ? (
              <Chip tone="bad">not found</Chip>
            ) : (
              <Chip tone="bad">not executable</Chip>
            )}
          </li>
        )
      })}
    </ul>
  )
}
