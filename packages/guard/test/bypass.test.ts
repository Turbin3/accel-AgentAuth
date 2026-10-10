import type { TransactionSigner } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { guardSigner } from '../src'
import { NOW, SOL, buildSigned, cast, noRpc } from './helpers'
import { systemTransferIx } from '@agentauth-sol/sdk'

/**
 * DOCUMENTED BYPASS. The guard is a cooperative client-side check. This test exists so nobody
 * mistakes it for enforcement: the raw key signs the very transaction the guard refuses.
 * Hard enforcement is the AgentAuth relay (typed transfer and pinned swap).
 */
describe('bypass: the raw signer still signs what the guard refuses', () => {
  it('guarded signer refuses, raw signer signs the identical instructions', async () => {
    const { agent, recipient, mandate } = await cast()
    const guarded = guardSigner(agent, { rpc: noRpc, mandate, now: () => NOW })
    const overLimit = (s: TransactionSigner) => [
      systemTransferIx({ from: s, to: recipient.address, lamports: 5n * SOL }),
    ]

    await expect(buildSigned(guarded, overLimit(guarded))).rejects.toThrow(/refused to sign/)

    const signed = await buildSigned(agent, overLimit(agent))
    expect(signed.signatures[agent.address]).toBeInstanceOf(Uint8Array)
  })
})
