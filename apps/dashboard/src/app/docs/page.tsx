import type { Metadata } from 'next'
import Link from 'next/link'
import { PageTitle } from '@/components/ui'

export const metadata: Metadata = { title: 'Docs' }

const TOC = [
  ['spec', 'Spec summary'],
  ['hard', 'What is hard and what is advisory'],
  ['trust', 'Who holds what'],
  ['blast', 'Blast radius'],
  ['limits', 'Limits and honest caveats'],
  ['reading', 'Reading this dashboard'],
] as const

export default function DocsPage() {
  return (
    <main>
      <PageTitle
        title="Docs"
        lead="The short version of the spec, the security model and the limits. This is an unaudited devnet prototype."
      />
      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="text-sm lg:sticky lg:top-6 lg:self-start">
          <ul className="space-y-1">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-md px-3 py-1.5 no-underline hover:bg-surface-2"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="aa-prose max-w-3xl">
          <section id="spec" aria-labelledby="spec-h">
            <h2 id="spec-h" style={{ marginTop: 0 }}>
              Spec summary
            </h2>
            <p>
              A <strong>mandate</strong> is an account owned by the AgentAuth core program, derived
              from the owner and the agent keys. It lists up to 16 permissions. Each permission
              names a target program, up to 8 instruction discriminators (the canonical{' '}
              <code>disc8</code>), a lifetime spend limit, a per-call limit and running counters.
              The mandate also has an expiry and an active flag.
            </p>
            <p>
              Any program can call the core <code>verify</code> instruction, reporting the program
              id, the discriminator and an amount. <code>verify</code> checks expiry, the active
              flag, that the program and instruction are allowed and that the amount fits the
              per-call and lifetime limits, then books the spend.
            </p>
            <p>
              The owner can add, remove or change a permission, pause, resume or revoke at any time.
              Limits are
              <strong> raw units</strong> that this dashboard shows in human units. On chain, a
              limit of 0 means
              <strong> unlimited</strong>, so this dashboard never prints a bare 0: it says
              &quot;unlimited&quot; and asks you to confirm.
            </p>
            <p>
              The <strong>relay</strong> is a second program that adds a policy to a mandate: which
              token account it may spend from, an allowlist of recipient token accounts, and
              optionally one pinned swap pool with a price floor. The owner approves a bounded SPL
              allowance to a per-mandate PDA that only the relay can sign for. The agent holds a key
              but no token authority.
            </p>
            <p>
              Mandates are created in two transactions. The first creates the mandate, its
              permissions and the SPL allowance. The second creates the relay policy once the first
              is confirmed. Unwinding is one transaction: revoke the allowance, revoke the mandate,
              close the policy.
            </p>
          </section>

          <section id="hard" aria-labelledby="hard-h">
            <h2 id="hard-h">What is hard and what is advisory</h2>
            <p>
              <strong>Hard enforcement</strong> exists in exactly two places, and only while your
              SPL allowance is in place:
            </p>
            <ul>
              <li>
                the relay <code>transfer</code>: an SPL <code>TransferChecked</code> to an
                allowlisted token account, within the per-call cap and the lifetime budget;
              </li>
              <li>
                the relay <code>swap</code>: one pinned Raydium-CPMM-ABI pool, output forced into
                your own account, with a price floor.
              </li>
            </ul>
            <p>
              Everything else a mandate lists is <strong>advisory</strong>. <code>verify</code>{' '}
              trusts the program id, discriminator and amount that the caller reports, and any
              program can call it. A permission constrains an action only if the program that
              performs the action derives those values itself and refuses when <code>verify</code>{' '}
              fails. A program that never calls <code>verify</code> is not bound by any mandate.
              This dashboard labels every permission row <em>hard (relay)</em> or <em>advisory</em>{' '}
              for that reason.
            </p>
          </section>

          <section id="trust" aria-labelledby="trust-h">
            <h2 id="trust-h">Who holds what</h2>
            <ul>
              <li>
                <strong>You (the owner)</strong> keep the authority over your token accounts and are
                the only signer of every change to a mandate or policy. Your tokens never leave your
                accounts until the agent acts.
              </li>
              <li>
                <strong>The agent</strong> holds a key with fee SOL only. It can ask the relay to
                pay or swap within the mandate. A raw SPL transfer, approve or set-authority signed
                by the agent fails in the Token program (OwnerMismatch).
              </li>
              <li>
                <strong>The relay</strong> has no keys. Its PDA is the SPL delegate. It builds only{' '}
                <code>TransferChecked</code> and the pinned swap: there is no code path that
                approves, revokes or changes authorities.
              </li>
              <li>
                <strong>The Token program</strong> enforces the delegated amount as a hard cap,
                independently of the relay and the core program.
              </li>
            </ul>
          </section>

          <section id="blast" aria-labelledby="blast-h">
            <h2 id="blast-h">Blast radius</h2>
            <p>
              If the agent key is stolen or the agent is fooled by injected text, the most it can
              move is the smaller of the remaining SPL allowance and the remaining lifetime budget
              of the permission it uses, in raw units of one mint, and only to allowlisted
              recipients (or swapped at or above the floor into your own account). Per call it is
              bounded by the per-call cap. If you chose &quot;unlimited&quot; for the budget, only
              the allowance bounds it.
            </p>
            <p>
              This caps the damage on chain. It does <strong>not</strong> stop an agent from being
              fooled, and the agent can still move money to allowlisted payees up to the budget.
            </p>
          </section>

          <section id="limits" aria-labelledby="limits-h">
            <h2 id="limits-h">Limits and honest caveats</h2>
            <ul>
              <li>
                Unaudited prototype on devnet. Do not put funds behind it that you cannot lose.
                There is no mainnet deployment and this dashboard refuses mainnet.
              </li>
              <li>
                The per-call limit is per <code>verify</code> call, not per Solana transaction:
                several relay instructions in one transaction are each checked separately, and the
                lifetime budget bounds the total. There are no daily or rolling windows.
              </li>
              <li>
                Spend counters are unit-less and per target program. Budgets are raw units of one
                mint; there is no USD value. Use one mandate per asset.
              </li>
              <li>
                A token account can have only one SPL delegate, so one active mandate per source
                token account. Approving the relay replaces any existing delegate.
              </li>
              <li>
                Recipients are token accounts, not wallets. Whoever controls an allowlisted
                account&apos;s owner field can redirect future payments.
              </li>
              <li>
                The swap floor is a static price chosen at creation. It is not MEV protection: a
                swap that lands inside the floor can still lose up to the gap between the floor and
                the pool price. A stale floor makes swaps fail or become loose.
              </li>
              <li>
                Only extension-free classic SPL Token mints are supported for hard enforcement. The
                native (wrapped SOL) mint is refused.
              </li>
              <li>
                Pre-flight checks in the SDK mirror the programs&apos; check order for the state
                they are given; they are not a guarantee. The cluster decides.
              </li>
              <li>
                Registry risk classes are judgement from cited sources, not facts of the programs.
                Unknown instructions are unknown, not safe.
              </li>
              <li>
                Dev signer: a throwaway browser key or a server-held demo key, available only on
                localnet and devnet and only when explicitly enabled. It is never a substitute for a
                wallet and cannot be enabled on mainnet.
              </li>
              <li>
                The &quot;Try to break it&quot; attacker is a fixed script signed by a demo key. It
                is labelled scripted everywhere and does not show that an AI agent can be stopped
                from being fooled.
              </li>
            </ul>
          </section>

          <section id="reading" aria-labelledby="reading-h">
            <h2 id="reading-h">Reading this dashboard</h2>
            <ul>
              <li>
                <strong>blocked</strong> in the activity feed means a transaction landed on chain
                and failed. The reason shown is decoded from the failing program&apos;s logs, with
                the program named, because custom error numbers overlap between programs.
              </li>
              <li>
                A wallet that simulates first would normally refuse to send a failing transaction,
                so blocked rows come mostly from scripted attacks and from agents that skip
                preflight. Silence in the feed does not prove nothing was attempted.
              </li>
              <li>
                The capacity figure is an upper bound read at one moment. An off-chain read cannot
                reserve budget.
              </li>
              <li>
                Pausing the <em>relay</em> stops payments and swaps. Pausing the{' '}
                <em>whole mandate</em> also stops every other program&apos;s <code>verify</code>{' '}
                check. Neither revokes anything.
              </li>
              <li>
                Revoking one instruction keeps the other instructions and the remaining budget.
                Unwinding ends everything, in one transaction, and does not undo past transfers.
              </li>
            </ul>
            <p>
              See also the <Link href="/registry">verified registry</Link> and the{' '}
              <Link href="/simulator">simulator</Link>.
            </p>
          </section>
        </article>
      </div>
    </main>
  )
}
