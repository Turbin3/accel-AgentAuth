import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentAuthError,
  errorFromCode,
  type ActivityItem,
  type Client,
  createClient,
  type Plan,
} from '@agentauth-sol/sdk'
import { runCli } from '../src/app'
import { VERSION } from '../src/version'
import {
  AGENT,
  ATTACKER,
  MANDATE,
  NOW,
  OWNER,
  RECIPIENT,
  SOURCE,
  fakeRpc,
  mandate as fixtureMandate,
  mkClient,
} from './fixtures'
import { fakeSigner, harness } from './helpers'

const AGENT_KEYPAIR = '/keys/agent.json'
const OWNER_KEYPAIR = '/keys/owner.json'
const common = ['--cluster', 'devnet', '--agent-keypair', AGENT_KEYPAIR, '--keypair', OWNER_KEYPAIR]

function setup(client: Client, overrides: Parameters<typeof harness>[0] = {}) {
  return harness({
    createClient: () => client,
    loadKeypair: async (path: string) => fakeSigner(path === AGENT_KEYPAIR ? AGENT : OWNER),
    ...overrides,
  })
}

const sent = {
  signature:
    '5sigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSigSig',
  ok: true,
  err: null,
  slot: 1n,
  error: null,
  logs: [],
}

function parse(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('relay pay', () => {
  it('pre-flights, signs as the agent and prints the stable JSON envelope', async () => {
    const sendAndConfirm = vi.fn(async () => sent)
    const preflightTransfer = vi.fn(async () => ({ ok: true as const }))
    const h = setup(mkClient({ sendAndConfirm, preflightTransfer }))
    const code = await runCli(
      [...common, '--json', 'relay', 'pay', '--to', RECIPIENT, '--amount', '3 DUSD'],
      h.deps,
    )
    expect(h.captured.stderr).toBe('')
    // the budget mint has no known symbol on devnet, so a symbol suffix is refused
    expect(code).toBe(1)
    const code2 = await runCli(
      [...common, '--json', 'relay', 'pay', '--to', RECIPIENT, '--amount', '3'],
      setup(mkClient({ sendAndConfirm, preflightTransfer })).deps,
    )
    expect(code2).toBe(0)
    expect(preflightTransfer).toHaveBeenCalledWith({
      owner: OWNER,
      agent: AGENT,
      destination: RECIPIENT,
      amount: 3_000_000n,
    })
    const call = sendAndConfirm.mock.calls[0] as unknown as [
      unknown,
      { signers: { address: string }[]; skipPreflight?: boolean },
    ]
    expect(call[1].signers.map((s) => s.address)).toEqual([AGENT])
    expect(call[1].skipPreflight).toBeUndefined()
  })

  it('output snapshot of a successful payment (--json)', async () => {
    const h = setup(
      mkClient({ sendAndConfirm: async () => sent, preflightTransfer: async () => ({ ok: true }) }),
    )
    expect(
      await runCli(
        [...common, '--json', 'relay', 'pay', '--to', RECIPIENT, '--amount', '3'],
        h.deps,
      ),
    ).toBe(0)
    expect(parse(h.captured.stdout)).toMatchSnapshot()
  })

  it('exit 2 with the decoded relay 104 when the pre-flight denies; nothing is sent', async () => {
    const sendAndConfirm = vi.fn()
    const preflightTransfer = async () => ({
      ok: false as const,
      program: 'relay' as const,
      code: 104,
      name: 'RecipientNotAllowed',
      message: 'not allowed',
    })
    const h = setup(mkClient({ sendAndConfirm, preflightTransfer }))
    expect(
      await runCli(
        [...common, '--json', 'relay', 'pay', '--to', ATTACKER, '--amount', '40'],
        h.deps,
      ),
    ).toBe(2)
    expect(sendAndConfirm).not.toHaveBeenCalled()
    const doc = parse(h.captured.stdout) as {
      ok: boolean
      exitCode: number
      error: { kind: string; program: { code: number; name: string; program: string } }
    }
    expect(doc.ok).toBe(false)
    expect(doc.exitCode).toBe(2)
    expect(doc.error.kind).toBe('denied')
    expect(doc.error.program).toMatchObject({
      code: 104,
      name: 'RecipientNotAllowed',
      program: 'relay',
    })
    expect(doc).toMatchSnapshot()
  })

  it('--no-preflight lands the attempt (skipPreflight) and a failure exits 3 with the decoded error', async () => {
    const preflightTransfer = vi.fn()
    const sendAndConfirm = vi.fn(async () => ({
      ...sent,
      ok: false,
      error: errorFromCode('relay', 104),
    }))
    const h = setup(mkClient({ sendAndConfirm, preflightTransfer }))
    const code = await runCli(
      [...common, 'relay', 'pay', '--to', ATTACKER, '--amount', '40', '--no-preflight'],
      h.deps,
    )
    expect(code).toBe(3)
    expect(preflightTransfer).not.toHaveBeenCalled()
    expect(
      (sendAndConfirm.mock.calls[0] as unknown as [unknown, { skipPreflight: boolean }])[1]
        .skipPreflight,
    ).toBe(true)
    expect(h.captured.stderr).toContain('relay:104 RecipientNotAllowed')
    expect(h.captured.stderr).toContain('landed and FAILED on chain')
  })

  it('exit 4 when the RPC cannot be reached', async () => {
    const down = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    })
    const h = setup(
      mkClient({
        fetchMandateFor: async () => {
          throw down
        },
      }),
    )
    expect(
      await runCli([...common, 'relay', 'pay', '--to', RECIPIENT, '--amount', '1'], h.deps),
    ).toBe(4)
    expect(h.captured.stderr).toContain('could not reach the RPC endpoint')
  })

  it('--simulate never sends', async () => {
    const sendAndConfirm = vi.fn()
    const simulate = vi.fn(async () => ({
      ok: true,
      err: null,
      logs: [],
      unitsConsumed: 31_000n,
      error: null,
    }))
    const h = setup(
      mkClient({ sendAndConfirm, simulate, preflightTransfer: async () => ({ ok: true }) }),
    )
    expect(
      await runCli(
        [...common, '--simulate', 'relay', 'pay', '--to', RECIPIENT, '--amount', '1'],
        h.deps,
      ),
    ).toBe(0)
    expect(sendAndConfirm).not.toHaveBeenCalled()
    expect(simulate).toHaveBeenCalledOnce()
    expect(h.captured.stdout).toContain('Nothing was sent')
  })
})

