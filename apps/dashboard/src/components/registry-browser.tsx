'use client'

import { useMemo, useState } from 'react'
import { errorFromCode, type TableProgram } from '@agentauth-sol/sdk'
import { isAddress } from '@solana/kit'
import type { RegistryData } from '@/lib/registry-data'
import { AddressText } from './address'
import { RiskBadge } from './risk'
import { Button, Card, Chip, ErrorBox, Field, inputClass } from './ui'

const RISKS = [
  'read_only',
  'value_out',
  'value_swap',
  'position_mgmt',
  'authority_change',
  'account_close',
  'admin',
  'other',
]

interface DecodeResponse {
  known: boolean
  program: { slug: string; name: string; programId: string } | null
  instruction: {
    name: string
    title: string
    risk: string
    defaultDeny: boolean
    rationale: string
  } | null
  disc8: string | null
  risk: string
  defaultDeny: boolean
  amount: string | null
  error?: string
}

function DecoderBox({ data }: { data: RegistryData }) {
  const [programId, setProgramId] = useState(
    data.programs.find((p) => p.slug === 'spl-token')?.ids['mainnet-beta'] ?? '',
  )
  const [hex, setHex] = useState('0c40420f000000000006')
  const [result, setResult] = useState<DecodeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const decode = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/registry/decode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ programId, data: hex }),
      })
      const json = (await res.json()) as DecodeResponse
      if (!res.ok) setError(json.error ?? 'The decoder refused that input.')
      else setResult(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card as="section" aria-labelledby="decoder-heading">
      <h2 id="decoder-heading" className="text-lg font-semibold">
        Instruction decoder
      </h2>
      <p className="mt-1 text-sm text-muted">
        Paste a program id and the raw instruction data (hex). The registry names it, gives the
        canonical 8-byte discriminator a mandate needs, its risk class and the amount it carries.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field
          label="Program id"
          htmlFor="dec-program"
          error={programId && !isAddress(programId) ? 'Not a valid address.' : null}
        >
          <input
            id="dec-program"
            className={`${inputClass} font-mono`}
            value={programId}
            onChange={(e) => setProgramId(e.target.value.trim())}
            spellCheck={false}
          />
        </Field>
        <Field label="Instruction data (hex)" htmlFor="dec-data">
          <input
            id="dec-data"
            className={`${inputClass} font-mono`}
            value={hex}
            onChange={(e) => setHex(e.target.value.trim())}
            spellCheck={false}
          />
        </Field>
        <Button
          variant="primary"
          onClick={() => void decode()}
          disabled={busy || !isAddress(programId) || hex === ''}
          data-testid="decode-button"
        >
          {busy ? 'Decoding...' : 'Decode'}
        </Button>
      </div>
      {error ? (
        <div className="mt-4">
          <ErrorBox error={{ title: 'Cannot decode', detail: error }} />
        </div>
      ) : null}
      {result ? (
        <div
          className="mt-4 rounded-lg border border-line bg-surface-2 p-4 text-sm"
          data-testid="decode-result"
        >
          {result.known && result.instruction ? (
            <>
              <p className="font-semibold">
                {result.program?.name}: {result.instruction.title}{' '}
                <span className="font-mono text-xs font-normal">({result.instruction.name})</span>
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-2">
                <RiskBadge risk={result.risk} />
                {result.defaultDeny ? <Chip tone="bad">default-deny</Chip> : null}
                <span>
                  disc8 <span className="font-mono">{result.disc8}</span>
                </span>
                {result.amount !== null ? (
                  <span>
                    amount <span className="font-mono">{result.amount}</span> raw units
                  </span>
                ) : null}
              </p>
              <p className="mt-2 text-muted">{result.instruction.rationale}</p>
            </>
          ) : (
            <p>
              <Chip tone="warn">unknown</Chip> This program or instruction is not in the verified
              registry. A cautious integrator denies anything unknown.
              {result.disc8 ? (
                <>
                  {' '}
                  Computed disc8 <span className="font-mono">{result.disc8}</span>.
                </>
              ) : null}
            </p>
          )}
        </div>
      ) : null}
    </Card>
  )
}

const ERROR_PROGRAMS: TableProgram[] = ['agent_auth', 'relay', 'token', 'system', 'mock_amm']

