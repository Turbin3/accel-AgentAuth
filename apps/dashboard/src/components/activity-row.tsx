'use client'

import type { ActivityItem } from '@agentauth-sol/sdk'
import { formatAmount } from '@/lib/format'
import { Chip } from './ui'
import { AddressText, SignatureLink } from './address'

const KIND_LABEL: Record<string, string> = {
  create: 'Mandate created',
  add_permission: 'Permission added',
  remove_permission: 'Permission removed',
  update_permission: 'Limits updated',
  set_active: 'Mandate paused or resumed',
  revoke: 'Mandate revoked',
  verify: 'verify call',
  relay_transfer: 'Relay payment',
  relay_swap: 'Relay swap',
  relay_init: 'Relay policy created',
  relay_pause: 'Relay paused or resumed',
  relay_close: 'Relay policy closed',
  token_transfer: 'Direct token transfer',
  unknown: 'Other transaction',
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/**
 * One row of the activity feed. A transaction that landed and failed is BLOCKED: the decoded
 * reason is shown with the program that raised it.
 */
export function ActivityRow({
  item,
  decimals,
  symbol,
  labels,
  nowSeconds,
}: {
  item: ActivityItem
  decimals: number | null
  /** Token symbol shown after the amount (optional). */
  symbol?: string | null
  labels: Readonly<Record<string, string>>
  nowSeconds: number
}) {
  const blocked = !item.ok
  const when =
    item.blockTime === null
      ? `slot ${item.slot.toString()}`
      : new Date(Number(item.blockTime) * 1000).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
  const ago = item.blockTime === null ? null : Math.max(0, nowSeconds - Number(item.blockTime))
  return (
    <li
      data-testid="activity-row"
      data-blocked={blocked ? 'true' : 'false'}
      className="grid gap-2 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[auto_1fr_auto] sm:items-start"
    >
      <div className="pt-0.5">
        {blocked ? <Chip tone="bad">blocked</Chip> : <Chip tone="ok">allowed</Chip>}
      </div>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">
          {kindLabel(item.kind)}
          {item.discriminatorName ? (
            <span className="ml-2 font-mono text-xs font-normal text-muted">
              {item.discriminatorName}
            </span>
          ) : null}
          {item.viaProgram ? (
            <span className="ml-2 text-xs font-normal text-muted">via CPI</span>
          ) : null}
        </p>
        {item.amount !== undefined ? (
          <p>
            Amount <span className="font-mono">{formatAmount(item.amount, decimals)}</span>
            {symbol ? ` ${symbol}` : ''}
            {item.recipient ? (
              <>
                {' '}
                to{' '}
                <AddressText
                  value={item.recipient}
                  {...(labels[item.recipient] ? { label: labels[item.recipient] } : {})}
                />
              </>
            ) : null}
          </p>
        ) : null}
        {blocked && item.error ? (
          <div
            className="rounded-md border border-bad/40 bg-bad-bg p-2"
            data-testid="activity-error"
          >
            <p className="font-semibold text-bad">
              {item.error.program}: {item.error.name}{' '}
              <span className="font-mono text-xs font-normal">(code {item.error.code})</span>
            </p>
            <p className="text-ink">{item.error.message}</p>
          </div>
        ) : blocked ? (
          <p className="text-bad">The transaction failed (no program error code in its logs).</p>
        ) : null}
        {item.fetchError ? (
          <p className="text-warn">Could not decode this transaction: {item.fetchError}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted sm:items-end">
        <span
          title={
            item.blockTime === null
              ? undefined
              : new Date(Number(item.blockTime) * 1000).toISOString()
          }
        >
          {when}
          {ago !== null && ago < 3600 ? ` (${ago}s ago)` : ''}
        </span>
        <SignatureLink signature={item.signature} />
      </div>
    </li>
  )
}
