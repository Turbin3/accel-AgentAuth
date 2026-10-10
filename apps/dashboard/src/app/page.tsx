import Link from 'next/link'
import { ConnectCta } from '@/components/connect-cta'
import { DemoMandate } from '@/components/demo-mandate'
import { ProgramStatus } from '@/components/program-status'
import { RepoLink } from '@/components/repo-link'
import { Card } from '@/components/ui'

const STEPS = [
  {
    n: '1',
    title: 'Mandate',
    body: 'You write down what the agent may do: which programs and instructions, a cap per call, a total budget and an expiry. It is an account on Solana that you own and can change.',
  },
  {
    n: '2',
    title: 'Relay',
    body: 'The agent holds a key but no token authority. Payments and swaps go through the relay program, which checks the mandate and spends only a bounded SPL allowance you delegated to it.',
  },
  {
    n: '3',
    title: 'Chain',
    body: 'The Token program enforces the allowance and the relay enforces the allowlist and the budget. Every allowed and every blocked attempt is on chain, and this dashboard decodes why.',
  },
]

export default function Home() {
  return (
    <main className="space-y-12">
      <section className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Give an AI agent a budget, not your keys.
        </h1>
        <p className="mt-4 text-lg text-muted">
          A mandate says which programs and instructions an agent may call, how much per call, how
          much in total and until when. You can pause it, narrow it or end it in one transaction.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <ConnectCta />
          <Link href="/simulator" className="text-sm font-medium underline">
            Or try to break one first
          </Link>
        </div>
      </section>

      <section aria-labelledby="how" className="space-y-4">
        <h2 id="how" className="text-xl font-semibold">
          How it fits together
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative">
              <Card as="div" className="h-full">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span
                    aria-hidden="true"
                    className="grid h-6 w-6 place-items-center rounded-full bg-accent text-xs text-accent-ink"
                  >
                    {s.n}
                  </span>
                  {s.title}
                  {i < STEPS.length - 1 ? (
                    <span aria-hidden="true" className="ml-auto hidden text-muted md:inline">
                      &rarr;
                    </span>
                  ) : null}
                </p>
                <p className="mt-2 text-sm text-muted">{s.body}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="honest"
        className="rounded-xl border border-warn/50 bg-warn-bg p-4 sm:p-6"
      >
        <h2 id="honest" className="text-lg font-semibold text-warn">
          What this is, and is not
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>An unaudited devnet prototype. Do not put funds behind it that you cannot lose.</li>
          <li>
            <strong>Hard enforcement</strong> exists only where the relay program enforces it: the
            relay transfer to an allowlisted token account, and the single pinned swap. Everything
            else a mandate lists is <strong>advisory</strong>: it binds only if the program doing
            the work calls <code>verify</code>.
          </li>
          <li>
            It caps the damage a fooled or compromised agent can do on chain. It does not prevent
            prompt injection.
          </li>
        </ul>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="status" className="space-y-3">
          <h2 id="status" className="text-xl font-semibold">
            Live program status
          </h2>
          <Card as="div">
            <ProgramStatus />
          </Card>
        </section>
        <section aria-labelledby="learn" className="space-y-3">
          <h2 id="learn" className="text-xl font-semibold">
            Read more
          </h2>
          <Card as="div">
            <ul className="space-y-3 text-sm">
              <li>
                <Link href="/docs" className="font-medium underline">
                  Security model and limits
                </Link>
                <span className="text-muted"> - what is enforced, what is not, and why.</span>
              </li>
              <li>
                <Link href="/registry" className="font-medium underline">
                  Verified registry
                </Link>
                <span className="text-muted">
                  {' '}
                  - programs, instructions and their risk classes.
                </span>
              </li>
              <li>
                <Link href="/simulator" className="font-medium underline">
                  Try to break it
                </Link>
                <span className="text-muted">
                  {' '}
                  - a scripted compromised agent against a demo mandate.
                </span>
              </li>
              <RepoLink />
            </ul>
          </Card>
        </section>
      </div>

      <DemoMandate />
    </main>
  )
}
