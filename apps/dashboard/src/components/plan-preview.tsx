'use client'

import type { Plan } from '@agentauth-sol/sdk'
import { useClient } from '@/lib/chain'
import { decodeInstruction } from '@/lib/decode-ix'
import { AddressText } from './address'
import { Chip, Notice } from './ui'

/** The exact transactions a plan will ask the wallet to sign, decoded, with raw bytes behind "Show raw". */
export function PlanPreview({ plan }: { plan: Plan }) {
  const client = useClient()
  return (
    <div className="space-y-3" data-testid="plan-preview">
      <p className="text-sm">{plan.summary}</p>
      {plan.warnings.length > 0 ? (
        <Notice tone="warn" title="Plan warnings">
          <ul className="list-disc space-y-1 pl-5">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <details className="rounded-lg border border-line">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Show the exact transactions ({plan.steps.length} to sign)
        </summary>
        <div className="space-y-4 border-t border-line p-4">
          {plan.steps.map((step, i) => (
            <section
              key={`${i}-${step.label}`}
              aria-label={`Transaction ${i + 1}`}
              className="space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold">
                  Transaction {i + 1}: {step.label}
                </h4>
                <Chip tone="neutral" mark={false}>
                  {step.estimatedSizeBytes} bytes
                </Chip>
                {step.dependsOn.length > 0 ? (
                  <Chip tone="neutral" mark={false}>
                    after transaction {step.dependsOn.map((d) => d + 1).join(', ')} confirms
                  </Chip>
                ) : null}
              </div>
              <p className="text-sm text-muted">{step.expectedOutcome}</p>
              <ol className="space-y-2">
                {step.instructions.map((ix, j) => {
                  const d = decodeInstruction(ix, client.programIds)
                  return (
                    <li key={j} className="rounded-md border border-line bg-surface-2 p-3 text-sm">
                      <p className="font-medium">
                        {d.program}: <span className="font-mono">{d.name}</span>
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted">Show raw</summary>
                        <div className="mt-2 space-y-1 text-xs">
                          <p>
                            Program <AddressText value={ix.programAddress} />
                          </p>
                          <ul className="space-y-1">
                            {d.accounts.map((a, k) => (
                              <li key={k} className="flex flex-wrap items-center gap-2">
                                <AddressText value={a.address} />
                                <span className="text-muted">
                                  {a.signer ? 'signer ' : ''}
                                  {a.writable ? 'writable' : 'read-only'}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <p className="break-all font-mono">data {d.dataHex}</p>
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      </details>
    </div>
  )
}