describe('global options', () => {
  it('refuses mainnet-beta without the acknowledgement, and warns with it', async () => {
    const h = harness({ createClient: () => mkClient() })
    expect(
      await runCli(['--cluster', 'mainnet-beta', 'registry', 'show', 'spl-token'], h.deps),
    ).toBe(1)
    expect(h.captured.stderr).toContain('unaudited')
    const createClient = vi.fn(() => mkClient())
    const h2 = harness({ createClient })
    expect(
      await runCli(
        [
          '--cluster',
          'mainnet-beta',
          '--i-understand-this-is-unaudited',
          'registry',
          'show',
          'spl-token',
        ],
        h2.deps,
      ),
    ).toBe(0)
    expect(h2.captured.stderr).toContain('MAINNET')
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ cluster: 'mainnet-beta', acknowledgeNoMainnet: true }),
    )
  })

  it('colours on a TTY, and not with NO_COLOR or --no-color', async () => {
    const tty = { write: (_s: string) => true, isTTY: true }
    const run = async (args: string[], env: Record<string, string>) => {
      let out = ''
      const h = harness({
        env,
        createClient: () => mkClient(),
        stdout: {
          write: (s: string) => {
            out += s
            return tty.write(s)
          },
          isTTY: true,
        },
      })
      await runCli(args, h.deps)
      return out
    }
    // eslint-disable-next-line no-control-regex
    const hasEscape = (s: string): boolean => /\u001b\[/.test(s)
    expect(hasEscape(await run(['registry', 'list'], {}))).toBe(true)
    expect(hasEscape(await run(['registry', 'list'], { NO_COLOR: '1' }))).toBe(false)
    expect(hasEscape(await run(['--no-color', 'registry', 'list'], {}))).toBe(false)
  })

  it('asks for confirmation: refuses without --yes on a non-interactive terminal', async () => {
    const unwind = vi.fn(async (): Promise<Plan> => ({
      summary: 'Unwind',
      warnings: [],
      steps: [
        {
          label: 'Unwind',
          description: 'revoke everything',
          instructions: [],
          signers: [OWNER],
          expectedOutcome: 'gone',
          estimatedSizeBytes: 377,
          worstCaseSizeBytes: 431,
          fitsInOneTx: true,
          dependsOn: [],
          awaitConfirmation: false,
        },
      ],
    }))
    const sendAndConfirm = vi.fn(async () => sent)
    const client = mkClient({ plan: { unwind }, sendAndConfirm })
    const h = setup(client)
    expect(await runCli([...common, 'mandate', 'revoke'], h.deps)).toBe(1)
    expect(sendAndConfirm).not.toHaveBeenCalled()
    expect(h.captured.stderr).toContain('--yes')
    const h2 = setup(client)
    expect(await runCli([...common, '--yes', 'mandate', 'revoke'], h2.deps)).toBe(0)
    expect(sendAndConfirm).toHaveBeenCalledOnce()
    expect(h2.captured.stdout).toContain('377 B of 1232')
  })
})

