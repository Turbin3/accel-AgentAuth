'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { isoOfSeconds } from '@agentauth-sol/sdk'
import { relativeTime } from '@/lib/format'
import { relayPaused, statusOf, type MandateDetail } from '@/lib/mandate-data'
import { AddressText } from './address'
import { BudgetMeter } from './meter'
import { Card, Chip } from './ui'

export function useNowSeconds(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function StatusChip({ detail }: { detail: MandateDetail }) {
  const status = statusOf(detail)
  const tone = status === 'active' ? 'ok' : status === 'paused' ? 'warn' : 'bad'
  return <Chip tone={tone}>{status}</Chip>
}

export function MandateCard({
  detail,
  readOnly = false,
}: {
  detail: MandateDetail
  readOnly?: boolean
}) {
  const now = useNowSeconds(1000)
  const expiry = detail.mandate.expiry
  const limits = detail.view.explanation?.limits ?? []
  const first = limits[0]
  return (
    <Card
      as="article"
      data-testid="mandate-card"
      aria-label={`Mandate for agent ${detail.mandate.agent}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted">Agent</p>
          <AddressText value={detail.mandate.agent} />
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip detail={detail} />
          {relayPaused(detail) ? <Chip tone="warn">relay paused</Chip> : null}
          {detail.view.policy ? null : (
            <Chip tone="neutral" mark={false}>
              no relay policy
            </Chip>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm">{detail.view.explanation?.headline}</p>
      <div className="mt-4 space-y-4">
        {first ? (
          <BudgetMeter
            label={`${first.programName} budget`}
            used={first.spendTotal}
            limit={first.spendLimit}
            decimals={detail.decimalsFor(first.program)}
            {...(detail.unitFor(first.program)
              ? { unit: detail.unitFor(first.program) as string }
              : {})}
          />
        ) : (
          <p className="text-sm text-muted">No permissions are set on this mandate.</p>
        )}
        {limits.length > 1 ? (
          <p className="text-xs text-muted">
            + {limits.length - 1} more permission{limits.length > 2 ? 's' : ''}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
        <p title={isoOfSeconds(expiry)}>
          Expires <span className="font-medium">{relativeTime(expiry, now)}</span>
        </p>
        {readOnly ? null : (
          <Link href={`/mandates/${detail.address}`} className="font-medium underline">
            Open mandate
          </Link>
        )}
      </div>
    </Card>
  )
}
