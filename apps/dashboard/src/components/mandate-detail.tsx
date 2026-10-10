'use client'

import { useMemo, useState } from 'react'
import { isoOfSeconds, type Permission, type PauseScope } from '@agentauth-sol/sdk'
import { isAddress, type Address } from '@solana/kit'
import { useChain, useClient } from '@/lib/chain'
import { relativeTime, formatAmount } from '@/lib/format'
import { loadMandateDetail, relayPaused, statusOf, type MandateDetail } from '@/lib/mandate-data'
import { readLabels } from '@/lib/owner-data'
import { toDisplayError } from '@/lib/tx-runner'
import { useActivity } from '@/lib/use-activity'
import { useAsync } from '@/lib/use-async'
import { useWallet } from '@/lib/wallet/wallet-provider'
import { ActivityRow } from './activity-row'
import { AddressText } from './address'
import { AsyncBoundary } from './async-boundary'
import { ExplainPreview } from './explain'
import { StatusChip, useNowSeconds } from './mandate-card'
import { PermissionTable } from './permission-table'
import { PlanActionDialog } from './plan-action-dialog'
import { Button, Card, Chip, EmptyState, ErrorBox, Notice, Skeleton } from './ui'

type Action =
  | { kind: 'pause'; scope: PauseScope }
  | { kind: 'resume'; scope: PauseScope }
  | { kind: 'revoke'; permission: Permission; disc: string; title: string }
  | { kind: 'unwind' }

function ActivityFeed({ detail }: { detail: MandateDetail }) {
  const client = useClient()
  const feed = useActivity(client, detail.address)
  const [visible, setVisible] = useState(12)
  const labels = useMemo(() => (typeof window === 'undefined' ? {} : readLabels()), [])
  const now = useNowSeconds(5000)
  const decimals = detail.budgetMint?.decimals ?? null
  return (
    <section aria-labelledby="activity-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="activity-heading" className="text-lg font-semibold">
          Activity
        </h2>
        <p className="text-xs text-muted" role="status">
          {feed.state.refreshing ? 'Refreshing...' : 'Live: refreshes every 5 seconds'}
        </p>
      </div>
      <p className="text-sm text-muted">
        Everything that touched this mandate or its relay policy: allowed and blocked. A blocked
        attempt only shows up here if it landed on chain (the scripted attacks do; a wallet that
        simulates first never sends one).
      </p>
      <AsyncBoundary
        state={feed.state}
        what="the activity feed"
        skeleton={<Skeleton className="h-24 w-full" />}
      >
        {() =>
          feed.rows.length === 0 ? (
            <EmptyState title="No activity yet">
              <p>
                Nothing has touched this mandate. When the agent acts, or someone tries to, it
                appears here with the decoded reason.
              </p>
            </EmptyState>
          ) : (
            <>
              <ul className="space-y-3" aria-label="Activity feed">
                {feed.rows.slice(0, visible).map((item) => (
                  <ActivityRow
                    key={`${item.signature}:${item.instructionIndex}:${item.kind}`}
                    item={item}
                    decimals={decimals}
                    labels={labels}
                    nowSeconds={now}
                  />
                ))}
              </ul>
              {feed.rows.length > visible ? (
                <Button onClick={() => setVisible((v) => v + 20)} data-testid="feed-more">
                  Show {Math.min(20, feed.rows.length - visible)} more ({feed.rows.length - visible}{' '}
                  not shown)
                </Button>
              ) : null}
              {feed.rows.length <= visible && feed.canLoadOlder ? (
                <Button onClick={() => void feed.loadOlder()} disabled={feed.loadingOlder}>
                  {feed.loadingOlder ? 'Loading...' : 'Show older'}
                </Button>
              ) : null}
            </>
          )
        }
      </AsyncBoundary>
    </section>
  )
}

