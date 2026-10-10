import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
  type Transaction,
} from '@solana/kit'
import { describe, expect, it } from 'vitest'
import {
  AGENT_AUTH_PROGRAM_ID,
  AgentAuthError,
  TOKEN_PROGRAM_ID,
  approveIx,
  setComputeUnitLimitIx,
  systemTransferIx,
  transferCheckedIx,
  verifyIx,
} from '@agentauth-sol/sdk'
import { GuardRefusedError, guardSigner, type GuardReport } from '../src'
import { NOW, SOL, buildSigned, cast, noRpc } from './helpers'

async function setup(mode: 'enforce' | 'dry-run' = 'enforce', injectVerify?: boolean) {
  const c = await cast()
  const reports: GuardReport[] = []
  const wrapped = guardSigner(c.agent, {
    rpc: noRpc,
    mandate: c.mandate,
    now: () => NOW,
    mode,
    ...(injectVerify === undefined ? {} : { injectVerify }),
    onReport: (r) => reports.push(r),
  })
  return { ...c, wrapped, reports }
}

const decode = (tx: Transaction) =>
  decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes))

describe('guardSigner (Kit TransactionModifyingSigner) with transactions from the SDK builders', () => {
  it('signs an allowed transfer and prepends a verify derived from the real bytes', async () => {
    const { wrapped, agent, recipient, owner } = await setup()
    const tx = await buildSigned(wrapped, [
      setComputeUnitLimitIx(200_000),
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: SOL / 5n }),
    ])
    expect(tx.signatures[agent.address]).toBeInstanceOf(Uint8Array)
    const ixs = decode(tx).instructions
    expect(ixs).toHaveLength(3)
    const first = ixs[0]
    expect(first?.programAddress).toBe(AGENT_AUTH_PROGRAM_ID)
    const expected = verifyIx({
      mandate: await wrapped.guard.mandateAddress,
      owner: owner.address,
      agent: agent,
      targetProgram: ixs[2]!.programAddress,
      discriminator: '0200000000000000',
      amount: SOL / 5n,
    })
    expect(Array.from(first!.data ?? [])).toEqual(Array.from(expected.data))
  })

  it('refuses a transfer over the per-call cap with a structured AgentAuthError and signs nothing', async () => {
    const { wrapped, recipient } = await setup()
    const err = await buildSigned(wrapped, [
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: (SOL * 6n) / 10n }),
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuardRefusedError)
    expect(err).toBeInstanceOf(AgentAuthError)
    const e = err as GuardRefusedError
    expect(e).toMatchObject({ program: 'agent_auth', code: 8, name: 'PerTxExceeded' })
    expect(e.message).toMatch(/refused to sign/)
    expect(e.message).toMatch(/not enforcement/)
    expect(e.explain()).toMatch(/DENY .*System.*transfer amount 600000000/)
  })

  it('refuses an unknown program (default-deny) with name UNKNOWN_PROGRAM', async () => {
    const { wrapped } = await setup()
    const err = (await buildSigned(wrapped, [
      {
        programAddress: 'Vote111111111111111111111111111111111111111' as never,
        data: new Uint8Array([1]),
      },
    ]).catch((e: unknown) => e)) as GuardRefusedError
    expect(err).toBeInstanceOf(GuardRefusedError)
    expect(err).toMatchObject({ program: 'unknown', name: 'UNKNOWN_PROGRAM' })
  })

  it('refuses a Token Batch (tag 255) that hides a transfer', async () => {
    const { wrapped } = await setup()
    const batch = {
      programAddress: TOKEN_PROGRAM_ID,
      accounts: [],
      data: Uint8Array.from([255, 3, 9, 3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]),
    }
    const err = (await buildSigned(wrapped, [batch]).catch((e: unknown) => e)) as GuardRefusedError
    expect(err.name).toBe('BATCH_HIDES_INSTRUCTIONS')
  })

  it('refuses an authority-changing Approve', async () => {
    const { wrapped, recipient, owner } = await setup()
    const ix = approveIx({
      source: recipient.address,
      owner: wrapped,
      delegate: owner.address,
      amount: 5n,
    })
    const err = (await buildSigned(wrapped, [await ix]).catch(
      (e: unknown) => e,
    )) as GuardRefusedError
    expect(err).toBeInstanceOf(GuardRefusedError)
    expect(err.name).toBe('AUTHORITY_CHANGE')
  })

  it('one denied instruction refuses the whole transaction even if others are fine', async () => {
    const { wrapped, recipient } = await setup()
    const err = (await buildSigned(wrapped, [
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: 1n }),
      transferCheckedIx({
        source: recipient.address,
        mint: recipient.address,
        destination: recipient.address,
        authority: wrapped,
        amount: 401n,
        decimals: 6,
      }),
    ]).catch((e: unknown) => e)) as GuardRefusedError
    expect(err.refusals.map((r) => r.index)).toEqual([1])
  })

  it('dry-run reports but still signs the transaction unchanged', async () => {
    const { wrapped, agent, recipient, reports } = await setup('dry-run')
    const tx = await buildSigned(wrapped, [
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: SOL }),
    ])
    expect(tx.signatures[agent.address]).toBeInstanceOf(Uint8Array)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.ok).toBe(false)
    expect(decode(tx).instructions).toHaveLength(1)
  })

  it('injectVerify: false leaves the message untouched', async () => {
    const { wrapped, recipient } = await setup('enforce', false)
    const tx = await buildSigned(wrapped, [
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: 1n }),
    ])
    expect(decode(tx).instructions).toHaveLength(1)
  })

  it('evaluate() and explain() report without signing', async () => {
    const { wrapped, recipient, agent } = await setup('dry-run')
    const tx = await buildSigned(wrapped, [
      systemTransferIx({ from: wrapped, to: recipient.address, lamports: SOL }),
    ])
    const report = await wrapped.evaluate(tx)
    expect(report.ok).toBe(false)
    expect(await wrapped.explain(tx)).toMatch(/PerTxExceeded/)
    expect(report.agent).toBe(agent.address)
  })

  it('refuses a transaction it cannot decode (fail closed)', async () => {
    const { wrapped } = await setup()
    const bogus = {
      messageBytes: new Uint8Array([1, 2, 3]),
      signatures: {},
    } as unknown as Transaction
    await expect(wrapped.modifyAndSignTransactions([bogus as never])).rejects.toBeInstanceOf(
      GuardRefusedError,
    )
  })
})
