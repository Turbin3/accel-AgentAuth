import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/app'
import { RULES, lintPlan, planFromPreset, readPlan, summarize, type Finding } from '../src/lint'
import { harness } from './helpers'

const NOW = 1_800_000_000n
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

function lint(plan: unknown, maxExpirySeconds?: bigint): Finding[] {
  const read = readPlan(plan)
  return [
    ...read.problems,
    ...(read.plan ? lintPlan(read.plan, { nowSeconds: NOW, maxExpirySeconds }) : []),
  ]
}
const ids = (f: Finding[]): string[] => f.map((x) => x.rule)

const base = {
  owner: 'OwnerOwnerOwnerOwnerOwnerOwnerOwnerOwner111',
  agent: 'AgentAgentAgentAgentAgentAgentAgentAgent111',
  expiry: '7d',
  permissions: [
    {
      program: 'spl-token',
      instructions: ['transfer_checked'],
      spendLimit: '500',
      perTxLimit: '50',
    },
  ],
  relay: { recipients: ['Recip1'], delegate: '500' },
}

describe('lint rules', () => {
  it('passes a tight plan with no findings', () => {
    expect(lint(base)).toEqual([])
  })

  it('AA001 flags unlimited (0) limits on value-moving permissions and the delegation', () => {
    const f = lint({
      ...base,
      permissions: [{ ...base.permissions[0], spendLimit: 0, perTxLimit: 'unlimited' }],
      relay: { ...base.relay, delegate: 'unlimited' },
    })
    expect(
      f
        .filter((x) => x.rule === 'AA001')
        .map((x) => x.path)
        .sort(),
    ).toEqual(['permissions[0].perTxLimit', 'permissions[0].spendLimit', 'relay.delegate'])
  })

  it('AA002 flags a relay delegation larger than the lifetime budget', () => {
    const f = lint({ ...base, relay: { ...base.relay, delegate: '500.000001' } })
    expect(ids(f)).toEqual(['AA002'])
    expect(lint({ ...base, relay: { ...base.relay, delegate: '500' } })).toEqual([])
  })

  it('AA003 flags default-deny instructions by name and by disc8', () => {
    const f = lint({
      ...base,
      permissions: [
        {
          ...base.permissions[0],
          instructions: ['transfer_checked', 'approve', '0600000000000000'],
        },
      ],
    })
    expect(f.filter((x) => x.rule === 'AA003').map((x) => x.path)).toEqual([
      'permissions[0].instructions[1]',
      'permissions[0].instructions[2]',
    ])
  })

  it('AA004 compares the lifetime with --max-expiry and AA010 rejects past expiries', () => {
    expect(ids(lint({ ...base, expiry: '45d' }, 30n * 86_400n))).toEqual(['AA004'])
    expect(lint({ ...base, expiry: '30d' }, 30n * 86_400n)).toEqual([])
    expect(ids(lint({ ...base, expiry: 1_000_000_000 }))).toEqual(['AA010'])
    expect(ids(lint({ ...base, expiry: 'whenever' }))).toEqual(['AA010'])
  })

  it('AA005 flags payments with no recipient allowlist (relay empty or absent)', () => {
    expect(ids(lint({ ...base, relay: { recipients: [], delegate: '500' } }))).toEqual(['AA005'])
    const noRelay = lint({ ...base, relay: null })
    expect(ids(noRelay)).toContain('AA005')
    expect(ids(noRelay)).toContain('AA011')
  })

  it('AA006 flags a permission shared by several mints', () => {
    const f = lint({
      ...base,
      permissions: [{ ...base.permissions[0], mints: ['USDC', 'USDT', 'USDC'] }],
    })
    expect(ids(f)).toEqual(['AA006'])
    expect(
      lint({ ...base, permissions: [{ ...base.permissions[0], mints: ['USDC', 'USDC'] }] }),
    ).toEqual([])
  })

  it('AA007 flags a swap without a floor (relay with no floor, or no relay)', () => {
    const swap = {
      program: 'raydium-cpmm',
      instructions: ['swap_base_input'],
      spendLimit: '100',
      perTxLimit: '10',
    }
    const noFloor = lint({ ...base, permissions: [swap], relay: { recipients: [], swap: {} } })
    expect(ids(noFloor)).toContain('AA007')
    expect(ids(lint({ ...base, permissions: [swap], relay: null }))).toContain('AA007')
    const ok = lint({
      ...base,
      permissions: [swap],
      relay: { recipients: [], swap: { floorOut: '95', floorIn: '100' } },
    })
    expect(ids(ok)).not.toContain('AA007')
  })

  it('AA008 flags the agent key in the owner role', () => {
    const f = lint({ ...base, owner: base.agent })
    expect(ids(f)).toEqual(['AA008'])
    const g = lint({ ...base, relay: { ...base.relay, sourceAccountOwner: base.agent } })
    expect(ids(g)).toEqual(['AA008'])
  })

  it('AA009 notes unknown programs and instructions; AA012 per-call above the budget', () => {
    const f = lint({
      ...base,
      permissions: [
        {
          program: 'spl-token',
          instructions: ['nope_not_real'],
          spendLimit: '10',
          perTxLimit: '50',
        },
        {
          program: 'NotInTheRegistry1111111111111111111111111111',
          instructions: ['0102030405060708'],
          spendLimit: '1',
          perTxLimit: '1',
        },
      ],
    })
    expect(ids(f)).toContain('AA009')
    expect(ids(f)).toContain('AA012')
  })

  it('reports malformed plans as AA010 and never throws', () => {
    expect(ids(lint('nope'))).toEqual(['AA010'])
    expect(ids(lint({ permissions: [] }))).toEqual(expect.arrayContaining(['AA010']))
    expect(
      ids(
        lint({
          ...base,
          permissions: [{ program: 'spl-token', instructions: [], spendLimit: 'lots' }],
        }),
      ),
    ).toEqual(expect.arrayContaining(['AA010']))
  })

  it('every rule has a stable id, severity and title', () => {
    expect(Object.keys(RULES).sort()).toEqual([
      'AA001',
      'AA002',
      'AA003',
      'AA004',
      'AA005',
      'AA006',
      'AA007',
      'AA008',
      'AA009',
      'AA010',
      'AA011',
      'AA012',
    ])
    expect(RULES['AA004']?.severity).toBe('error')
  })

  it('lints registry presets without false errors, and says what a preset cannot know', () => {
    for (const name of [
      'payments-usdc',
      'dex-trader-single-pool',
      'treasury-ops',
      'read-only-observer',
    ]) {
      const plan = planFromPreset(name)
      expect(plan, name).not.toBeNull()
      const f = lintPlan(plan!, { nowSeconds: NOW })
      expect(summarize(f).error, `${name}: ${JSON.stringify(f)}`).toBe(0)
    }
    expect(planFromPreset('no-such-preset')).toBeNull()
  })
})