describe('check and activity', () => {
  it('check: allowed is advisory, a missing slot is denied with exit 2', async () => {
    const h = setup(mkClient())
    expect(
      await runCli(
        [
          ...common,
          '--json',
          'check',
          '--program',
          'spl-token',
          '--instruction',
          'transfer_checked',
          '--amount',
          '3',
        ],
        h.deps,
      ),
    ).toBe(0)
    expect(parse(h.captured.stdout)).toMatchObject({
      ok: true,
      data: { allowed: true, advisory: true, hardEnforcedThroughRelay: true },
    })
    const h2 = setup(mkClient())
    expect(
      await runCli(
        [...common, 'check', '--program', 'spl-token', '--instruction', 'approve', '--amount', '1'],
        h2.deps,
      ),
    ).toBe(2)
    expect(h2.captured.stderr).toContain('agent_auth:7 DiscriminatorNotAllowed')
    const h3 = setup(mkClient())
    expect(
      await runCli(
        [
          ...common,
          'check',
          '--program',
          'spl-token',
          '--instruction',
          'transfer_checked',
          '--amount',
          '6',
        ],
        h3.deps,
      ),
    ).toBe(2)
    expect(h3.captured.stderr).toContain('PerTxExceeded')
  })

  const item = (over: Partial<ActivityItem>): ActivityItem => ({
    signature: 'sig1',
    slot: 10n,
    blockTime: NOW - 30n,
    kind: 'relay_transfer',
    ok: true,
    amount: 3_000_000n,
    instructionIndex: 0,
    ...over,
  })

  it('activity prints BLOCKED rows with the decoded reason and hides the nested verify', async () => {
    const rows = [
      item({
        signature: 'sigB',
        ok: false,
        amount: 40_000_000n,
        error: errorFromCode('relay', 104),
      }),
      item({
        signature: 'sigB',
        kind: 'verify',
        ok: false,
        amount: 40_000_000n,
        error: errorFromCode('relay', 104),
      }),
      item({ signature: 'sigA' }),
    ]
    const client = mkClient({ activity: async () => rows })
    const h = setup(client, { now: () => Number(NOW) * 1000 })
    expect(await runCli([...common, '--no-color', 'activity'], h.deps)).toBe(0)
    const lines = h.captured.stdout.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/relay pay\s+BLOCKED relay:104 RecipientNotAllowed\s+40\s/)
    expect(lines[2]).toMatch(/relay pay\s+ok\s+3\s/)
    const h2 = setup(client)
    expect(await runCli([...common, '--json', 'activity'], h2.deps)).toBe(0)
    expect((parse(h2.captured.stdout).data as { items: unknown[] }).items).toHaveLength(3)
  })

  it('activity --follow polls for newer rows only', async () => {
    const fetchRows = vi
      .fn()
      .mockResolvedValueOnce([item({ signature: 'old' })])
      .mockResolvedValueOnce([
        item({ signature: 'new', ok: false, error: errorFromCode('agent_auth', 8) }),
      ])
    const sleep = vi.fn(async () => {})
    const h = setup(mkClient({ activity: fetchRows }), {
      maxFollowPolls: 1,
      sleep,
      now: () => Number(NOW) * 1000,
    })
    expect(await runCli([...common, '--no-color', 'activity', '--follow'], h.deps)).toBe(0)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(fetchRows.mock.calls[1]?.[0]).toMatchObject({ until: 'old' })
    expect(h.captured.stdout).toContain('BLOCKED agent_auth:8 PerTxExceeded')
  })
})

