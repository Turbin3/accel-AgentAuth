import type { StepProgress } from '@/lib/tx-runner'
import { ErrorBox, Chip, type Tone } from './ui'
import { SignatureLink } from './address'

const STATUS: Record<StepProgress['status'], { label: string; tone: Tone }> = {
  pending: { label: 'waiting', tone: 'neutral' },
  running: { label: 'sign and confirm', tone: 'warn' },
  done: { label: 'confirmed', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
}

export function TxProgress({ steps }: { steps: readonly StepProgress[] }) {
  if (steps.length === 0) return null
  return (
    <ol aria-label="Transaction progress" aria-live="polite" className="space-y-3">
      {steps.map((s, i) => (
        <li
          key={`${i}-${s.label}`}
          className="rounded-lg border border-line p-4"
          data-testid="tx-step"
          data-status={s.status}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {i + 1}. {s.label}
            </p>
            <Chip
              tone={STATUS[s.status].tone}
              mark={s.status !== 'pending' && s.status !== 'running'}
            >
              {STATUS[s.status].label}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-muted">{s.description}</p>
          {s.signature ? (
            <p className="mt-2 text-xs">
              Signature: <SignatureLink signature={s.signature} />
            </p>
          ) : null}
          {s.error ? (
            <div className="mt-3">
              <ErrorBox error={s.error} />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