describe('agentauth lint (command)', () => {
  const files = { 'good.json': fixture('plan-good.json'), 'bad.json': fixture('plan-bad.json') }

  it('exits 0 on a clean plan and prints no findings', async () => {
    const h = harness({}, files)
    expect(await runCli(['--no-color', 'lint', 'good.json'], h.deps)).toBe(0)
    expect(h.captured.stdout).toContain('no findings')
  })

  it('exits 1 on errors, in --json mode with the stable schema', async () => {
    const h = harness({}, files)
    expect(await runCli(['--json', 'lint', 'bad.json', '--max-expiry', '30d'], h.deps)).toBe(1)
    const doc = JSON.parse(h.captured.stdout) as {
      schema: string
      ok: boolean
      exitCode: number
      data: { findings: Finding[]; summary: { error: number; warn: number; info: number } }
    }
    expect(doc.schema).toBe('agentauth-cli/1')
    expect(doc.ok).toBe(false)
    expect(doc.exitCode).toBe(1)
    expect(doc.data.summary).toEqual({ error: 6, warn: 3, info: 1 })
    expect(doc.data.findings.map((f) => f.rule)).toEqual([
      'AA001',
      'AA003',
      'AA003',
      'AA004',
      'AA007',
      'AA008',
      'AA005',
      'AA006',
      'AA012',
      'AA011',
    ])
    expect(h.captured.stderr).toBe('')
  })

  it('--fail-on warn also fails on warnings; a bare preset name works', async () => {
    const h = harness(
      {},
      { 'warn.json': JSON.stringify({ ...base, relay: { recipients: [], delegate: '500' } }) },
    )
    expect(await runCli(['lint', 'warn.json'], h.deps)).toBe(0)
    const h2 = harness(
      {},
      { 'warn.json': JSON.stringify({ ...base, relay: { recipients: [], delegate: '500' } }) },
    )
    expect(await runCli(['lint', 'warn.json', '--fail-on', 'warn'], h2.deps)).toBe(1)
    const h3 = harness()
    expect(await runCli(['lint', 'payments-usdc'], h3.deps)).toBe(0)
  })

  it('reads a plan from stdin and refuses unknown inputs', async () => {
    const h = harness({}, { '<stdin>': fixture('plan-good.json') })
    expect(await runCli(['lint', '-'], h.deps)).toBe(0)
    const h2 = harness()
    expect(await runCli(['lint', 'missing.json'], h2.deps)).toBe(1)
    expect(h2.captured.stderr).toContain('neither a readable plan file nor a registry preset')
  })
})
