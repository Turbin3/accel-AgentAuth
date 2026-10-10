import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GATED_ACTION_DISC } from '@agentauth-sol/sdk'
import {
  agentSession,
  balanceOf,
  call,
  createFixture,
  requireE2e,
  type Fixture,
} from '../support/fixture'

/** Every agent-profile tool, happy path, against the localnet bootstrap. */
describe.skipIf(!requireE2e())('agent tools: happy paths (localnet)', () => {
  let fx: Fixture
  let session: Awaited<ReturnType<typeof agentSession>>

  beforeAll(async () => {
    fx = await createFixture({ perCall: '2', lifetime: '5', delegateCap: '50' })
    session = await agentSession(fx)
  })
  afterAll(async () => {
    await session.close()
    fx.cleanup()
  })

  it('lists the agent tools including swap (the policy enables it)', async () => {
    const names = (await session.client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual([
      'agentauth_status',
      'agentauth_check_action',
      'agentauth_pay',
      'agentauth_swap',
      'agentauth_explain_denial',
      'agentauth_activity',
    ])
  })

  it('agentauth_status reports limits in human units, labelled recipients and the enforcement level', async () => {
    const r = await call(session.client, 'agentauth_status')
    expect(r.isError).toBe(false)
    expect(r.body).toMatchObject({
      ok: true,
      mandate: {
        status: 'active',
        owner: fx.owner.address,
        agent: fx.agent.address,
        relay_paused: false,
      },
      budget: {
        decimals: 6,
        per_call_limit: '2',
        lifetime_limit: '5',
        spent: '0',
        remaining: '5',
        max_spend_now: '2',
      },
      allowed_recipients: [{ label: 'recipient-1', token_account: fx.allowed }],
      swap: { enabled: true },
    })
    const enforcement = r.body['enforcement'] as Array<{ level: string }>
    expect(enforcement.length).toBe(2)
    expect(enforcement.every((e) => e.level === 'hard (relay)')).toBe(true)
    expect(String(r.body['honesty'])).toMatch(/Unaudited devnet prototype/)
  })

  it('agentauth_check_action: pay, swap and an advisory action', async () => {
    const ok = await call(session.client, 'agentauth_check_action', {
      action: 'pay',
      recipient: 'recipient-1',
      amount: '1',
    })
    expect(ok.body).toMatchObject({ ok: true, would_be_allowed: true, enforcement: 'hard (relay)' })
    const wrong = await call(session.client, 'agentauth_check_action', {
      action: 'pay',
      recipient: fx.attacker,
      amount: '1',
    })
    expect(wrong.body).toMatchObject({
      would_be_allowed: false,
      error: { program: 'relay', code: 104, name: 'RecipientNotAllowed' },
    })
    const big = await call(session.client, 'agentauth_check_action', {
      action: 'pay',
      recipient: 'recipient-1',
      amount: '3',
    })
    expect(big.body).toMatchObject({
      would_be_allowed: false,
      error: { program: 'agent_auth', code: 8, name: 'PerTxExceeded' },
    })
    const swap = await call(session.client, 'agentauth_check_action', {
      action: 'swap',
      amount: '1',
    })
    expect(swap.body).toMatchObject({ would_be_allowed: true, enforcement: 'hard (relay)' })
    const advisory = await call(session.client, 'agentauth_check_action', {
      action: 'other_program',
      program: fx.env.programIds.gatedExample,
      instruction: GATED_ACTION_DISC,
      raw_amount: '1',
    })
    expect(advisory.body).toMatchObject({
      would_be_allowed: false,
      error: { name: 'ProgramNotAllowed' },
    })
    expect(String(advisory.body['enforcement'])).toMatch(/^advisory/)
  })

  it('agentauth_pay moves exactly the requested amount to the allowed recipient', async () => {
    const before = await balanceOf(fx, fx.allowed)
    const r = await call(session.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '1.5',
      idempotency_key: 'happy-pay-0001',
    })
    expect(r.isError).toBe(false)
    expect(r.body).toMatchObject({
      ok: true,
      enforcement: 'hard (relay)',
      paid: { amount: '1.5', recipient: 'recipient-1' },
    })
    expect(typeof r.body['signature']).toBe('string')
    expect((await balanceOf(fx, fx.allowed)) - before).toBe(1_500_000n)
    const status = await call(session.client, 'agentauth_status')
    expect(status.body).toMatchObject({ budget: { spent: '1.5', remaining: '3.5' } })
  })

  it('agentauth_pay accepts the token account address as the recipient too', async () => {
    const before = await balanceOf(fx, fx.allowed)
    const r = await call(session.client, 'agentauth_pay', {
      recipient: fx.allowed,
      amount: '0.25',
      idempotency_key: 'happy-pay-0002',
    })
    expect(r.body['ok']).toBe(true)
    expect((await balanceOf(fx, fx.allowed)) - before).toBe(250_000n)
  })

  it('agentauth_swap swaps on the pinned pool and the output lands in the owner account', async () => {
    const before = await balanceOf(fx, fx.ownerDout)
    const r = await call(session.client, 'agentauth_swap', {
      amount_in: '1',
      idempotency_key: 'happy-swap-001',
    })
    expect(r.isError).toBe(false)
    expect(r.body).toMatchObject({
      ok: true,
      enforcement: 'hard (relay)',
      swapped: { amount_in: '1', output_goes_to: fx.ownerDout },
    })
    const gained = (await balanceOf(fx, fx.ownerDout)) - before
    expect(gained).toBeGreaterThanOrEqual(950_000n) // the relay floor is 95 out per 100 in
  })

  it('agentauth_swap: a swap above the per-call limit is a structured denial', async () => {
    const r = await call(session.client, 'agentauth_swap', {
      amount_in: '3',
      idempotency_key: 'happy-swap-002',
    })
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({
      denied: true,
      program: 'agent_auth',
      code: 8,
      name: 'PerTxExceeded',
      can_retry: false,
    })
  })

  it('agentauth_explain_denial decodes a code, ambiguous codes and logs', async () => {
    const byCode = await call(session.client, 'agentauth_explain_denial', {
      code: 104,
      program: 'relay',
    })
    expect(byCode.body).toMatchObject({
      ok: true,
      matches: [{ program: 'relay', code: 104, name: 'RecipientNotAllowed' }],
    })
    const eight = await call(session.client, 'agentauth_explain_denial', {
      code: 8,
      program: 'agent_auth',
    })
    expect(eight.body).toMatchObject({ matches: [{ name: 'PerTxExceeded' }] })
    const ambiguous = await call(session.client, 'agentauth_explain_denial', { code: 4 })
    expect((ambiguous.body['matches'] as unknown[]).length).toBeGreaterThan(1)
    expect(ambiguous.body['ambiguous']).toBeDefined()
    const unknown = await call(session.client, 'agentauth_explain_denial', { code: 99999 })
    expect(unknown.body).toMatchObject({ matches: [] })
    const none = await call(session.client, 'agentauth_explain_denial', {})
    expect(none.isError).toBe(true)
    expect(none.body).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('agentauth_activity lists the payments that landed, newest first, in human units', async () => {
    const r = await call(session.client, 'agentauth_activity', { limit: 20 })
    expect(r.isError).toBe(false)
    const items = r.body['items'] as Array<{
      kind: string
      ok: boolean
      amount?: string
      recipient?: string
    }>
    const transfers = items.filter((i) => i.kind === 'relay_transfer')
    expect(transfers.map((t) => t.amount)).toEqual(['0.25', '1.5'])
    expect(transfers.every((t) => t.ok && t.recipient === 'recipient-1')).toBe(true)
    expect(items.some((i) => i.kind === 'relay_swap')).toBe(true)
  })
})
