'use client'

import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { PlanRefusedError, type Plan } from '@agentauth-sol/sdk'
import { useClient } from '@/lib/chain'
import { decodeInstruction } from '@/lib/decode-ix'
import { toDisplayError, useTxRunner } from '@/lib/tx-runner'
import type { ConnectedWallet } from '@/lib/wallet/types'
import { PlanPreview } from './plan-preview'
import { TxProgress } from './tx-progress'
import { Button, Dialog, Notice, Skeleton } from './ui'

/**
 * Confirmation dialog for one owner action. It builds the plan from the chain when it opens, states
 * exactly which instructions will be sent, and only then asks for the signature. A refused plan
 * (nothing to do, unsafe) is shown with the SDK's own reasons.
 */
export function PlanActionDialog({
  open,
  onClose,
  onDone,
  wallet,
  title,
  what,
  buildPlan,
  confirmLabel,
  danger = false,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
  wallet: ConnectedWallet
  title: string
  /** Plain-language consequences, shown above the instruction list. */
  what: ReactNode
  buildPlan: () => Promise<Plan>
  confirmLabel: string
  danger?: boolean
}) {
  const client = useClient()
  const runner = useTxRunner(client, wallet.signer)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<{ title: string; reasons: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const build = useEffectEvent(buildPlan)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    build()
      .then((p) => {
        if (!cancelled) setPlan(p)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof PlanRefusedError)
          setError({ title: 'The SDK refused this plan', reasons: [...e.reasons] })
        else
          setError({
            title: 'Could not build the transaction',
            reasons: [toDisplayError(e).detail],
          })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const finished = runner.done
  const instructions =
    plan?.steps.flatMap((s) =>
      s.instructions.map((ix) => decodeInstruction(ix, client.programIds)),
    ) ?? []

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!runner.running) {
          if (finished) onDone()
          runner.reset()
          onClose()
        }
      }}
      title={title}
      description={what}
      footer={
        finished ? (
          <Button
            variant="primary"
            onClick={() => {
              onDone()
              runner.reset()
              onClose()
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={runner.running}>
              Cancel
            </Button>
            <Button
              variant={danger ? 'danger' : 'primary'}
              disabled={!plan || runner.running}
              onClick={() => plan && void runner.run(plan)}
              data-testid="confirm-action"
            >
              {runner.running ? 'Waiting for wallet and chain...' : confirmLabel}
            </Button>
          </>
        )
      }
    >
      {loading ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {error ? (
        <Notice tone="bad" title={error.title}>
          <ul className="list-disc space-y-1 pl-5">
            {error.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {plan && runner.steps.length === 0 ? (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">This will send, in order:</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="will-send">
              {instructions.map((d, i) => (
                <li key={i}>
                  {d.program}: <span className="font-mono">{d.name}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted">
              {plan.steps.length} transaction{plan.steps.length === 1 ? '' : 's'}, signed by your
              wallet.
            </p>
          </div>
          <PlanPreview plan={plan} />
        </div>
      ) : null}
      {runner.steps.length > 0 ? <TxProgress steps={runner.steps} /> : null}
    </Dialog>
  )
}
