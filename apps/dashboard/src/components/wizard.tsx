'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { PlanRefusedError, mandatePda, toJsonSafe, type Plan } from '@agentauth-sol/sdk'
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  address as toAddress,
  type Address,
} from '@solana/kit'
import { useChain, useClient } from '@/lib/chain'
import { resolveCpmmPool } from '@/lib/cpmm'
import { useConfig } from '@/lib/config-context'
import { formatAmount, shortAddress } from '@/lib/format'
import { fetchDemoInfo, loadOwnerTokenAccounts, saveLabels } from '@/lib/owner-data'
import { explainWizardInput } from '@/lib/preview'
import { toDisplayError, useTxRunner } from '@/lib/tx-runner'
import { useAsync } from '@/lib/use-async'
import { useDebounced } from '@/lib/use-debounced'
import type { ConnectedWallet } from '@/lib/wallet/types'
import {
  EMPTY_FORM,
  buildOnboardingInput,
  presetShape,
  type SwapPoolInfo,
  type TokenAccountInfo,
  type WizardForm,
} from '@/lib/wizard'
import { AddressText } from './address'
import { useNowSeconds } from './mandate-card'
import { ExplainPreview } from './explain'
import { PermissionTable } from './permission-table'
import { PlanPreview } from './plan-preview'
import { TxProgress } from './tx-progress'
import { Button, Card, Chip, ErrorBox, Field, Notice, Skeleton, inputClass } from './ui'

const EXPIRY_QUICK = ['1h', '24h', '7d', '30d']
const NO_ACCOUNTS: readonly TokenAccountInfo[] = []

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card as="section" aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`} className="mb-4 flex items-center gap-2 text-base font-semibold">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-accent text-xs text-accent-ink"
        >
          {n}
        </span>
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </Card>
  )
}

/** A demo agent: a fresh key whose secret exists only in this tab until the user downloads it. */
function AgentPicker({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (v: string) => void
  error?: string
}) {
  const [secret, setSecret] = useState<Uint8Array | null>(null)
  const [busy, setBusy] = useState(false)
  const generate = async () => {
    setBusy(true)
    try {
      const seed = crypto.getRandomValues(new Uint8Array(32))
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true)
      const keypair = new Uint8Array(64)
      keypair.set(seed)
      keypair.set(getAddressEncoder().encode(signer.address), 32)
      setSecret(keypair)
      onChange(signer.address)
    } finally {
      setBusy(false)
    }
  }
  const download = () => {
    if (!secret) return
    const blob = new Blob([JSON.stringify(Array.from(secret))], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `demo-agent-${shortAddress(value, 4, 4)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="space-y-3">
      <Field
        label="Agent public key"
        htmlFor="agent"
        hint="The key your agent signs with. It never needs token authority: the relay does the spending."
        error={error ?? null}
      >
        <input
          id="agent"
          className={`${inputClass} font-mono`}
          value={value}
          onChange={(e) => {
            setSecret(null)
            onChange(e.target.value)
          }}
          placeholder="Paste a Solana address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby="agent-hint"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void generate()} disabled={busy}>
          Generate a demo agent
        </Button>
        {secret ? <Button onClick={download}>Download its keypair file</Button> : null}
      </div>
      {secret ? (
        <p className="text-xs text-muted">
          This key exists only in this tab. Download it if you want to run an agent with it; it is a
          Solana CLI keypair file, so keep it out of git. It holds no funds and no token authority.
        </p>
      ) : null}
    </div>
  )
}

