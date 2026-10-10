import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchTokenAccount } from '@agentauth-sol/demo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAINNET_GENESIS_HASH } from '../../src/config'
import { createLogger } from '../../src/log'
import { createServer } from '../../src/server'
import { buildFromConfig, UNSAFE_BANNER } from '../../src/start'
import {
  agentSession,
  baseConfig,
  call,
  connectClient,
  createFixture,
  ownerSession,
  planTransactions,
  requireE2e,
  walletSignAndSend,
  type Fixture,
} from '../support/fixture'

describe.skipIf(!requireE2e())(
  'owner profile: unsigned plans signed by a wallet (localnet)',
  () => {
    let fx: Fixture
    beforeAll(async () => {
      fx = await createFixture({ onboard: false, perCall: '2', lifetime: '5', swap: true })
    })
    afterAll(() => fx.cleanup())

    const signAll = async (body: Record<string, unknown>) => {
      for (const tx of planTransactions(body)) await walletSignAndSend(fx, tx.base64)
    }

    it('onboarding, pause, resume, per-instruction revoke and the kill switch, end to end', async () => {
      const owner = await ownerSession(fx)
      expect(owner.handle.ctx.ownerSigner).toBeUndefined()
      expect(owner.handle.ctx.agentSigner).toBeUndefined()

      // 1. nothing exists yet
      const before = await call(owner.client, 'owner_explain_mandate')
      expect(before.body).toMatchObject({ ok: true, mandate: { status: 'not_found' } })

      // 2. plan the onboarding: unsigned, two transactions, signed only by the owner
      const swap = {
        amm_program: fx.env.programIds.mockAmm,
        amm_authority: fx.env.pool.authority,
        amm_config: fx.env.pool.config,
        pool_state: fx.env.pool.state,
        input_vault: fx.env.pool.vaultDusd,
        output_vault: fx.env.pool.vaultDout,
        observation_state: fx.env.pool.observation,
        in_mint: fx.env.mints.dusd.address,
        out_mint: fx.env.mints.dout.address,
        in_account: fx.ownerDusd,
        out_account: fx.ownerDout,
        floor_out: '95',
        floor_in: '100',
        max_deadline_slots: 150,
        per_call_limit: '2',
        lifetime_limit: '5',
      }
      const plan = await call(owner.client, 'owner_plan_onboarding', {
        agent: fx.agent.address,
        mint: fx.env.mints.dusd.address,
        source_token_account: fx.ownerDusd,
        recipients: [fx.allowed],
        per_call_limit: '2',
        lifetime_limit: '5',
        expires_in: '1h',
        fund_agent_sol: '0.05',
        swap,
      })
      expect(plan.isError).toBe(false)
      const txs = planTransactions(plan.body)
      expect(txs).toHaveLength(2)
      expect(txs[1]?.depends_on).toEqual([0])
      for (const tx of txs) {
        expect(tx.required_signers).toEqual([fx.owner.address])
        expect(
          Buffer.from(tx.base64, 'base64')
            .subarray(1, 65)
            .every((b) => b === 0),
        ).toBe(true) // empty signature slot
      }
      expect(String(plan.body['summary'])).toMatch(/mandate/i)
      expect((plan.body['warnings'] as string[]).length).toBeGreaterThan(0)
      expect(String(plan.body['signing'])).toMatch(/never sees or asks for the owner key/)
      expect(plan.body['dev_plan_id']).toBeUndefined()
      expect(plan.raw).not.toMatch(/dev_plan_id/)

      // nothing happened on chain until the wallet signed
      expect((await call(owner.client, 'owner_explain_mandate')).body).toMatchObject({
        mandate: { status: 'not_found' },
      })
      await signAll(plan.body)

      // 3. the mandate exists, as the agent sees it
      const agent = await agentSession(fx)
      expect((await call(agent.client, 'agentauth_status')).body).toMatchObject({
        mandate: { status: 'active' },
        budget: { per_call_limit: '2', lifetime_limit: '5' },
        swap: { enabled: true },
      })
      expect(
        (
          await call(agent.client, 'agentauth_pay', {
            recipient: 'recipient-1',
            amount: '1',
            idempotency_key: 'owner-flow-001',
          })
        ).body['ok'],
      ).toBe(true)

      // 4. owner explanation: every permission, human units, hard vs advisory
      const explained = await call(owner.client, 'owner_explain_mandate')
      const permissions = explained.body['permissions'] as Array<{
        per_call_limit: string
        lifetime_limit: string
        spent: string
      }>
      expect(permissions).toHaveLength(2)
      expect(permissions[0]).toMatchObject({ per_call_limit: '2', lifetime_limit: '5', spent: '1' })
      expect((explained.body['can'] as string[]).length).toBeGreaterThan(0)

      // 5. pause (relay) -> denied 116 -> resume -> pays again
      const pause = await call(owner.client, 'owner_plan_pause', { scope: 'relay' })
      expect(pause.isError).toBe(false)
      await signAll(pause.body)
      const paused = await call(agent.client, 'agentauth_pay', {
        recipient: 'recipient-1',
        amount: '0.5',
        idempotency_key: 'owner-flow-002',
      })
      expect(paused.body, paused.raw).toMatchObject({ denied: true, code: 116, name: 'Paused' })
      const resume = await call(owner.client, 'owner_plan_resume', { scope: 'relay' })
      await signAll(resume.body)
      expect(
        (
          await call(agent.client, 'agentauth_pay', {
            recipient: 'recipient-1',
            amount: '0.5',
            idempotency_key: 'owner-flow-003',
          })
        ).body['ok'],
      ).toBe(true)

      // 6. per-instruction revoke: the Token permission goes, AgentAuth 6 for pay, swap still allowed
      const revoke = await call(owner.client, 'owner_plan_revoke_permission', {
        program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      })
      expect(revoke.isError).toBe(false)
      await signAll(revoke.body)
      const six = await call(agent.client, 'agentauth_pay', {
        recipient: 'recipient-1',
        amount: '0.6',
        idempotency_key: 'owner-flow-004',
      })
      expect(six.body, six.raw).toMatchObject({
        denied: true,
        program: 'agent_auth',
        code: 6,
        name: 'ProgramNotAllowed',
      })
      expect(
        (
          await call(agent.client, 'agentauth_swap', {
            amount_in: '1',
            idempotency_key: 'owner-flow-005',
          })
        ).body['ok'],
      ).toBe(true)

      // 7. owner activity shows the agent's allowed actions
      const activity = await call(owner.client, 'owner_activity', { limit: 20 })
      expect(
        (activity.body['items'] as Array<{ kind: string }>).some((i) => i.kind === 'relay_swap'),
      ).toBe(true)

      // 8. kill switch: one transaction; delegation revoked, mandate and policy gone
      const unwind = await call(owner.client, 'owner_plan_unwind')
      expect(planTransactions(unwind.body)).toHaveLength(1)
      await signAll(unwind.body)
      expect((await fetchTokenAccount(fx.chain, fx.ownerDusd))?.delegate).toBeNull()
      const gone = await call(agent.client, 'agentauth_pay', {
        recipient: 'recipient-1',
        amount: '0.7',
        idempotency_key: 'owner-flow-006',
      })
      expect(gone.isError).toBe(true)
      expect((await call(agent.client, 'agentauth_status')).body).toMatchObject({
        mandate: { status: 'not_found' },
      })
      await agent.close()
      await owner.close()
    })

    it('refuses unsafe or inconsistent plans with every reason, and bad input', async () => {
      const owner = await ownerSession(fx, { agent: undefined })
      const base = {
        agent: fx.agent.address,
        mint: fx.env.mints.dusd.address,
        source_token_account: fx.ownerDusd,
        recipients: [fx.allowed],
        per_call_limit: '2',
        lifetime_limit: '5',
      }
      const overDelegate = await call(owner.client, 'owner_plan_onboarding', {
        ...base,
        delegate_cap: '50',
      })
      expect(overDelegate.isError).toBe(true)
      expect(overDelegate.body).toMatchObject({ error: { code: 'PLAN_REFUSED' } })
      expect((overDelegate.body['error'] as { reasons: string[] }).reasons.length).toBeGreaterThan(
        0,
      )
      const zeroExpiry = await call(owner.client, 'owner_plan_onboarding', {
        ...base,
        expires_in: '0d',
      })
      expect(zeroExpiry.isError).toBe(true)
      const unlimited = await call(owner.client, 'owner_plan_onboarding', {
        ...base,
        lifetime_limit: 'unlimited',
      })
      expect(unlimited.isError).toBe(true)
      const zeroLimit = await call(owner.client, 'owner_plan_onboarding', {
        ...base,
        per_call_limit: '0',
      })
      expect(zeroLimit.isError).toBe(true)
      const noAgent = await call(owner.client, 'owner_plan_pause', {})
      expect(noAgent.isError).toBe(true)
      const keyArg = await call(owner.client, 'owner_plan_pause', {
        agent: fx.agent.address,
        private_key: 'x',
      })
      expect(keyArg.isError).toBe(true)
      await owner.close()
    })
  },
)