function Header({
  detail,
  canAct,
  onAction,
}: {
  detail: MandateDetail
  canAct: boolean
  onAction: (a: Action) => void
}) {
  const now = useNowSeconds(1000)
  const expiry = detail.mandate.expiry
  const status = statusOf(detail)
  const mandatePaused = !detail.mandate.active
  const policy = detail.view.policy
  const [scope, setScope] = useState<'relay' | 'both'>('relay')
  const anythingPaused = mandatePaused || relayPaused(detail)
  return (
    <Card as="section" aria-labelledby="mandate-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 id="mandate-heading" className="text-2xl font-semibold tracking-tight">
            Mandate
          </h1>
          <p className="text-sm">
            Agent <AddressText value={detail.mandate.agent} link />
          </p>
          <p className="text-sm">
            Owner <AddressText value={detail.mandate.owner} link />
          </p>
          <p className="text-sm text-muted">
            Mandate account <AddressText value={detail.address} link />
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2" data-testid="status-chips">
            <StatusChip detail={detail} />
            {policy ? (
              relayPaused(detail) ? (
                <Chip tone="warn">relay paused</Chip>
              ) : (
                <Chip tone="ok">relay live</Chip>
              )
            ) : (
              <Chip tone="neutral" mark={false}>
                no relay policy
              </Chip>
            )}
          </div>
          <p className="text-sm" title={isoOfSeconds(expiry)}>
            {status === 'expired' ? 'Expired ' : 'Expires '}
            <span className="font-medium">{relativeTime(expiry, now)}</span>
          </p>
        </div>
      </div>

      {canAct ? (
        <div className="mt-6 space-y-4 border-t border-line pt-4">
          {policy ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Pause scope</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'relay'}
                  onChange={() => setScope('relay')}
                  className="mt-1"
                />
                <span>
                  <strong>Relay only.</strong> Payments and swaps through the relay stop. Other
                  programs that call verify on this mandate still pass.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'both'}
                  onChange={() => setScope('both')}
                  className="mt-1"
                />
                <span>
                  <strong>Whole mandate.</strong> The relay and every verify call stop until you
                  resume.
                </span>
              </label>
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => onAction({ kind: 'pause', scope: policy ? scope : 'mandate' })}
              disabled={status === 'expired'}
              data-testid="pause-button"
            >
              Pause
            </Button>
            <Button
              onClick={() => onAction({ kind: 'resume', scope: policy ? scope : 'mandate' })}
              disabled={!anythingPaused}
              data-testid="resume-button"
            >
              Resume
            </Button>
            <Button
              variant="danger"
              onClick={() => onAction({ kind: 'unwind' })}
              data-testid="unwind-button"
            >
              Unwind: revoke everything
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-6 border-t border-line pt-4 text-sm text-muted">
          Read-only. Connect the owner wallet ({detail.mandate.owner.slice(0, 4)}...) to pause,
          narrow or revoke.
        </p>
      )}
    </Card>
  )
}

