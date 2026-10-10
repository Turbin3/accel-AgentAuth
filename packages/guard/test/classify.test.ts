import { address, type Address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import {
  AGENT_AUTH_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  programIds,
} from '@agentauth-sol/sdk'
import { classifyInstruction } from '../src'

const ctx = { programIds: programIds('devnet'), allowPrograms: new Set<string>() }
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const run = (programAddress: Address, data: string) =>
  classifyInstruction({ programAddress, data: hex(data) }, ctx)

// Golden raw instruction data from the integration playbook (amount 1_000_000 = 40420f0000000000).
describe('classifyInstruction: decoded instruction fixtures', () => {
  it('System Transfer: canonical disc8 and amount come from the bytes', () => {
    const c = run(SYSTEM_PROGRAM_ID, '0200000040420f0000000000')
    expect(c).toMatchObject({ kind: 'mandate', disc8: '0200000000000000', amount: 1_000_000n })
  })

  it('Token Transfer and TransferChecked', () => {
    expect(run(TOKEN_PROGRAM_ID, '0340420f0000000000')).toMatchObject({
      kind: 'mandate',
      disc8: '0300000000000000',
      amount: 1_000_000n,
    })
    expect(run(TOKEN_PROGRAM_ID, '0c40420f000000000006')).toMatchObject({
      kind: 'mandate',
      disc8: '0c00000000000000',
      amount: 1_000_000n,
    })
  })

  it('Token-2022 TransferChecked', () => {
    expect(run(TOKEN_2022_PROGRAM_ID, '0c40420f000000000006')).toMatchObject({
      kind: 'mandate',
      amount: 1_000_000n,
    })
  })

  it('ComputeBudget and Memo are ambient', () => {
    expect(run(COMPUTE_BUDGET_PROGRAM_ID, '02400d0300').kind).toBe('ambient')
    expect(run(COMPUTE_BUDGET_PROGRAM_ID, '038813000000000000').kind).toBe('ambient')
    expect(run(address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), '68690a').kind).toBe(
      'ambient',
    )
  })

  it.each([
    ['Approve', TOKEN_PROGRAM_ID, '0440420f0000000000', 'AUTHORITY_CHANGE'],
    ['ApproveChecked', TOKEN_PROGRAM_ID, '0d40420f000000000006', 'AUTHORITY_CHANGE'],
    ['Revoke', TOKEN_PROGRAM_ID, '05', 'AUTHORITY_CHANGE'],
    ['SetAuthority owner', TOKEN_PROGRAM_ID, '060201' + '11'.repeat(32), 'AUTHORITY_CHANGE'],
    ['SetAuthority to None', TOKEN_PROGRAM_ID, '060300', 'AUTHORITY_CHANGE'],
    ['CloseAccount', TOKEN_PROGRAM_ID, '09', 'AUTHORITY_CHANGE'],
    ['Token-2022 SetAuthority', TOKEN_2022_PROGRAM_ID, '060300', 'AUTHORITY_CHANGE'],
    ['System Assign', SYSTEM_PROGRAM_ID, '01000000' + '22'.repeat(32), 'AUTHORITY_CHANGE'],
  ])('%s is default-denied as an authority change', (_n, program, data, code) => {
    const c = run(program, data)
    expect(c.kind).toBe('refused')
    expect(c.code).toBe(code)
  })

  it('Token and Token-2022 Batch (tag 255) are refused: it hides inner instructions', () => {
    // A Batch wrapping a Transfer record: [n_accounts][data_len][tag][data...]
    const inner = 'ff' + '03' + '09' + '03' + '40420f0000000000'
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const c = run(program, inner)
      expect(c).toMatchObject({ kind: 'refused', code: 'BATCH_HIDES_INSTRUCTIONS' })
    }
  })

  it('an unknown program is refused', () => {
    const c = run(address('Vote111111111111111111111111111111111111111'), '00')
    expect(c).toMatchObject({ kind: 'refused', code: 'UNKNOWN_PROGRAM' })
  })

  it('a known program with an unknown instruction is refused', () => {
    expect(run(TOKEN_PROGRAM_ID, '63')).toMatchObject({
      kind: 'refused',
      code: 'UNKNOWN_INSTRUCTION',
    })
  })

  it('a truncated amount is refused, not treated as zero', () => {
    expect(run(SYSTEM_PROGRAM_ID, '020000004042')).toMatchObject({
      kind: 'refused',
      code: 'AMOUNT_UNPARSEABLE',
    })
  })

  it('AgentAuth: own verify passes through, owner instructions are refused for an agent', () => {
    expect(run(AGENT_AUTH_PROGRAM_ID, '03' + '00'.repeat(48)).kind).toBe('verify')
    expect(run(AGENT_AUTH_PROGRAM_ID, '04')).toMatchObject({
      kind: 'refused',
      code: 'AGENTAUTH_ADMIN',
    })
  })

  it('relay instructions are labelled as enforced by the relay', () => {
    const c = run(RELAY_PROGRAM_ID, '00')
    expect(c.kind).toBe('relay')
    expect(c.reason).toMatch(/relay/i)
  })

  it('caller allow list makes a program ambient', () => {
    const vote = address('Vote111111111111111111111111111111111111111')
    const c = classifyInstruction(
      { programAddress: vote, data: hex('00') },
      { programIds: ctx.programIds, allowPrograms: new Set([vote]) },
    )
    expect(c.kind).toBe('ambient')
  })
})
