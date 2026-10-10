/**
 * End-to-end against a REAL local validator (not run by `pnpm test`; opt in with AA_GUARD_E2E=1).
 *
 *   AA_LOCALNET_INSTANCE=<n> scripts/localnet.sh start
 *   eval "$(AA_LOCALNET_INSTANCE=<n> scripts/localnet.sh env)"
 *   pnpm --filter @agentauth-sol/demo bootstrap
 *   pnpm --filter @agentauth-sol/guard test:e2e
 */
import { describe, expect, it } from 'vitest'
import { fetchMandate, revokeMandateIx, systemTransferIx } from '@agentauth-sol/sdk'
import { GuardRefusedError, guardSigner } from '../src'
import { SOL, rootCause, setupMandate } from '../examples/_setup'

describe.skipIf(process.env['AA_GUARD_E2E'] !== '1')('guard on a real localnet', () => {
  it('signs and books an allowed transfer, refuses an over-limit one, and the raw key bypasses', async () => {
    const { chain, programIds, owner, agent, recipient, mandate } = await setupMandate()
    const signer = guardSigner(agent, { rpc: chain.rpc, mandate, cluster: 'localnet', programIds })
    const spend = async () =>
      (await fetchMandate(chain.rpc, mandate, { programIds }))?.permissions[0]?.spendTotal

    // Allowed: lands, and the injected verify booked exactly the parsed amount.
    await chain.send(
      [systemTransferIx({ from: signer, to: recipient.address, lamports: SOL / 5n })],
      signer,
    )
    expect(await spend()).toBe(SOL / 5n)
    expect(await chain.balance(recipient.address)).toBe(SOL / 5n)

    // Refused client-side: structured error, nothing sent.
    const refused = await chain
      .send(
        [systemTransferIx({ from: signer, to: recipient.address, lamports: (SOL * 6n) / 10n })],
        signer,
      )
      .catch((e: unknown) => rootCause(e))
    expect(refused).toBeInstanceOf(GuardRefusedError)
    expect(refused).toMatchObject({ program: 'agent_auth', code: 8, name: 'PerTxExceeded' })
    expect(await spend()).toBe(SOL / 5n)
    expect(await chain.balance(recipient.address)).toBe(SOL / 5n)

    // DOCUMENTED BYPASS: the same instruction signed with the raw key lands. System transfer is not
    // gated by the mandate; only the relay (typed transfer / pinned swap) is hard enforcement.
    await chain.send(
      [systemTransferIx({ from: agent, to: recipient.address, lamports: (SOL * 6n) / 10n })],
      agent,
    )
    expect(await chain.balance(recipient.address)).toBe(SOL / 5n + (SOL * 6n) / 10n)
    expect(await spend()).toBe(SOL / 5n)

    // Live mandate: after the owner revokes it the guard fails closed (no mandate, no signature).
    await chain.send([await revokeMandateIx({ owner, agent: agent.address })], owner)
    await expect(
      chain.send([systemTransferIx({ from: signer, to: recipient.address, lamports: 1n })], signer),
    ).rejects.toThrow(/does not exist/)
  }, 60_000)
})