describe.skipIf(!requireE2e())('observer profile (localnet)', () => {
  let fx: Fixture
  beforeAll(async () => {
    fx = await createFixture({ perCall: '2', lifetime: '5' })
  })
  afterAll(() => fx.cleanup())

  it('reads any mandate and its activity, and can change nothing', async () => {
    const handle = createServer({
      config: baseConfig({ profile: 'observer' }),
      log: createLogger('silent'),
      client: fx.client,
    })
    const client = await connectClient(handle)
    const explained = await call(client, 'observer_explain_mandate', {
      owner: fx.owner.address,
      agent: fx.agent.address,
    })
    expect(explained.body).toMatchObject({
      ok: true,
      mandate: { status: 'active' },
      budget: { per_call_limit: '2' },
    })
    const activity = await call(client, 'observer_activity', {
      owner: fx.owner.address,
      agent: fx.agent.address,
    })
    expect(activity.body['ok']).toBe(true)
    const resource = await client.readResource({
      uri: `agentauth://mandate/${String(explained.body['mandate'] && (explained.body['mandate'] as { address: string }).address)}`,
    })
    expect(JSON.parse((resource.contents[0] as { text: string }).text)).toMatchObject({
      ok: true,
      status: 'active',
    })
    for (const name of ['agentauth_pay', 'owner_plan_unwind', 'owner_dev_sign_and_send']) {
      expect((await call(client, name, {})).isError, name).toBe(true)
    }
    await client.close()
  })
})

