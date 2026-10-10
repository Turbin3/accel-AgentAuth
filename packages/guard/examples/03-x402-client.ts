/**
 * Example 3: an x402 client whose `onBeforePaymentCreation` hook refuses payments the mandate would
 * deny. A local fake 402 server asks for 2.5 USDC; the mandate allows at most 1 per call.
 *
 *   pnpm --filter @agentauth-sol/guard exec tsx examples/03-x402-client.ts
 *
 * Honest limits: x402's own spend controls (default "$1") run BEFORE this hook, the hook CHECKS but
 * does not book spend, and a mandate permission is per program, not per mint. COOPERATIVE
 * CLIENT-SIDE GUARD, NOT ENFORCEMENT: the relay is the enforcement tier. The allowed case is shown
 * by calling the hook directly: completing a real payment needs a USDC mint and a facilitator,
 * which the local validator does not have.
 */
import http from 'node:http'
import { generateKeyPairSigner } from '@solana/kit'
import { x402Client } from '@x402/core/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { agentAuthX402Hook, createGuard } from '../src'
import { setupMandate } from './_setup'

const { chain, programIds, mandate } = await setupMandate()
const guard = createGuard({ rpc: chain.rpc, mandate, cluster: 'localnet', programIds })
const hook = agentAuthX402Hook({ guard })

const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PAY_TO = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4'

const required = {
  x402Version: 2,
  resource: { url: 'http://127.0.0.1/paid', description: 'demo', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK,
      amount: '2500000',
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' },
    },
  ],
}
const server = http.createServer((_req, res) => {
  res.writeHead(402, {
    'content-type': 'application/json',
    'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64'),
  })
  res.end('{}')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port

const throwaway = await generateKeyPairSigner() // never used: the hook aborts first
const client = new x402Client()
  .setSpendControls({ maxAmountPerPayment: '$10' }) // x402 default "$1" would trip before our hook
  .register('solana:*', new ExactSvmScheme(throwaway))
  .onBeforePaymentCreation(hook)

try {
  await wrapFetchWithPayment(fetch, client)(`http://127.0.0.1:${port}/paid`)
  console.log('UNEXPECTED: the payment went ahead')
} catch (error) {
  console.log(
    `2.5 USDC request aborted before signing: ${error instanceof Error ? error.message : String(error)}`,
  )
}
server.close()

const ok = await hook({
  selectedRequirements: { amount: '900000', asset: USDC, network: NETWORK, payTo: PAY_TO },
})
console.log(
  `0.9 USDC request: hook says ${ok === undefined ? 'allowed (x402 would now build and sign the payment)' : `abort: ${ok.reason}`}`,
)
console.log('Reminder: cooperative client-side guard; the relay is the enforcement tier.')
