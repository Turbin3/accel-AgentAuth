import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, createFixture, requireE2e, type Fixture } from '../support/fixture'

const PKG = resolve(import.meta.dirname, '..', '..')
const BIN = join(PKG, 'dist', 'bin.js')

/** Always rebuild: a stale dist would test yesterday's code. */
function ensureBuilt(): void {
  const res = spawnSync('pnpm', ['exec', 'tsup'], { cwd: PKG, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`build failed: ${res.stderr.slice(-400)}`)
}

/** Env of a child process: only what the server needs (no inherited AgentAuth variables). */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('AGENTAUTH_')) env[k] = v
  }
  return { ...env, ...extra }
}

describe('bin: configuration errors (no network needed)', () => {
  beforeAll(ensureBuilt, 120_000)
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [BIN, ...args], {
      env: childEnv(env),
      encoding: 'utf8',
      timeout: 20_000,
    })

  it('exits 2 with usage when the profile is missing', () => {
    const r = run([])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--profile must be one of/)
    expect(r.stdout).toBe('') // stdout is reserved for the protocol
  })

  it('agent profile without a key file, and with an owner key in its environment', () => {
    const owner = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'
    expect(run(['--profile', 'agent', '--owner', owner]).status).toBe(2)
    const r = run(['--profile', 'agent', '--owner', owner], {
      AGENTAUTH_AGENT_KEYPAIR: '/nonexistent/agent.json',
      AGENTAUTH_OWNER_KEYPAIR: '/nonexistent/SUPERSECRET-owner.json',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/must never see the owner key/)
    expect(r.stderr).not.toContain('SUPERSECRET')
  })

  it('refuses --unsafe-dev-sign on mainnet and outside the owner profile', () => {
    const owner = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'
    const env = { AGENTAUTH_OWNER_KEYPAIR: '/tmp/x.json' }
    expect(
      run(
        ['--profile', 'owner', '--owner', owner, '--cluster', 'mainnet-beta', '--unsafe-dev-sign'],
        env,
      ).stderr,
    ).toMatch(/refused on mainnet/)
    expect(run(['--profile', 'observer', '--unsafe-dev-sign'], env).status).toBe(2)
  })

  it('a malformed key file fails without quoting its content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-mcp-badkey-'))
    const file = join(dir, 'agent.json')
    writeFileSync(file, 'TOP-SECRET-CONTENT {{ not json', { mode: 0o600 })
    const r = run(
      ['--profile', 'agent', '--owner', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'],
      { AGENTAUTH_AGENT_KEYPAIR: file },
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/not a Solana CLI keypair/)
    expect(r.stderr).not.toContain('TOP-SECRET')
    const missing = run(
      ['--profile', 'agent', '--owner', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'],
      { AGENTAUTH_AGENT_KEYPAIR: join(dir, 'nope.json') },
    )
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/cannot read the agent keypair file/)
  })

  it('--help prints usage to stderr and exits 0', () => {
    const r = run(['--help'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/Usage: agentauth-mcp/)
  })
})

describe.skipIf(!requireE2e())('bin over real stdio against localnet', () => {
  let fx: Fixture
  beforeAll(async () => {
    ensureBuilt()
    fx = await createFixture({ perCall: '2', lifetime: '5' })
  }, 240_000)
  afterAll(() => fx.cleanup())

  it('speaks MCP on stdout, logs redacted JSON on stderr, pays and denies', async () => {
    const stderr: string[] = []
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        BIN,
        '--profile',
        'agent',
        '--cluster',
        'localnet',
        '--owner',
        fx.owner.address,
        '--rpc-url',
        process.env['AA_RPC_URL'] ?? '',
        '--log-level',
        'debug',
      ],
      env: childEnv({ AGENTAUTH_AGENT_KEYPAIR: fx.agentFile }),
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
    const client = new Client({ name: 'stdio-test', version: '0.0.0' })
    await client.connect(transport)

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('agentauth_pay')
    expect(client.getInstructions()).toMatch(/Do NOT retry with a different recipient/)
    const status = await call(client, 'agentauth_status')
    expect(status.body).toMatchObject({
      ok: true,
      mandate: { status: 'active', agent: fx.agent.address },
    })
    const pay = await call(client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '1',
      idempotency_key: 'stdio-pay-0001',
    })
    expect(pay.body['ok']).toBe(true)
    const denied = await call(client, 'agentauth_pay', {
      recipient: fx.attacker,
      amount: '1',
      idempotency_key: 'stdio-pay-0002',
    })
    expect(denied.body).toMatchObject({ denied: true, code: 104, name: 'RecipientNotAllowed' })
    await client.close()

    const lines = stderr.join('').split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(2)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed.some((p) => p['event'] === 'server_ready')).toBe(true)
    expect(parsed.some((p) => p['event'] === 'tool_call' && p['tool'] === 'agentauth_pay')).toBe(
      true,
    )
    const secret = new Uint8Array(JSON.parse(readFileSync(fx.agentFile, 'utf8')) as number[])
    const joined = lines.join('\n')
    expect(joined).not.toContain(JSON.stringify([...secret]))
    expect(joined).not.toContain(Buffer.from(secret).toString('hex'))
    expect(joined).not.toContain('recipient-1') // tool arguments are not logged
    expect(joined).not.toContain('stdio-pay-0001')
  }, 120_000)
})