function ErrorDecoder() {
  const [program, setProgram] = useState<TableProgram>('relay')
  const [code, setCode] = useState('104')
  const decoded = useMemo(() => {
    const n = Number(code)
    if (!Number.isInteger(n) || n < 0) return null
    try {
      return errorFromCode(program, n)
    } catch {
      return null
    }
  }, [program, code])
  return (
    <Card as="section" aria-labelledby="error-heading">
      <h2 id="error-heading" className="text-lg font-semibold">
        Error code decoder
      </h2>
      <p className="mt-1 text-sm text-muted">
        Custom error numbers overlap between programs, so say which program raised it (the failing
        program id in the transaction logs).
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Program" htmlFor="err-program">
          <select
            id="err-program"
            className={inputClass}
            value={program}
            onChange={(e) => setProgram(e.target.value as TableProgram)}
          >
            {ERROR_PROGRAMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Custom error code" htmlFor="err-code">
          <input
            id="err-code"
            inputMode="numeric"
            className={inputClass}
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
        </Field>
      </div>
      <div className="mt-4 text-sm" data-testid="error-decode-result" aria-live="polite">
        {decoded ? (
          <>
            <p className="font-semibold">
              {decoded.program}: {decoded.name}{' '}
              <span className="font-mono text-xs font-normal">(code {decoded.code})</span>
            </p>
            <p className="mt-1">{decoded.message}</p>
            <p className="mt-1 text-muted">
              <span className="font-medium text-ink">What to do: </span>
              {decoded.hint}
            </p>
          </>
        ) : (
          <p className="text-muted">No such code in that program&apos;s table.</p>
        )}
      </div>
    </Card>
  )
}

export function RegistryBrowser({ data }: { data: RegistryData }) {
  const [query, setQuery] = useState('')
  const [risk, setRisk] = useState('')
  const [slug, setSlug] = useState(data.programs[0]?.slug ?? '')
  const program = data.programs.find((p) => p.slug === slug)
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (program?.instructions ?? []).filter(
      (i) =>
        (risk === '' || i.risk === risk) &&
        (q === '' ||
          i.name.includes(q) ||
          i.title.toLowerCase().includes(q) ||
          i.disc8.includes(q)),
    )
  }, [program, query, risk])
  const total = data.programs.reduce((n, p) => n + p.instructions.length, 0)
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted" data-testid="registry-count">
        {data.programs.length} programs and {total} instructions, each with a canonical 8-byte
        discriminator, a risk class and the sources it was checked against. Risk calls are judgement
        from those sources, not facts of the programs: treat them as conservative defaults.
        Instructions the registry does not list are unknown, not safe.
      </p>
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Programs" className="space-y-1">
          {data.programs.map((p) => (
            <button
              key={p.slug}
              type="button"
              onClick={() => setSlug(p.slug)}
              aria-current={p.slug === slug ? 'true' : undefined}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 ${p.slug === slug ? 'bg-surface-2 font-semibold' : ''}`}
            >
              <span>{p.name}</span>
              <span className="text-xs text-muted">{p.instructions.length}</span>
            </button>
          ))}
        </nav>
        {program ? (
          <section aria-labelledby="program-heading" className="min-w-0 space-y-4">
            <div>
              <h2 id="program-heading" className="text-lg font-semibold">
                {program.name}
              </h2>
              <ul className="mt-1 space-y-1 text-sm">
                {Object.entries(program.ids).map(([cluster, id]) => (
                  <li key={cluster} className="flex flex-wrap items-center gap-2">
                    <span className="w-24 text-muted">{cluster}</span>
                    {id ? <AddressText value={id} link /> : null}
                  </li>
                ))}
              </ul>
              {program.checkedAt ? (
                <p className="mt-1 text-xs text-muted">Checked {program.checkedAt}</p>
              ) : null}
              {program.sources && program.sources.length > 0 ? (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-muted">
                    Sources ({program.sources.length})
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {program.sources.map((s) => (
                      <li key={s.url}>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline"
                        >
                          {s.kind} {s.ref}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Search name, title or discriminator" htmlFor="reg-search">
                <input
                  id="reg-search"
                  className={inputClass}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
              <Field label="Risk class" htmlFor="reg-risk">
                <select
                  id="reg-risk"
                  className={inputClass}
                  value={risk}
                  onChange={(e) => setRisk(e.target.value)}
                >
                  <option value="">All</option>
                  {RISKS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="text-xs text-muted" role="status">
              {rows.length} of {program.instructions.length} instructions
            </p>
            <ul
              className="divide-y divide-line rounded-lg border border-line bg-surface"
              aria-label={`${program.name} instructions`}
            >
              {rows.map((i) => (
                <li key={i.disc8 + i.name} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i.title}</span>
                    <span className="font-mono text-xs text-muted">{i.name}</span>
                    <RiskBadge risk={i.risk} />
                    {i.defaultDeny ? <Chip tone="bad">default-deny</Chip> : null}
                    <span className="ml-auto font-mono text-xs">{i.disc8}</span>
                  </div>
                  {i.rationale ? <p className="text-sm text-muted">{i.rationale}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <DecoderBox data={data} />
      <ErrorDecoder />
    </div>
  )
}
