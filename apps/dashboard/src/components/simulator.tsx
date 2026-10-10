'use client'

import Link from 'next/link'
import { useState } from 'react'
import { formatAmount } from '@/lib/format'
import { useClient } from '@/lib/chain'
import { useConfig } from '@/lib/config-context'
import { loadMandateDetail } from '@/lib/mandate-data'
import { useAsync } from '@/lib/use-async'
import { AddressText, SignatureLink } from './address'
import { AsyncBoundary } from './async-boundary'
import { MandateCard } from './mandate-card'
import { Button, Card, Chip, EmptyState, Notice, Skeleton } from './ui'
import type { Address } from '@solana/kit'

interface AttackSpec {
  readonly id: string
  readonly title: string
  readonly what: string
  readonly expected: string
  readonly control?: boolean
}

interface SimState {
  readonly available: boolean
  readonly reason: string | null
  readonly problems: readonly string[]
  readonly mandate: Address | null
  readonly mandateExists: boolean
  readonly ready: boolean
  readonly balances: {
    readonly ownerDusd: string
    readonly aliceDusd: string
    readonly attackerDusd: string
    readonly attackerDout: string
    readonly delegatedAmount: string
    readonly decimals: number
  } | null
  readonly attacks: readonly AttackSpec[]
}

interface AttackResult {
  readonly id: string
  readonly title: string
  readonly expected: string
  readonly outcome: 'blocked' | 'allowed' | 'error'
  readonly signature: string | null
  readonly error: {
    program: string
    code: number
    name: string
    message: string
    hint: string
  } | null
  readonly detail: string | null
  readonly steps: readonly { label: string; by: string; signature: string | null; ok: boolean }[]
  readonly logs: readonly string[]
}

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/simulator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `The simulator answered ${res.status}`)
  return json
}

