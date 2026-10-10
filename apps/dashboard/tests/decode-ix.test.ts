import { approveIx, programIds, revokeMandateIx, systemTransferIx } from '@agentauth-sol/sdk'
import { decodeInstruction } from '@/lib/decode-ix'
import { AGENT, MANDATE_ADDR, OWNER, SOURCE } from './fixtures'

const ids = programIds('localnet')

describe('decodeInstruction', () => {
  it('names core, token and system instructions from their tags', async () => {
    expect(
      decodeInstruction(await revokeMandateIx({ owner: OWNER, agent: AGENT }), ids),
    ).toMatchObject({ program: 'AgentAuth core', name: 'revoke_mandate' })
    expect(
      decodeInstruction(
        await approveIx({ source: SOURCE, owner: OWNER, mandate: MANDATE_ADDR, amount: 5n }),
        ids,
      ),
    ).toMatchObject({ program: 'SPL Token', name: 'Approve' })
    expect(
      decodeInstruction(systemTransferIx({ from: OWNER, to: AGENT, lamports: 1n }), ids),
    ).toMatchObject({ program: 'System', name: 'Transfer' })
  })

  it('marks signer and writable accounts', async () => {
    const d = decodeInstruction(
      await approveIx({ source: SOURCE, owner: OWNER, mandate: MANDATE_ADDR, amount: 5n }),
      ids,
    )
    expect(d.accounts[0]).toMatchObject({ address: SOURCE, writable: true, signer: false })
    expect(d.accounts.some((a) => a.address === OWNER && a.signer)).toBe(true)
    expect(d.dataHex).toMatch(/^04/)
  })

  it('falls back to the raw tag for unknown instructions', async () => {
    const unknown = decodeInstruction(
      { programAddress: AGENT, accounts: [], data: Uint8Array.from([9]) },
      ids,
    )
    expect(unknown).toMatchObject({ program: AGENT, name: 'tag 9' })
  })
})