export function Wizard({ wallet }: { wallet: ConnectedWallet }) {
  const client = useClient()
  const { registryData } = useChain()
  const config = useConfig()
  const owner = wallet.address

  const wizardPresets = registryData.presets
  const [form, setForm] = useState<WizardForm>({
    ...EMPTY_FORM,
    presetName:
      wizardPresets.find((p) => p.name === EMPTY_FORM.presetName && p.requiresRelay)?.name ??
      wizardPresets.find((p) => p.requiresRelay)?.name ??
      EMPTY_FORM.presetName,
  })
  const [delegationTouched, setDelegationTouched] = useState(false)
  const [cpmmAddress, setCpmmAddress] = useState('')
  const set = useCallback(<K extends keyof WizardForm>(key: K, value: WizardForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }, [])

  const accounts = useAsync((signal) => loadOwnerTokenAccounts(client, owner, signal), [owner])
  const demo = useAsync((signal) => fetchDemoInfo(signal), [config.cluster], {
    enabled: config.cluster === 'localnet',
  })

  const preset = wizardPresets.find((p) => p.name === form.presetName)
  const shape = preset ? presetShape(preset) : { transfer: false, swap: false, extras: [] }
  const source: TokenAccountInfo | null =
    accounts.data?.find((a) => a.address === form.sourceAccount) ?? null

  // Pinned pool: the mock pool on a local validator, a pasted Raydium CPMM pool on devnet.
  const cpmm = useAsync(
    (signal) => {
      void signal
      return resolveCpmmPool(client, toAddress(cpmmAddress.trim()), source?.mint as Address)
    },
    [cpmmAddress, source?.mint],
    {
      enabled:
        shape.swap &&
        config.cluster === 'devnet' &&
        cpmmAddress.trim().length >= 32 &&
        source !== null,
    },
  )
  const mockPool: SwapPoolInfo | null = (() => {
    const d = demo.data
    if (
      !shape.swap ||
      config.cluster !== 'localnet' ||
      !d?.available ||
      !d.pool ||
      !d.mints ||
      !source
    )
      return null
    if (source.mint !== d.mints.dusd.address) return null
    return {
      kind: 'mock',
      label: 'Mock AMM demo pool (localnet only)',
      ammProgram: client.programIds.mockAmm,
      ammAuthority: d.pool.authority,
      ammConfig: d.pool.config,
      poolState: d.pool.state,
      inputVault: d.pool.vaultDusd,
      outputVault: d.pool.vaultDout,
      observationState: d.pool.observation,
      inMint: d.mints.dusd.address,
      outMint: d.mints.dout.address,
      inTokenProgram: client.programIds.token,
      outTokenProgram: client.programIds.token,
      outDecimals: d.mints.dout.decimals,
    }
  })()
  const swapPool = config.cluster === 'localnet' ? mockPool : (cpmm.data ?? null)

  const nowSeconds = useNowSeconds(30_000)
  const ownerAccounts = accounts.data ?? NO_ACCOUNTS
  const built = buildOnboardingInput(form, {
    owner,
    presets: wizardPresets,
    source,
    swapPool,
    mockAmm: client.programIds.mockAmm,
    ownerTokenAccounts: ownerAccounts,
    now: nowSeconds,
  })
  const key = useDebounced(built.ok ? JSON.stringify(toJsonSafe(built.input)) : 'invalid', 350)

  const preview = useAsync(
    async () => {
      if (!built.ok || !source) return null
      const plan = await client.plan.onboarding(built.input)
      const hypothetical = await explainWizardInput(
        client,
        built.input,
        built.swapConfig,
        source.decimals,
        Math.floor(Date.now() / 1000),
      )
      return { plan, ...hypothetical }
    },
    [key],
    { enabled: built.ok },
  )

  const runner = useTxRunner(client, wallet.signer)
  const [createdAddress, setCreatedAddress] = useState<Address | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const sign = async () => {
    if (!built.ok || !preview.data) return
    setSubmitted(true)
    const ok = await runner.run(preview.data.plan as Plan)
    if (ok) {
      saveLabels(built.labels)
      const { address } = await mandatePda(owner, built.input.agent, client.programIds.agentAuth)
      setCreatedAddress(address)
    }
  }

  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(new Set())
  const touch = (field: string) => setTouchedFields((s) => new Set(s).add(field))
  const errors: Readonly<Record<string, string>> = built.ok ? {} : built.errors
  const showErrors = (field: string) =>
    submitted || touchedFields.has(field) ? errors[field] : undefined

  const planError = preview.error
  const planReasons = planError instanceof PlanRefusedError ? planError.reasons : null

  if (createdAddress) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Mandate created</h2>
        <p className="mt-2 text-sm text-muted">
          Both transactions are confirmed on {config.cluster}.
        </p>
        <div className="mt-4">
          <TxProgress steps={runner.steps} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={`/mandates/${createdAddress}`}
            className="inline-flex min-h-10 items-center rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-ink no-underline"
            data-testid="open-created"
          >
            Open the mandate
          </Link>
          <Link
            href="/mandates"
            className="inline-flex min-h-10 items-center px-2 text-sm underline"
          >
            All mandates
          </Link>
        </div>
      </Card>
    )
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault()
          void sign()
        }}
        noValidate
      >
        <Section n={1} title="Pick the agent">
          <AgentPicker
            value={form.agent}
            onChange={(v) => set('agent', v)}
            {...(showErrors('agent') ? { error: showErrors('agent') as string } : {})}
          />
        </Section>

        <Section n={2} title="Pick a preset">
          <fieldset>
            <legend className="sr-only">Preset</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {wizardPresets.map((p) => {
                const supported = p.requiresRelay
                return (
                  <label
                    key={p.name}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${form.presetName === p.name ? 'border-accent bg-surface-2' : 'border-line'} ${supported ? '' : 'cursor-not-allowed opacity-60'}`}
                  >
                    <input
                      type="radio"
                      name="preset"
                      value={p.name}
                      checked={form.presetName === p.name}
                      disabled={!supported}
                      onChange={() => set('presetName', p.name)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{p.title}</span>
                      <span className="block text-xs text-muted">{p.description}</span>
                      {!supported ? (
                        <span className="mt-1 block text-xs text-warn">
                          No relay policy: advisory only, so this wizard does not build it. Use the
                          CLI.
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          {preset && preset.warnings.length > 0 ? (
            <Notice tone="warn" title="Notes from the registry">
              <ul className="list-disc space-y-1 pl-5">
                {preset.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </Section>

        <Section n={3} title="Limits, in human units">
          {accounts.loading ? (
            <Skeleton className="h-10 w-full" />
          ) : accounts.error !== undefined && !accounts.data ? (
            <ErrorBox
              error={toDisplayError(accounts.error)}
              title="Could not read your token accounts"
            />
          ) : (accounts.data?.length ?? 0) === 0 ? (
            <Notice tone="warn" title="You have no SPL token accounts on this cluster">
              A mandate spends from one of your token accounts. Create one and fund it first, then
              come back.
            </Notice>
          ) : (
            <Field
              label="Token account the agent may spend from"
              htmlFor="source"
              error={showErrors('sourceAccount') ?? null}
            >
              <select
                id="source"
                className={inputClass}
                value={form.sourceAccount}
                onChange={(e) => {
                  set('sourceAccount', e.target.value)
                  touch('sourceAccount')
                }}
                aria-invalid={showErrors('sourceAccount') ? true : undefined}
              >
                <option value="">Choose an account</option>
                {accounts.data?.map((a) => (
                  <option key={a.address} value={a.address}>
                    {shortAddress(a.address)} - mint {shortAddress(a.mint)} -{' '}
                    {formatAmount(a.amount, a.decimals)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {source && source.delegate !== null && source.delegatedAmount > 0n ? (
            <Notice tone="warn" title="This account already has an SPL delegate">
              <p>
                It currently lets <AddressText value={source.delegate} /> move up to{' '}
                {formatAmount(source.delegatedAmount, source.decimals)}. A token account has only
                one delegate, so approving the relay replaces it, and whatever relied on it stops
                working.
              </p>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={form.replaceDelegate}
                  onChange={(e) => set('replaceDelegate', e.target.checked)}
                  className="mt-1"
                />
                <span>Replace the existing delegate</span>
              </label>
            </Notice>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Field
                label={
                  shape.swap && !shape.transfer ? 'Cap per swap (input amount)' : 'Cap per call'
                }
                htmlFor="perCall"
                hint="The most one relay call may move."
                error={showErrors('perCall') ?? null}
              >
                <input
                  id="perCall"
                  inputMode="decimal"
                  className={inputClass}
                  value={form.perCallUnlimited ? 'unlimited' : form.perCall}
                  disabled={form.perCallUnlimited}
                  onChange={(e) => set('perCall', e.target.value)}
                  onBlur={() => touch('perCall')}
                  aria-invalid={showErrors('perCall') ? true : undefined}
                />
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.perCallUnlimited}
                  onChange={(e) => set('perCallUnlimited', e.target.checked)}
                />
                Unlimited per call (not recommended)
              </label>
            </div>
            <div className="space-y-2">
              <Field
                label="Total budget"
                htmlFor="totalBudget"
                hint="Lifetime cap across all calls."
                error={showErrors('totalBudget') ?? null}
              >
                <input
                  id="totalBudget"
                  inputMode="decimal"
                  className={inputClass}
                  value={form.totalUnlimited ? 'unlimited' : form.totalBudget}
                  disabled={form.totalUnlimited}
                  onChange={(e) => {
                    const v = e.target.value
                    // The delegation follows the budget until the user types their own.
                    setForm((f) => ({
                      ...f,
                      totalBudget: v,
                      ...(delegationTouched ? {} : { delegation: v }),
                    }))
                  }}
                  onBlur={() => touch('totalBudget')}
                  aria-invalid={showErrors('totalBudget') ? true : undefined}
                />
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.totalUnlimited}
                  onChange={(e) => set('totalUnlimited', e.target.checked)}
                />
                Unlimited total (not recommended)
              </label>
            </div>
            <Field
              label="Delegation size"
              htmlFor="delegation"
              hint="The SPL allowance you hand the relay. The Token program enforces it as a hard cap, independent of the mandate."
              error={showErrors('delegation') ?? null}
            >
              <input
                id="delegation"
                inputMode="decimal"
                className={inputClass}
                value={form.delegation}
                onChange={(e) => {
                  setDelegationTouched(true)
                  set('delegation', e.target.value)
                }}
                onBlur={() => touch('delegation')}
                aria-invalid={showErrors('delegation') ? true : undefined}
              />
            </Field>
            <div className="space-y-2">
              <Field
                label="Lasts for"
                htmlFor="expiry"
                hint="For example 1h, 24h, 7d. At most one year."
                error={showErrors('expiry') ?? null}
              >
                <input
                  id="expiry"
                  className={inputClass}
                  value={form.expiry}
                  onChange={(e) => set('expiry', e.target.value)}
                  onBlur={() => touch('expiry')}
                  aria-invalid={showErrors('expiry') ? true : undefined}
                />
              </Field>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Quick expiry">
                {EXPIRY_QUICK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => set('expiry', q)}
                    className="rounded-full border border-line-strong px-3 py-1 text-xs hover:bg-surface-2"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <Field
              label="Fee SOL for the agent"
              htmlFor="fundSol"
              hint="Sent to the agent so it can pay transaction fees. Leave empty to send none."
              error={showErrors('fundSol') ?? null}
            >
              <input
                id="fundSol"
                inputMode="decimal"
                className={inputClass}
                value={form.fundSol}
                onChange={(e) => set('fundSol', e.target.value)}
                aria-invalid={showErrors('fundSol') ? true : undefined}
              />
            </Field>
          </div>
        </Section>

        {shape.transfer ? (
          <Section n={4} title="Who may be paid">
            <p className="text-sm text-muted">
              Token accounts, not wallets. The relay refuses any other destination (error 104).
              Whoever controls an allowed account&apos;s owner field could redirect future payments,
              so list accounts you control or trust.
            </p>
            {form.recipients.map((row, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                <Field
                  label={`Recipient ${i + 1} token account`}
                  htmlFor={`recipient-${i}`}
                  error={showErrors(`recipient-${i}`) ?? null}
                >
                  <input
                    id={`recipient-${i}`}
                    className={`${inputClass} font-mono`}
                    value={row.address}
                    spellCheck={false}
                    onChange={(e) =>
                      set(
                        'recipients',
                        form.recipients.map((r, j) =>
                          j === i ? { ...r, address: e.target.value } : r,
                        ),
                      )
                    }
                    onBlur={() => touch(`recipient-${i}`)}
                    aria-invalid={showErrors(`recipient-${i}`) ? true : undefined}
                  />
                </Field>
                <Field label="Label" htmlFor={`label-${i}`}>
                  <input
                    id={`label-${i}`}
                    className={inputClass}
                    value={row.label}
                    placeholder="e.g. Alice"
                    onChange={(e) =>
                      set(
                        'recipients',
                        form.recipients.map((r, j) =>
                          j === i ? { ...r, label: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </Field>
                <Button
                  aria-label={`Remove recipient ${i + 1}`}
                  onClick={() =>
                    set(
                      'recipients',
                      form.recipients.length > 1
                        ? form.recipients.filter((_, j) => j !== i)
                        : [{ address: '', label: '' }],
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {showErrors('recipients') ? (
              <p role="alert" className="text-xs font-medium text-bad">
                {showErrors('recipients')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => set('recipients', [...form.recipients, { address: '', label: '' }])}
                disabled={form.recipients.length >= 8}
              >
                Add a recipient
              </Button>
              {demo.data?.available && demo.data.tokenAccounts?.['recipientDusd'] ? (
                <Button
                  onClick={() =>
                    set('recipients', [
                      ...form.recipients.filter((r) => r.address.trim() !== ''),
                      {
                        address: demo.data?.tokenAccounts?.['recipientDusd'] as string,
                        label: 'Alice (demo)',
                      },
                    ])
                  }
                >
                  Use the demo recipient (Alice)
                </Button>
              ) : null}
            </div>
          </Section>
        ) : null}

        {shape.swap ? (
          <Section n={shape.transfer ? 5 : 4} title="Which pool may it swap in">
            {config.cluster === 'localnet' ? (
              mockPool ? (
                <p className="text-sm">
                  <Chip tone="neutral" mark={false}>
                    mock
                  </Chip>{' '}
                  {mockPool.label}: <AddressText value={mockPool.poolState} />
                </p>
              ) : (
                <Notice tone="warn" title="The mock pool needs the demo environment">
                  Run <code>pnpm --filter @agentauth-sol/demo bootstrap</code> and pick the demo
                  DUSD account as the source.
                  {demo.data && !demo.data.available ? (
                    <> ({demo.data.reason ?? demo.data.problems.join('; ')})</>
                  ) : null}
                </Notice>
              )
            ) : (
              <>
                <Field
                  label="Raydium CPMM pool state address"
                  htmlFor="cpmm"
                  hint="Read from the chain and decoded from the pool layout; check it on the explorer before you sign. Not yet exercised against a live pool."
                  error={
                    showErrors('pool') ?? (cpmm.error ? toDisplayError(cpmm.error).detail : null)
                  }
                >
                  <input
                    id="cpmm"
                    className={`${inputClass} font-mono`}
                    value={cpmmAddress}
                    spellCheck={false}
                    onChange={(e) => setCpmmAddress(e.target.value)}
                  />
                </Field>
                {cpmm.loading ? <Skeleton className="h-6 w-48" /> : null}
                {cpmm.data ? (
                  <p className="text-sm">
                    Pinned: input {shortAddress(cpmm.data.inMint)} to output{' '}
                    {shortAddress(cpmm.data.outMint)}.
                  </p>
                ) : null}
              </>
            )}
            <Field
              label="Your token account that receives the output"
              htmlFor="swapOut"
              error={showErrors('swapOutAccount') ?? null}
            >
              <select
                id="swapOut"
                className={inputClass}
                value={form.swapOutAccount}
                onChange={(e) => {
                  set('swapOutAccount', e.target.value)
                  touch('swapOutAccount')
                }}
              >
                <option value="">Choose an account</option>
                {accounts.data
                  ?.filter((a) => !swapPool || a.mint === swapPool.outMint)
                  .map((a) => (
                    <option key={a.address} value={a.address}>
                      {shortAddress(a.address)} - mint {shortAddress(a.mint)}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Floor: at least this much out"
                htmlFor="floorOut"
                error={showErrors('floorOut') ?? null}
              >
                <input
                  id="floorOut"
                  inputMode="decimal"
                  className={inputClass}
                  value={form.floorOut}
                  onChange={(e) => set('floorOut', e.target.value)}
                />
              </Field>
              <Field
                label="per this much in"
                htmlFor="floorIn"
                error={showErrors('floorIn') ?? null}
              >
                <input
                  id="floorIn"
                  inputMode="decimal"
                  className={inputClass}
                  value={form.floorIn}
                  onChange={(e) => set('floorIn', e.target.value)}
                />
              </Field>
              <Field
                label="Deadline window (slots)"
                htmlFor="slots"
                error={showErrors('maxDeadlineSlots') ?? null}
              >
                <input
                  id="slots"
                  inputMode="numeric"
                  className={inputClass}
                  value={form.maxDeadlineSlots}
                  onChange={(e) => set('maxDeadlineSlots', e.target.value)}
                />
              </Field>
            </div>
            <p className="text-xs text-muted">
              The floor is a static price guard, not MEV protection: a swap that lands inside the
              floor can still lose up to the gap between the floor and the pool price.
            </p>
          </Section>
        ) : null}
      </form>

      <aside
        className="space-y-6 lg:sticky lg:top-6 lg:self-start"
        aria-label="Preview and signing"
      >
        <Card as="section" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="mb-4 text-base font-semibold">
            Preview
          </h2>
          {!built.ok ? (
            <div data-testid="preview-incomplete">
              <p className="text-sm text-muted">
                Complete the form to see what this mandate would allow.
              </p>
              {Object.keys(errors).length > 0 ? (
                <ul
                  className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted"
                  aria-label="Still to fix"
                >
                  {Object.entries(errors).map(([field, msg]) => (
                    <li key={field}>{msg}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : preview.loading || (preview.data === undefined && preview.error === undefined) ? (
            <div aria-busy="true" className="space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : planError ? (
            <div className="space-y-3">
              <Notice tone="bad" title="The SDK refused this plan">
                {planReasons ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {planReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  toDisplayError(planError).detail
                )}
              </Notice>
            </div>
          ) : preview.data ? (
            <div className="space-y-6">
              <ExplainPreview explanation={preview.data.explanation} hypothetical />
              <div>
                <h3 className="mb-2 text-sm font-semibold">Permissions and risk</h3>
                <PermissionTable
                  mandate={preview.data.mandate}
                  policy={preview.data.policy}
                  registry={client.registry}
                  decimalsFor={() => source?.decimals ?? null}
                />
              </div>
              <PlanPreview plan={preview.data.plan} />
              {built.warnings.length > 0 ? (
                <Notice tone="warn" title="Check before you sign">
                  <ul className="list-disc space-y-1 pl-5">
                    {built.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card as="section" aria-labelledby="sign-heading">
          <h2 id="sign-heading" className="mb-2 text-base font-semibold">
            Sign and send
          </h2>
          <p className="mb-4 text-sm text-muted">
            Two transactions: the mandate, its permissions and the token allowance first, then the
            relay policy once the first is confirmed. You approve each in your wallet.
          </p>
          <Button
            variant="primary"
            className="w-full"
            disabled={!built.ok || !preview.data || runner.running}
            onClick={() => void sign()}
            data-testid="sign-and-send"
          >
            {runner.running
              ? 'Waiting for wallet and chain...'
              : `Sign & send (${preview.data?.plan.steps.length ?? 2} transactions)`}
          </Button>
          {!built.ok && submitted ? (
            <p role="alert" className="mt-2 text-xs text-bad">
              Fix the highlighted fields first.
            </p>
          ) : null}
          <div className="mt-4">
            <TxProgress steps={runner.steps} />
          </div>
          {runner.failed ? (
            <p className="mt-3 text-xs text-muted">
              If the first transaction landed and the second failed, your mandate exists without a
              relay policy. You can retry from here: the plan is rebuilt from the chain and will not
              repeat what already landed.
            </p>
          ) : null}
        </Card>
      </aside>
    </div>
  )
}