describe('mandate create (preview)', () => {
  it('previews warnings first, plans through the SDK and sends nothing on --dry-run', async () => {
    const sendAndConfirm = vi.fn()
    const h = setup(mkClient({ sendAndConfirm }), { env: {} })
    const code = await runCli(
      [
        ...common,
        '--no-color',
        'mandate',
        'create',
        '--mint',
        'BycYxSzMrVVPc66F3rzP1AqLYN3qezLVyErqYuMdRRZ6',
        '--source',
        SOURCE,
        '--recipient',
        RECIPIENT,
        '--per-call',
        '5',
        '--budget',
        '20',
        '--agent',
        AGENT,
        '--dry-run',
      ],
      h.deps,
    )
    expect(h.captured.stderr).toBe('')
    expect(code).toBe(0)
    expect(sendAndConfirm).not.toHaveBeenCalled()
    const text = h.captured.stdout
    expect(text.indexOf('Warnings')).toBeGreaterThan(-1)
    expect(text.indexOf('Warnings')).toBeLessThan(text.indexOf('The agent can'))
    expect(text).toContain('HARD')
    expect(text).toContain('Dry run: nothing was sent.')
    expect(text).toContain('unaudited')
  })

  it('refuses an unlimited limit, an unknown preset and a missing limit', async () => {
    const base = [
      'mandate',
      'create',
      '--mint',
      'BycYxSzMrVVPc66F3rzP1AqLYN3qezLVyErqYuMdRRZ6',
      '--source',
      SOURCE,
      '--recipient',
      RECIPIENT,
      '--agent',
      AGENT,
      '--dry-run',
    ]
    const h = setup(mkClient())
    expect(
      await runCli(
        [...common, ...base, '--per-call', '5', '--budget', 'unlimited', '--delegate', '10'],
        h.deps,
      ),
    ).toBe(2)
    expect(h.captured.stderr).toContain('plan was refused')
    expect(h.captured.stderr.toLowerCase()).toContain('unlimited')
    const h1 = setup(mkClient())
    expect(
      await runCli([...common, ...base, '--per-call', '5', '--budget', 'unlimited'], h1.deps),
    ).toBe(1)
    expect(h1.captured.stderr).toContain('--delegate')
    const h2 = setup(mkClient())
    expect(await runCli([...common, ...base, '--per-call', '5'], h2.deps)).toBe(1)
    expect(h2.captured.stderr).toContain('--per-call and --budget')
    const h3 = setup(mkClient())
    expect(await runCli([...common, ...base, '--preset', 'nope'], h3.deps)).toBe(1)
  })
})

describe('registry and misc', () => {
  it('registry decode and presets snapshots (--json)', async () => {
    const h = harness({ createClient: () => mkClient() })
    expect(
      await runCli(['--json', 'registry', 'decode', 'spl-token', '0c40420f000000000006'], h.deps),
    ).toBe(0)
    expect(parse(h.captured.stdout)).toMatchSnapshot()
    const h2 = harness({ createClient: () => mkClient() })
    expect(await runCli(['--json', 'registry', 'presets'], h2.deps)).toBe(0)
    expect(parse(h2.captured.stdout)).toMatchSnapshot()
  })

  it('version matches package.json; unknown commands exit 1', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
    const h = harness()
    expect(await runCli(['version'], h.deps)).toBe(0)
    expect(h.captured.stdout).toBe(`agentauth ${VERSION}\n`)
    const h2 = harness()
    expect(await runCli(['frobnicate'], h2.deps)).toBe(1)
  })

  it('AgentAuthError import is the SDK class used for decoding', () => {
    expect(errorFromCode('relay', 104)).toBeInstanceOf(AgentAuthError)
    expect(MANDATE.length).toBeGreaterThan(30)
  })
})