describe.skipIf(!requireE2e())('--unsafe-dev-sign (demo only) (localnet)', () => {
  let fx: Fixture
  let ownerKeyFile: string
  beforeAll(async () => {
    fx = await createFixture({ perCall: '2', lifetime: '5', swap: false })
    ownerKeyFile = (await import('node:path')).join(fx.dir, 'owner.json')
  })
  afterAll(() => fx.cleanup())

  const cfg = (over = {}) =>
    baseConfig({
      profile: 'owner',
      owner: fx.owner.address,
      agent: fx.agent.address,
      unsafeDevSign: true,
      ownerKeypairPath: ownerKeyFile,
      ...over,
    })

  it('prints a warning banner to stderr, exposes the dev signer and signs only plans it built', async () => {
    const banner: string[] = []
    const handle = await buildFromConfig(cfg(), createLogger('silent'), (t) => banner.push(t))
    expect(banner.join('\n')).toBe(UNSAFE_BANNER)
    expect(banner.join('\n')).toMatch(/unsafe-dev-sign is ON/)
    const client = await connectClient(handle)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('owner_dev_sign_and_send')

    const plan = await call(client, 'owner_plan_pause', { scope: 'relay' })
    const id = String(plan.body['dev_plan_id'])
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    const unknown = await call(client, 'owner_dev_sign_and_send', { dev_plan_id: 'abcdef012345' })
    expect(unknown.body).toMatchObject({ error: { code: 'NOT_FOUND' } })
    const sent = await call(client, 'owner_dev_sign_and_send', { dev_plan_id: id })
    expect(sent.body).toMatchObject({ ok: true, results: [{ step: 0, ok: true }] })
    expect(String(sent.body['warning'])).toMatch(/demo key/)
    const again = await call(client, 'owner_dev_sign_and_send', { dev_plan_id: id })
    expect(again.isError).toBe(true) // a plan can be signed once

    const agent = await agentSession(fx)
    const r = await call(agent.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.5',
      idempotency_key: 'dev-sign-0001',
    })
    expect(r.body).toMatchObject({ denied: true, code: 116 })
    await agent.close()
    await client.close()
  })

  it('is refused on mainnet, against a mainnet RPC, and with a key that is not the owner', async () => {
    await expect(
      buildFromConfig(cfg({ cluster: 'mainnet-beta' }), createLogger('silent'), () => undefined),
    ).rejects.toThrow(/mainnet/)

    const server: Server = createHttpServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: MAINNET_GENESIS_HASH }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await expect(
      buildFromConfig(
        cfg({ rpcUrl: `http://127.0.0.1:${port}` }),
        createLogger('silent'),
        () => undefined,
      ),
    ).rejects.toThrow(/mainnet-beta/)
    server.close()

    await expect(
      buildFromConfig(cfg({ owner: fx.agent.address }), createLogger('silent'), () => undefined),
    ).rejects.toThrow(/does not match --owner/)
  })
})