function Body({ detail, refresh }: { detail: MandateDetail; refresh: () => void }) {
  const client = useClient()
  const { registryData } = useChain()
  const { wallet } = useWallet()
  const [action, setAction] = useState<Action | null>(null)
  const canAct = wallet !== null && wallet.address === detail.mandate.owner
  const explanation = detail.view.explanation
  const policy = detail.view.policy
  const capacity = detail.view.capacity
  const decimals = detail.budgetMint?.decimals ?? null

  const buildPlan = async () => {
    if (!wallet || !action) throw new Error('No action')
    const base = { owner: wallet.address, agent: detail.mandate.agent }
    switch (action.kind) {
      case 'pause':
        return client.plan.pause({ ...base, scope: action.scope })
      case 'resume':
        return client.plan.resume({ ...base, scope: action.scope })
      case 'revoke':
        return client.plan.revokeDiscriminator({
          ...base,
          program: action.permission.program,
          discriminators: [action.disc],
          allowUnlimited: action.permission.spendUnlimited || action.permission.perTxUnlimited,
        })
      case 'unwind':
        return client.plan.unwind(base)
    }
  }

  const copy = (() => {
    if (!action) return { title: '', what: null as React.ReactNode, confirm: '', danger: false }
    switch (action.kind) {
      case 'pause':
        return {
          title: action.scope === 'relay' ? 'Pause the relay' : 'Pause the whole mandate',
          confirm: 'Pause',
          danger: false,
          what:
            action.scope === 'relay'
              ? 'The relay will refuse every payment and swap for this mandate (error 116, Paused). Nothing is revoked: you can resume at any time.'
              : 'The relay will refuse every action and the mandate itself is switched off, so every verify call fails too. Nothing is revoked: you can resume at any time.',
        }
      case 'resume':
        return {
          title: 'Resume',
          confirm: 'Resume',
          danger: false,
          what: 'The agent can act again, within the same limits and budget as before.',
        }
      case 'revoke':
        return {
          title: `Revoke "${action.title}"`,
          confirm: 'Revoke this instruction',
          danger: true,
          what: (
            <>
              The agent loses the right to call <strong>{action.title}</strong> on this program. Its
              other instructions and the remaining budget are kept. If this is the only instruction
              of the permission, the whole permission is removed and the next call fails with
              ProgramNotAllowed (6). A bare removal resets the counters, so the SDK carries the
              remaining budget over instead of granting a fresh one.
            </>
          ),
        }
      case 'unwind':
        return {
          title: 'Unwind: revoke everything in one transaction',
          confirm: 'Revoke everything',
          danger: true,
          what: (
            <>
              In a single transaction: the SPL allowance you gave the relay is revoked, the mandate
              is closed (its rent comes back to you) and the relay policy is closed. The agent can
              do nothing afterwards, through the relay or through any program that checks the
              mandate. <strong>This does not undo past transfers</strong> and cannot be reversed: to
              start again you create a new mandate.
            </>
          ),
        }
    }
  })()

  const showAdvisory =
    explanation && explanation.enforcement.some((e) => e.level.startsWith('advisory'))

  return (
    <div className="space-y-8">
      <Header detail={detail} canAct={canAct} onAction={setAction} />

      {capacity ? (
        <Card as="section" aria-labelledby="capacity-heading">
          <h2 id="capacity-heading" className="mb-4 text-lg font-semibold">
            What the relay could move right now
          </h2>
          {capacity.blockedBy ? (
            <Notice tone="warn" title={`Blocked: ${capacity.blockedBy.name}`}>
              {capacity.blockedBy.why}
            </Notice>
          ) : (
            <div className="space-y-2">
              <p className="text-2xl font-semibold" data-testid="max-spend">
                {formatAmount(capacity.maxSpendNow, decimals)}
              </p>
              <p className="text-sm text-muted">
                Limited by:{' '}
                {capacity.limitedBy.length
                  ? capacity.limitedBy.map((l) => l.replace(/_/g, ' ')).join(', ')
                  : 'nothing finite'}
                .
                {capacity.partial
                  ? ' This may be too high: the live balance or delegation could not be read.'
                  : ''}{' '}
                It is an upper bound read at one moment, not a promise.
              </p>
            </div>
          )}
          {detail.view.delegation ? (
            <p className="mt-3 text-sm text-muted">
              SPL allowance left:{' '}
              <span className="font-mono">
                {formatAmount(detail.view.delegation.delegatedAmount, decimals)}
              </span>
              {detail.view.balance !== null ? (
                <>
                  {' '}
                  · source balance{' '}
                  <span className="font-mono">{formatAmount(detail.view.balance, decimals)}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </Card>
      ) : null}

      {explanation ? (
        <Card as="section" aria-label="Plain-English summary">
          <ExplainPreview explanation={explanation} />
        </Card>
      ) : null}

      <section aria-labelledby="perm-heading" className="space-y-3">
        <h2 id="perm-heading" className="text-lg font-semibold">
          Permissions
        </h2>
        {showAdvisory ? (
          <p className="text-sm text-muted">
            <strong>Advisory</strong> rows bind only if the program that does the work calls{' '}
            <code>verify</code>. Only the <strong>hard (relay)</strong> rows are enforced by the
            relay itself.
          </p>
        ) : null}
        <PermissionTable
          mandate={detail.mandate}
          policy={policy}
          registry={client.registry}
          decimalsFor={detail.decimalsFor}
          disabled={!canAct}
          {...(canAct
            ? {
                onRevoke: (permission: Permission, disc: string, title: string) =>
                  setAction({ kind: 'revoke', permission, disc, title }),
              }
            : {})}
        />
      </section>

      {policy ? (
        <Card as="section" aria-labelledby="policy-heading">
          <h2 id="policy-heading" className="mb-3 text-lg font-semibold">
            Relay policy
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Spends from</dt>
              <dd>
                <AddressText value={policy.sourceAccount} link />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Budget mint</dt>
              <dd>
                <AddressText value={policy.budgetMint} link />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Relay authority (SPL delegate)</dt>
              <dd>
                <AddressText value={policy.authority} link />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Allowed recipients (token accounts)</dt>
              <dd className="space-y-1">
                {policy.recipients.length === 0 ? (
                  <span>none: the relay cannot pay anyone</span>
                ) : (
                  policy.recipients.map((r) => (
                    <div key={r}>
                      <AddressText value={r} link />
                    </div>
                  ))
                )}
              </dd>
            </div>
            {policy.swap ? (
              <div className="sm:col-span-2">
                <dt className="text-muted">
                  Pinned swap pool (price floor {policy.swap.floorOut.toString()} out per{' '}
                  {policy.swap.floorIn.toString()} in, raw units)
                </dt>
                <dd>
                  <AddressText value={policy.swap.poolState} link />
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ) : null}

      <ActivityFeed detail={detail} />

      {wallet && canAct && action ? (
        <PlanActionDialog
          key={`${action.kind}-${action.kind === 'revoke' ? action.disc : ''}`}
          open
          wallet={wallet}
          title={copy.title}
          what={copy.what}
          confirmLabel={copy.confirm}
          danger={copy.danger}
          buildPlan={buildPlan}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null)
            refresh()
          }}
        />
      ) : null}

      <details className="rounded-lg border border-line p-4 text-sm">
        <summary className="cursor-pointer font-medium">Show raw</summary>
        <pre className="mt-3 overflow-x-auto text-xs" data-testid="raw-json">
          {JSON.stringify(
            {
              address: detail.address,
              expiry: detail.mandate.expiry.toString(),
              active: detail.mandate.active,
              permissions: detail.mandate.permissions.map((p) => ({
                program: p.program,
                spendLimit: p.spendLimit.toString(),
                perTxLimit: p.perTxLimit.toString(),
                spendTotal: p.spendTotal.toString(),
                callCount: p.callCount,
                discriminators: p.discriminatorsHex,
              })),
            },
            null,
            2,
          )}
        </pre>
      </details>
      <span className="hidden">{registryData.programs.length}</span>
    </div>
  )
}

export function MandateDetailView({ address }: { address: string }) {
  const client = useClient()
  const valid = isAddress(address)
  const state = useAsync(() => loadMandateDetail(client, address as Address), [address], {
    enabled: valid,
    intervalMs: 6000,
  })
  if (!valid) {
    return (
      <ErrorBox
        error={{
          title: 'Not an address',
          detail: 'This URL does not contain a valid Solana address.',
        }}
      />
    )
  }
  return (
    <AsyncBoundary state={state} what="the mandate" skeleton={<Skeleton className="h-64 w-full" />}>
      {(detail) =>
        detail === null ? (
          <EmptyState title="No mandate at this address">
            <p>
              Either it never existed on this cluster, or it was revoked (revoking closes the
              account and returns its rent). The history of a revoked mandate stays on chain and in
              the explorer.
            </p>
          </EmptyState>
        ) : (
          <Body detail={detail} refresh={state.refresh} />
        )
      }
    </AsyncBoundary>
  )
}

export { toDisplayError }
