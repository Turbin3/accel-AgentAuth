import http from 'node:http'
import { generateKeyPairSigner } from '@solana/kit'
import { x402Client } from '@x402/core/client'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { describe, expect, it } from 'vitest'
import { TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC } from '@agentauth-sol/sdk'
import { agentAuthX402Hook, createGuard } from '../src'
import { NOW, cast, noRpc, permission } from './helpers'

const PAYTO = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ctxFor = (amount: string) => ({
  selectedRequirements: {
    amount,
    asset: USDC,
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    payTo: PAYTO,
  },
})

async function hook() {
  const { mandate } = await cast({
    permissions: [
      permission(0, TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC, {
        spendLimit: 3_000_000n,
        perTxLimit: 1_000_000n,
      }),
    ],
  })
  return agentAuthX402Hook({ guard: createGuard({ rpc: noRpc, mandate, now: () => NOW }) })
}

describe('agentAuthX402Hook (x402 onBeforePaymentCreation)', () => {
  it('lets a payment inside the mandate through', async () => {
    expect(await (await hook())(ctxFor('900000'))).toBeUndefined()
  })

  it('aborts a payment over the per-call cap with the mandate reason', async () => {
    const result = await (await hook())(ctxFor('2500000'))
    expect(result).toMatchObject({ abort: true })
    expect(result && result.reason).toMatch(/PerTxExceeded/)
    expect(result && result.reason).toMatch(/cooperative client-side/)
  })

  it('fails closed on a malformed amount', async () => {
    expect(await (await hook())(ctxFor('1e6'))).toMatchObject({ abort: true })
  })

  it('aborts inside a real x402Client before anything is signed', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'http://127.0.0.1/paid', description: 'demo', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: '2500000',
          asset: USDC,
          payTo: PAYTO,
          maxTimeoutSeconds: 60,
          extra: { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' },
        },
      ],
    }
    const server = http.createServer((_req, res) => {
      res.writeHead(402, {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      })
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const signer = await generateKeyPairSigner() // throwaway; the hook aborts before it is used
    let signed = false
    const client = new x402Client()
      .setSpendControls({ maxAmountPerPayment: '$10' }) // x402 default "$1" would trip first
      .register('solana:*', new ExactSvmScheme(signer))
      .onBeforePaymentCreation(await hook())
      .onAfterPaymentCreation(async () => {
        signed = true
      })
    try {
      await expect(
        wrapFetchWithPayment(fetch, client)(`http://127.0.0.1:${port}/paid`),
      ).rejects.toThrow(/PerTxExceeded|AgentAuth guard/)
      expect(signed).toBe(false)
    } finally {
      server.close()
    }
  })
})
