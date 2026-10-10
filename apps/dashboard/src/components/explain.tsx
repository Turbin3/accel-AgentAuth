import type { Explanation } from '@agentauth-sol/sdk'
import { Chip, Notice } from './ui'
import { EnforcementTag, enforcementLevel } from './risk'

/**
 * Plain-English view of an SDK Explanation: what the agent CAN and CANNOT do, which parts are hard,
 * and the warnings. Pure presentation: every sentence comes from explainMandate.
 */
export function ExplainPreview({
  explanation,
  heading = 'In plain English',
  hypothetical = false,
}: {
  explanation: Explanation
  heading?: string
  /** True for a wizard preview of a mandate that does not exist on chain yet. */
  hypothetical?: boolean
}) {
  const statusTone =
    explanation.status === 'active' ? 'ok' : explanation.status === 'paused' ? 'warn' : 'bad'
  return (
    <div data-testid="explain-preview" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{heading}</h3>
        {hypothetical ? (
          <Chip tone="neutral" mark={false}>
            preview, not on chain yet
          </Chip>
        ) : (
          <Chip tone={statusTone}>{explanation.status}</Chip>
        )}
      </div>
      <p className="text-sm">{explanation.headline}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <section
          aria-labelledby="can-heading"
          className="rounded-lg border border-line bg-surface-2 p-4"
        >
          <h4 id="can-heading" className="mb-2 text-sm font-semibold">
            The agent CAN
          </h4>
          {explanation.can.length === 0 ? (
            <p className="text-sm text-muted">Nothing right now ({explanation.status}).</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {explanation.can.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>
        <section
          aria-labelledby="cannot-heading"
          className="rounded-lg border border-line bg-surface-2 p-4"
        >
          <h4 id="cannot-heading" className="mb-2 text-sm font-semibold">
            The agent CANNOT
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {explanation.cannot.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
      {explanation.enforcement.length > 0 ? (
        <section aria-label="Enforcement">
          <h4 className="mb-2 text-sm font-semibold">What is enforced, and by what</h4>
          <ul className="space-y-2 text-sm">
            {explanation.enforcement.map((e) => (
              <li key={e.action} className="flex flex-wrap items-start gap-2">
                <EnforcementTag level={enforcementLevel(e.level)} />
                <span className="min-w-0 flex-1">{e.action}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {explanation.warnings.length > 0 ? (
        <Notice tone="warn" title="Warnings">
          <ul className="list-disc space-y-1 pl-5">
            {explanation.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  )
}
