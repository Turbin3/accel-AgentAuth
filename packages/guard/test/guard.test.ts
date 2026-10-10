import { describe, expect, it } from 'vitest'
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  systemTransferIx,
  transferCheckedIx,
  setComputeUnitLimitIx,
} from '@agentauth-sol/sdk'
import { createGuard, explainReport } from '../src'
import { NOW, SOL, cast, noRpc } from './helpers'

async function setup(over = {}) {
  const c = await cast(over)
  const guard = createGuard({ rpc: noRpc, mandate: c.mandate, now: () => NOW })
  return { ...c, guard }
}

describe('Guard.evaluateInstructions against the mandate (checkVerify mirror)', () => {
  it('allows a transfer inside the limits and reports remaining budget', async () => {
    const { guard, agent, recipient } = await setup()
    const r = await guard.evaluateInstructions([
      setComputeUnitLimitIx(200_000),
      systemTransferIx({ from: agent.address, to: recipient.address, lamports: SOL / 5n }),
    ])
    expect(r.ok).toBe(true)
    expect(r.verdicts.map((v) => v.kind)).toEqual(['ambient', 'mandate'])
    expect(r.verdicts[1]?.verify?.remainingSpend).toBe((SOL * 4n) / 5n)
    expect(r.disclaimer).toMatch(/not enforcement/i)
  })

  it('denies over the per-call cap with AgentAuth 8 PerTxExceeded', async () => {
    const { guard, agent, recipient } = await setup()
    const r = await guard.evaluateInstructions([
      systemTransferIx({ from: agent.address, to: recipient.address, lamports: (SOL * 6n) / 10n }),
    ])
    expect(r.ok).toBe(false)
    expect(r.refusals[0]?.code).toBe('MANDATE_DENIED')
    expect(r.refusals[0]?.failure).toMatchObject({
      program: 'agent_auth',
      code: 8,
      name: 'PerTxExceeded',
    })
  })

  it('accumulates spend across instructions of one transaction (lifetime cap, code 9)', async () => {
    const { guard, agent, recipient } = await setup()
    const ix = systemTransferIx({ from: agent.address, to: recipient.address, lamports: SOL / 2n })
    const r = await guard.evaluateInstructions([ix, ix, ix])
    expect(r.verdicts.map((v) => v.allowed)).toEqual([true, true, false])
    expect(r.refusals[0]?.failure).toMatchObject({ code: 9, name: 'SpendLimitExceeded' })
  })

  it('denies when the mandate is expired or paused', async () => {
    const expired = await setup({ expiry: NOW - 1n })
    const ix = systemTransferIx({
      from: expired.agent.address,
      to: expired.recipient.address,
      lamports: 1n,
    })
    expect((await expired.guard.evaluateInstructions([ix])).refusals[0]?.failure?.code).toBe(5)
    const paused = await setup({ active: false })
    expect((await paused.guard.evaluateInstructions([ix])).refusals[0]?.failure?.code).toBe(4)
  })

  it('denies a program with no permission (code 6) and a token transfer over its cap', async () => {
    const { guard, agent, recipient } = await setup({ permissions: [] })
    const sys = systemTransferIx({ from: agent.address, to: recipient.address, lamports: 1n })
    expect((await guard.evaluateInstructions([sys])).refusals[0]?.failure?.code).toBe(6)

    const full = await setup()
    const tok = transferCheckedIx({
      source: full.recipient.address,
      mint: full.owner.address,
      destination: full.recipient.address,
      authority: full.agent.address,
      amount: 500n,
      decimals: 6,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    const r = await full.guard.evaluateInstructions([tok])
    expect(r.refusals[0]?.failure).toMatchObject({ code: 8 })
  })

  it('denies a signer that is not the mandate agent (code 17)', async () => {
    const { guard, recipient, owner } = await setup()
    const ix = systemTransferIx({ from: owner.address, to: recipient.address, lamports: 1n })
    const r = await guard.evaluateInstructions([ix], { signer: recipient.address })
    expect(r.refusals[0]?.failure?.code).toBe(17)
  })

  it('does not decide on the amount the agent reports: it parses the bytes', async () => {
    const { guard, agent, recipient } = await setup()
    const ix = systemTransferIx({ from: agent.address, to: recipient.address, lamports: 7n })
    const r = await guard.evaluateInstructions([ix])
    expect(r.verdicts[0]?.amount).toBe(7n)
    expect(r.verdicts[0]?.programId).toBe(SYSTEM_PROGRAM_ID)
  })

  it('explainReport lists every instruction and the honesty footer', async () => {
    const { guard, agent, recipient } = await setup()
    const r = await guard.evaluateInstructions([
      systemTransferIx({ from: agent.address, to: recipient.address, lamports: SOL }),
    ])
    const text = explainReport(r)
    expect(text).toMatch(/^Refused: 1 of 1/)
    expect(text).toMatch(/PerTxExceeded/)
    expect(text).toMatch(/not enforcement/i)
  })
})
