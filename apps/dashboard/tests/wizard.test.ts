import {
  buildOnboardingInput,
  EMPTY_FORM,
  presetShape,
  type TokenAccountInfo,
  type WizardContext,
  type WizardForm,
} from '@/lib/wizard'
import type { PresetData } from '@/lib/registry-data'
import { AGENT, MINT, OWNER, RECIPIENT, SOURCE } from './fixtures'

const NOW = 1_800_000_000

const payments: PresetData = {
  name: 'payments-usdc',
  title: 'USDC payments',
  description: '',
  audience: '',
  riskSummary: '',
  requiresRelay: true,
  warnings: [],
  honestLimits: [],
  blocked: [],
  permissions: [
    {
      slug: 'spl-token',
      programName: 'SPL Token',
      programIds: { devnet: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      instructions: [
        {
          name: 'transfer_checked',
          title: 'Transfer (checked)',
          disc8: '0c00000000000000',
          risk: 'value_out',
        },
      ],
    },
  ],
}
const treasury: PresetData = {
  ...payments,
  name: 'treasury-ops',
  permissions: [
    ...payments.permissions,
    {
      slug: 'memo',
      programName: 'Memo',
      programIds: { devnet: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' },
      instructions: [{ name: 'memo', title: 'Memo', disc8: '0000000000000000', risk: 'read_only' }],
    },
  ],
}
const readOnly: PresetData = { ...payments, name: 'read-only-observer', requiresRelay: false }

const source: TokenAccountInfo = {
  address: SOURCE,
  mint: MINT,
  decimals: 6,
  amount: 100_000_000n,
  delegate: null,
  delegatedAmount: 0n,
}

function ctx(over: Partial<WizardContext> = {}): WizardContext {
  return {
    owner: OWNER,
    presets: [payments, treasury, readOnly],
    source,
    swapPool: null,
    mockAmm: AGENT,
    ownerTokenAccounts: [source],
    now: NOW,
    ...over,
  }
}

function form(over: Partial<WizardForm> = {}): WizardForm {
  return {
    ...EMPTY_FORM,
    agent: AGENT,
    sourceAccount: SOURCE,
    perCall: '5',
    totalBudget: '20',
    delegation: '20',
    expiry: '24h',
    recipients: [{ address: RECIPIENT, label: 'Alice' }],
    ...over,
  }
}

function errorsOf(f: WizardForm, c: WizardContext = ctx()): Record<string, string> {
  const r = buildOnboardingInput(f, c)
  if (r.ok) throw new Error('expected validation errors')
  return { ...r.errors }
}

describe('wizard validation', () => {
  it('builds SDK onboarding input in raw units from human units', () => {
    const r = buildOnboardingInput(form(), ctx())
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.input.agent).toBe(AGENT)
    expect(r.input.expiry).toBe(BigInt(NOW) + 86_400n)
    expect(r.input.token).toEqual({ mint: MINT, source: SOURCE, delegateCap: 20_000_000n })
    expect(r.input.permissions).toEqual([
      expect.objectContaining({
        spendLimit: 20_000_000n,
        perTxLimit: 5_000_000n,
        discriminators: ['0c00000000000000'],
      }),
    ])
    expect(r.input.recipients).toEqual([RECIPIENT])
    expect(r.input.fundAgentLamports).toBe(10_000_000n)
    expect(r.labels).toEqual({ [RECIPIENT]: 'Alice' })
    expect(r.input.allowUnlimited).toBe(false)
  })

  it('requires a valid agent that is not the owner', () => {
    expect(errorsOf(form({ agent: '' }))['agent']).toMatch(/Paste the agent/)
    expect(errorsOf(form({ agent: 'not-an-address' }))['agent']).toMatch(/valid Solana address/)
    expect(errorsOf(form({ agent: OWNER }))['agent']).toMatch(/different key/)
  })

  it('rejects empty, malformed, zero and over-precise amounts', () => {
    expect(errorsOf(form({ perCall: '' }))['perCall']).toBe('Required.')
    expect(errorsOf(form({ perCall: '1e3' }))['perCall']).toMatch(/plain number/)
    expect(errorsOf(form({ perCall: '1.1234567' }))['perCall']).toMatch(/at most 6 decimals/)
    expect(errorsOf(form({ totalBudget: '0' }))['totalBudget']).toMatch(/greater than zero/)
  })

  it('never turns a typed 0 into unlimited', () => {
    const r = buildOnboardingInput(form({ perCall: '0' }), ctx())
    expect(r.ok).toBe(false)
  })

  it('needs an explicit tick for unlimited and forwards allowUnlimited', () => {
    const r = buildOnboardingInput(
      form({ totalUnlimited: true, perCall: '5', totalBudget: '' }),
      ctx(),
    )
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.input.permissions[0]?.spendLimit).toBe('unlimited')
    expect(r.input.allowUnlimited).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/unlimited/)
  })

  it('refuses a per-call cap above the total budget and a delegation above the budget', () => {
    expect(errorsOf(form({ perCall: '30' }))['perCall']).toMatch(/above the total budget/)
    expect(errorsOf(form({ delegation: '25' }))['delegation']).toMatch(/above the total budget/)
  })

  it('warns when the delegation is a large share of the balance', () => {
    const r = buildOnboardingInput(
      form({ totalBudget: '60', delegation: '60', perCall: '5' }),
      ctx(),
    )
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.warnings.join(' ')).toMatch(/at least half/)
  })

  it('validates the expiry', () => {
    expect(errorsOf(form({ expiry: 'soon' }))['expiry']).toMatch(/duration/)
    expect(errorsOf(form({ expiry: '400d' }))['expiry']).toMatch(/one year/)
  })

  it('validates recipients: at least one, valid, unique, at most eight', () => {
    expect(errorsOf(form({ recipients: [{ address: '', label: '' }] }))['recipients']).toMatch(
      /at least one/,
    )
    expect(errorsOf(form({ recipients: [{ address: 'xyz', label: '' }] }))['recipient-0']).toMatch(
      /valid token account/,
    )
    expect(
      errorsOf(
        form({
          recipients: [
            { address: RECIPIENT, label: '' },
            { address: RECIPIENT, label: '' },
          ],
        }),
      )['recipient-1'],
    ).toBe('Duplicate.')
    const nine = Array.from({ length: 9 }, () => ({ address: RECIPIENT, label: '' }))
    expect(errorsOf(form({ recipients: nine }))['recipients']).toMatch(/At most 8/)
  })

  it('caps the fee funding at one SOL', () => {
    expect(errorsOf(form({ fundSol: '2' }))['fundSol']).toMatch(/At most 1 SOL/)
    expect(errorsOf(form({ fundSol: 'abc' }))['fundSol']).toMatch(/plain number/)
  })

  it('requires a source account', () => {
    expect(errorsOf(form(), ctx({ source: null }))['sourceAccount']).toMatch(
      /Pick the token account/,
    )
  })

  it('makes replacing an existing SPL delegate an explicit choice', () => {
    const delegated = { ...source, delegate: RECIPIENT, delegatedAmount: 5n }
    expect(errorsOf(form(), ctx({ source: delegated }))['replaceDelegate']).toMatch(
      /already delegates/,
    )
    const ok = buildOnboardingInput(form({ replaceDelegate: true }), ctx({ source: delegated }))
    if (!ok.ok) throw new Error(JSON.stringify(ok.errors))
    expect(ok.input.allowReplaceDelegate).toBe(true)
    expect(ok.warnings.join(' ')).toMatch(/replacing the existing SPL delegate/)
  })

  it('adds advisory slots with a nominal limit for the non-relay parts of a preset', () => {
    const r = buildOnboardingInput(form({ presetName: 'treasury-ops' }), ctx())
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.input.permissions).toHaveLength(2)
    expect(r.input.permissions[1]).toEqual(
      expect.objectContaining({
        spendLimit: 1n,
        perTxLimit: 1n,
        discriminators: ['0000000000000000'],
      }),
    )
  })

  it('asks for a pool when the preset swaps', () => {
    const dex: PresetData = {
      ...payments,
      name: 'dex-trader-single-pool',
      permissions: [
        {
          slug: 'raydium-cpmm',
          programName: 'Raydium CPMM',
          programIds: { devnet: 'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW' },
          instructions: [
            {
              name: 'swap_base_input',
              title: 'Swap',
              disc8: '8fbe5adac41e33de',
              risk: 'value_swap',
            },
          ],
        },
      ],
    }
    const errors = errorsOf(form({ presetName: dex.name }), ctx({ presets: [dex] }))
    expect(errors['pool']).toBeDefined()
    expect(errors['swapOutAccount']).toBeDefined()
  })
})

describe('presetShape', () => {
  it('separates the relay slots from the advisory extras', () => {
    expect(presetShape(payments)).toMatchObject({ transfer: true, swap: false, extras: [] })
    expect(presetShape(treasury).extras.map((e) => e.slug)).toEqual(['memo'])
  })
})
