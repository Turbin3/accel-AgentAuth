import { TOKEN_PROGRAM_ID } from '@agentauth-sol/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentSession,
  balanceOf,
  call,
  createFixture,
  ownerPause,
  ownerRevokeMandate,
  requireE2e,
  type Fixture,
} from '../support/fixture'

type Session = Awaited<ReturnType<typeof agentSession>>

/**
 * Every denial path, each twice: with the SDK pre-flight stopping the call before anything is
 * sent (default), and with `--land-denied` where the transaction goes to the chain and the
 * decoded on-chain error must be the same. The pre-flight mirror and the programs must agree.
 */
describe.skipIf(!requireE2e()).each([
  { mode: 'pre-flight (default)', landDenied: false },
  { mode: 'landed on chain (--land-denied)', landDenied: true },
])('agent denials: $mode', ({ landDenied }) => {
  let fx: Fixture
  let s: Session
  const stage = landDenied ? 'onchain' : 'preflight'
  let n = 0
  const key = () => `denial-${landDenied ? 'c' : 'p'}-${String(++n).padStart(4, '0')}`

  beforeAll(async () => {
    // AgentAuth is the binding cap (allowance 50 > lifetime 3), so 8 and 9 are reachable.
    fx = await createFixture({ perCall: '2', lifetime: '3', delegateCap: '50' })
    s = await agentSession(fx, { landDenied })
  })
  afterAll(async () => {
    await s.close()
    fx.cleanup()
  })

  const expectDenied = (
    r: Awaited<ReturnType<typeof call>>,
    program: string,
    code: number,
    name: string,
  ) => {
    expect(r.isError).toBe(true)
    expect(r.body).toMatchObject({
      ok: false,
      denied: true,
      stage,
      program,
      code,
      name,
      can_retry: false,
    })
    expect(String(r.body['guidance'])).toMatch(/Do not retry with a different recipient/)
    if (landDenied) expect(typeof r.body['signature']).toBe('string')
  }

  it('wrong recipient: relay 104 RecipientNotAllowed, nothing moves', async () => {
    const before = await balanceOf(fx, fx.attacker)
    const r = await call(s.client, 'agentauth_pay', {
      recipient: fx.attacker,
      amount: '1',
      idempotency_key: key(),
    })
    expectDenied(r, 'relay', 104, 'RecipientNotAllowed')
    expect(await balanceOf(fx, fx.attacker)).toBe(before)
  })

  it('over the per-call cap: AgentAuth 8 PerTxExceeded', async () => {
    const r = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '2.5',
      idempotency_key: key(),
    })
    expectDenied(r, 'agent_auth', 8, 'PerTxExceeded')
  })

  it('over the lifetime budget: AgentAuth 9 SpendLimitExceeded', async () => {
    const first = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '2',
      idempotency_key: key(),
    })
    expect(first.body['ok']).toBe(true)
    const before = await balanceOf(fx, fx.allowed)
    const r = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '1.5',
      idempotency_key: key(),
    })
    expectDenied(r, 'agent_auth', 9, 'SpendLimitExceeded')
    expect(await balanceOf(fx, fx.allowed)).toBe(before)
  })

  it('paused by the owner: relay 116 Paused, and payments work again after resume', async () => {
    await ownerPause(fx, true)
    const r = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.5',
      idempotency_key: key(),
    })
    expectDenied(r, 'relay', 116, 'Paused')
    const status = await call(s.client, 'agentauth_status')
    expect(status.body).toMatchObject({ mandate: { status: 'paused', relay_paused: true } })
    await ownerPause(fx, false)
    const again = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.5',
      idempotency_key: key(),
    })
    expect(again.body['ok']).toBe(true)
  })

  it('a removed or narrowed permission: AgentAuth 7 DiscriminatorNotAllowed, then 6 ProgramNotAllowed', async () => {
    // Narrow the Token slot to the legacy unchecked Transfer only: TransferChecked is no longer listed.
    const narrow = await fx.client.plan.revokePermission({
      owner: fx.owner,
      agent: fx.agent.address,
      program: TOKEN_PROGRAM_ID,
      replaceWith: { discriminators: ['0300000000000000'] },
      allowWiden: true,
    })
    for (const step of narrow.steps) await fx.chain.send(step.instructions, fx.owner)
    const seven = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.1',
      idempotency_key: key(),
    })
    expectDenied(seven, 'agent_auth', 7, 'DiscriminatorNotAllowed')

    const remove = await fx.client.plan.revokePermission({
      owner: fx.owner,
      agent: fx.agent.address,
      program: TOKEN_PROGRAM_ID,
    })
    for (const step of remove.steps) await fx.chain.send(step.instructions, fx.owner)
    const six = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.1',
      idempotency_key: key(),
    })
    expectDenied(six, 'agent_auth', 6, 'ProgramNotAllowed')
    // the swap permission was not touched
    const swap = await call(s.client, 'agentauth_check_action', { action: 'swap', amount: '0.5' })
    expect(swap.body['would_be_allowed']).toBe(true)
  })

  it('revoked mandate: relay 117 InvalidMandate', async () => {
    await ownerRevokeMandate(fx)
    const r = await call(s.client, 'agentauth_pay', {
      recipient: 'recipient-1',
      amount: '0.1',
      idempotency_key: key(),
    })
    expectDenied(r, 'relay', 117, 'InvalidMandate')
    const status = await call(s.client, 'agentauth_status')
    expect(status.body).toMatchObject({ mandate: { status: 'not_found' } })
    expect(String(status.body['note'])).toMatch(/Nothing is authorised/)
  })
})