describe('polish', () => {
  const emptyPlan = {
    summary: 'Revoke something on mandate abc, unsigned.',
    warnings: [],
    steps: [],
  } as unknown as Plan
  const base = (over: Partial<ActivityItem>): ActivityItem => ({
    signature: 'sig1',
    slot: 10n,
    blockTime: NOW - 30n,
    kind: 'relay_pause',
    ok: true,
    instructionIndex: 0,
    ...over,
  })

  it('permission remove predicts 6 when the slot empties and 7 otherwise, from the live permission', async () => {
    const plan = {
      revokeDiscriminator: async () => emptyPlan,
      revokePermission: async () => emptyPlan,
    }
    const run = async (names: string[]) => {
      const h = setup(mkClient({ plan }))
      const code = await runCli(
        [...common, '--no-color', '--simulate', 'permission', 'remove', 'spl-token', ...names],
        h.deps,
      )
      expect(h.captured.stderr).toBe('')
      expect(code).toBe(0)
      return h.captured.stdout
    }
    // the fixture permission holds only transfer_checked (0c00...)
    const only = await run(['transfer_checked'])
    expect(only).toContain('ProgramNotAllowed (agent_auth 6)')
    expect(only).not.toContain('DiscriminatorNotAllowed')
    const two = {
      ...fixtureMandate,
      permissions: fixtureMandate.permissions.map((p) => ({
        ...p,
        discriminators: [...p.discriminators, Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0])],
        discriminatorsHex: [...p.discriminatorsHex, '0300000000000000'],
      })),
    }
    const more = mkClient({
      plan,
      fetchMandateFor: async () => ({ address: MANDATE, mandate: two }),
    })
    const h = setup(more)
    expect(
      await runCli(
        [
          ...common,
          '--no-color',
          '--simulate',
          'permission',
          'remove',
          'spl-token',
          'transfer_checked',
        ],
        h.deps,
      ),
    ).toBe(0)
    expect(h.captured.stdout).toContain('DiscriminatorNotAllowed (agent_auth 7)')
  })

  it('activity labels pause versus resume from the decoded event, and reads a closed mandate with --address', async () => {
    const rows = [
      base({ signature: 'a', event: { type: 'PausedChanged', mandate: MANDATE, paused: false } }),
      base({ signature: 'b', event: { type: 'PausedChanged', mandate: MANDATE, paused: true } }),
      base({ signature: 'c', kind: 'set_active' }),
      base({ signature: 'c', event: { type: 'PausedChanged', mandate: MANDATE, paused: true } }),
    ]
    const activity = vi.fn(async (_opts: unknown) => rows)
    const closed = mkClient({
      activity,
      fetchMandate: async () => null,
      fetchPolicy: async () => null,
    })
    const h = setup(closed, { now: () => Number(NOW) * 1000 })
    expect(await runCli([...common, '--no-color', 'activity', '--address', MANDATE], h.deps)).toBe(
      0,
    )
    const out = h.captured.stdout
    expect(out).toMatch(/relay resume\s+ok/)
    expect(out).toMatch(/relay pause\s+ok/)
    expect(out).toMatch(/mandate pause\s+ok/)
    expect(activity.mock.calls[0]?.[0]).toMatchObject({ mandate: MANDATE })
  })

  it('--json failure envelopes carry data: null, and registry decode joins hex arguments', async () => {
    const h = setup(mkClient())
    expect(
      await runCli([...common, '--json', 'registry', 'decode', 'spl-token', 'zz'], h.deps),
    ).toBe(1)
    expect(parse(h.captured.stdout.trim().split('\n')[0] ?? '{}')).toHaveProperty('data', null)
    const a = harness({ createClient: () => mkClient() })
    const b = harness({ createClient: () => mkClient() })
    await runCli(['--json', 'registry', 'decode', 'spl-token', '0c40420f00', '0000000006'], a.deps)
    await runCli(['--json', 'registry', 'decode', 'spl-token', '0x0c40420f000000000006'], b.deps)
    expect(parse(a.captured.stdout).data).toEqual(parse(b.captured.stdout).data)
  })

  it('doctor reads accounts at the confirmed commitment, like the bootstrap', async () => {
    const seen: unknown[] = []
    const rpc = fakeRpc()
    const spy = {
      ...rpc,
      getAccountInfo: (address: string, cfg?: { commitment?: string }) => {
        seen.push(cfg?.commitment)
        return rpc.getAccountInfo(address)
      },
    }
    const client = createClient({
      cluster: 'devnet',
      rpc: spy as unknown as NonNullable<Parameters<typeof createClient>[0]>['rpc'],
    })
    const h = setup(client)
    await runCli([...common, '--no-color', 'doctor'], h.deps)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((c) => c === 'confirmed')).toBe(true)
  })
})