function ResultCard({ result }: { result: AttackResult }) {
  const actual = result.error
    ? `${result.error.program} ${result.error.code} ${result.error.name}`
    : result.outcome === 'allowed'
      ? 'succeeds'
      : 'no decoded error'
  const matches = actual === result.expected
  return (
    <Card
      as="article"
      aria-label={`Result: ${result.title}`}
      data-testid="attack-result"
      data-attack={result.id}
      data-outcome={result.outcome}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold">{result.title}</h3>
        <div className="flex flex-wrap gap-2">
          {result.outcome === 'blocked' ? <Chip tone="ok">blocked on chain</Chip> : null}
          {result.outcome === 'allowed' ? (
            <Chip tone="neutral" mark={false}>
              allowed
            </Chip>
          ) : null}
          {result.outcome === 'error' ? <Chip tone="bad">did not reach the chain</Chip> : null}
          {matches ? (
            <Chip tone="ok">as expected</Chip>
          ) : (
            <Chip tone="warn">expected {result.expected}</Chip>
          )}
        </div>
      </div>
      {result.error ? (
        <div
          className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-sm"
          data-testid="attack-error"
        >
          <p className="font-semibold" data-testid="attack-error-title">
            {result.error.program}: {result.error.name}{' '}
            <span className="font-mono text-xs font-normal">(code {result.error.code})</span>
          </p>
          <p className="mt-1">{result.error.message}</p>
          <p className="mt-2 text-muted">
            <span className="font-medium text-ink">What it means: </span>
            {result.error.hint}
          </p>
        </div>
      ) : null}
      {result.detail ? <p className="mt-3 text-sm text-bad">{result.detail}</p> : null}
      {result.signature ? (
        <p className="mt-3 text-sm">
          Transaction <SignatureLink signature={result.signature} />{' '}
          <span className="text-xs text-muted">
            (landed with preflight skipped, so the failure is recorded on chain and a failed
            transaction still pays its fee)
          </span>
        </p>
      ) : null}
      {result.steps.length > 1 ? (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm" aria-label="Steps">
          {result.steps.map((s, i) => (
            <li key={i}>
              {s.label} <span className="text-xs text-muted">({s.by})</span>
              {s.signature ? (
                <>
                  {' '}
                  <SignatureLink signature={s.signature} />
                </>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {result.logs.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted">Show raw</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-2 p-3 text-xs">
            {result.logs.join('\n')}
          </pre>
        </details>
      ) : null}
    </Card>
  )
}

function Balances({ state }: { state: SimState }) {
  const b = state.balances
  if (!b) return null
  const d = b.decimals
  const rows: [string, string][] = [
    ['Attacker (DUSD)', formatAmount(BigInt(b.attackerDusd), d)],
    ['Attacker (DOUT)', formatAmount(BigInt(b.attackerDout), d)],
    ['Alice, the allowed recipient (DUSD)', formatAmount(BigInt(b.aliceDusd), d)],
    ['Owner source account (DUSD)', formatAmount(BigInt(b.ownerDusd), d)],
    ['SPL allowance left for the relay', formatAmount(BigInt(b.delegatedAmount), d)],
  ]
  return (
    <Card as="section" aria-labelledby="balances-heading">
      <h2 id="balances-heading" className="mb-3 text-base font-semibold">
        Balances after the attempts
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="sim-balances">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd
              className="font-mono text-sm"
              data-testid={`balance-${k.split(' ')[0]?.toLowerCase()}`}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        The attacker stays at zero: every attempt below that targets it is stopped by a program, not
        by this page.
      </p>
    </Card>
  )
}

export function Simulator() {
  const config = useConfig()
  const client = useClient()
  const state = useAsync<SimState>(
    async (signal) => {
      const res = await fetch('/api/simulator', { cache: 'no-store', signal })
      const json = (await res.json()) as SimState & { error?: string }
      if (!res.ok) throw new Error(json.error ?? `The simulator answered ${res.status}`)
      return json
    },
    [config.cluster],
    { enabled: config.cluster === 'localnet', intervalMs: 8000 },
  )
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<AttackResult[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  const mandateAddress = state.data?.mandate ?? null
  const detail = useAsync(
    async () => (mandateAddress ? loadMandateDetail(client, mandateAddress) : null),
    [mandateAddress, results.length],
    { enabled: !!mandateAddress && !!state.data?.available },
  )

  if (config.cluster !== 'localnet') {
    return (
      <EmptyState title="The simulator runs on a local validator">
        <p>
          It signs with the demo keys created by the localnet bootstrap, and this dashboard never
          holds attack keys for a public cluster. Start a local validator with{' '}
          <code>scripts/localnet.sh start</code>, bootstrap the demo and run the dashboard with{' '}
          <code>NEXT_PUBLIC_AA_CLUSTER=localnet</code>.
        </p>
      </EmptyState>
    )
  }

  const run = async (id: string) => {
    setRunning(id)
    setFailure(null)
    try {
      const result = await postJson<AttackResult>({ action: 'attack', id })
      setResults((r) => [result, ...r])
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(null)
      state.refresh()
    }
  }
  const reset = async () => {
    setRunning('reset')
    setFailure(null)
    try {
      await postJson({ action: 'reset' })
      setResults([])
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(null)
      state.refresh()
    }
  }

  return (
    <div className="space-y-8">
      <Notice tone="warn" title="This attacker is a script">
        Every attack below is a fixed, scripted transaction signed by a demo key, not an AI. Nothing
        here shows that an AI agent can be stopped from being fooled; it shows what a fooled or
        compromised agent <em>cannot</em> do on chain. All attempts are sent with preflight skipped
        so the failure is recorded on the ledger.
      </Notice>

      <AsyncBoundary
        state={state}
        what="the simulator"
        skeleton={<Skeleton className="h-40 w-full" />}
      >
        {(s) =>
          !s.available ? (
            <EmptyState title="The demo environment is not ready">
              <p>{s.reason ?? s.problems.join('; ')}</p>
              <p className="mt-2">
                Run <code>pnpm --filter @agentauth-sol/demo bootstrap</code> against the local
                validator and reload.
              </p>
            </EmptyState>
          ) : (
            <>
              <section aria-labelledby="demo-mandate-heading" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="demo-mandate-heading" className="text-lg font-semibold">
                    The demo mandate
                  </h2>
                  <div className="flex gap-2">
                    {s.mandate && s.mandateExists ? (
                      <Link
                        href={`/mandates/${s.mandate}`}
                        className="inline-flex min-h-10 items-center rounded-lg border border-line-strong px-4 py-2 text-sm no-underline hover:bg-surface-2"
                      >
                        Open full detail and activity feed
                      </Link>
                    ) : null}
                    <Button
                      onClick={() => void reset()}
                      disabled={running !== null}
                      data-testid="sim-reset"
                    >
                      {running === 'reset' ? 'Resetting...' : 'Reset demo mandate'}
                    </Button>
                  </div>
                </div>
                {s.mandateExists && detail.data ? (
                  <MandateCard detail={detail.data} />
                ) : (
                  <Notice tone="neutral" title="No demo mandate yet">
                    It is created automatically by the first attack (two owner transactions), or
                    press &quot;Reset demo mandate&quot;.
                  </Notice>
                )}
                {s.mandate ? (
                  <p className="text-xs text-muted">
                    Mandate account <AddressText value={s.mandate} link />. Budget: 20 DUSD in
                    total, 5 per call; one allowed recipient; the SPL allowance (50) is deliberately
                    larger so the mandate is the binding cap.
                  </p>
                ) : null}
              </section>

              <Balances state={s} />

              <section aria-labelledby="attacks-heading" className="space-y-3">
                <h2 id="attacks-heading" className="text-lg font-semibold">
                  Attacks
                </h2>
                <ul className="grid gap-4 md:grid-cols-2" aria-label="Attacks">
                  {s.attacks.map((a) => (
                    <li key={a.id}>
                      <Card as="div" className="flex h-full flex-col justify-between gap-4">
                        <div>
                          <h3 className="text-base font-semibold">
                            {a.title}{' '}
                            {a.control ? (
                              <Chip tone="neutral" mark={false}>
                                control
                              </Chip>
                            ) : (
                              <Chip tone="neutral" mark={false}>
                                scripted attack
                              </Chip>
                            )}
                          </h3>
                          <p className="mt-1 text-sm text-muted">{a.what}</p>
                          <p className="mt-2 text-xs text-muted">
                            Expected: <span className="font-mono">{a.expected}</span>
                          </p>
                        </div>
                        <Button
                          variant={a.control ? 'secondary' : 'primary'}
                          disabled={running !== null}
                          onClick={() => void run(a.id)}
                          data-testid={`attack-${a.id}`}
                        >
                          {running === a.id ? 'Sending...' : a.control ? 'Run' : 'Run this attack'}
                        </Button>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )
        }
      </AsyncBoundary>

      {failure ? (
        <Notice tone="bad" title="The simulator hit a problem">
          {failure}
        </Notice>
      ) : null}

      <section aria-labelledby="results-heading" className="space-y-3" aria-live="polite">
        <h2 id="results-heading" className="text-lg font-semibold">
          Results
        </h2>
        {results.length === 0 ? (
          <p className="text-sm text-muted">
            Run an attack to see the decoded on-chain answer here.
          </p>
        ) : (
          <div className="space-y-4">
            {results.map((r, i) => (
              <ResultCard key={`${r.id}-${r.signature ?? i}`} result={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
