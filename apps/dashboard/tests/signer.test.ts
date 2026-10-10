import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Transaction,
} from '@solana/kit'
import { partialSignerFromWire, fromBase64, toBase64 } from '@/lib/wallet/signer'
import { systemTransferIx } from '@agentauth-sol/sdk'

async function sampleTransaction(
  feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  lamports: bigint,
) {
  const ix = systemTransferIx({ from: feePayer, to: feePayer.address, lamports })
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(feePayer.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstruction(ix, m),
  )
  return compileTransaction(message)
}

describe('partialSignerFromWire', () => {
  it('returns the wallet signature for the message that was sent', async () => {
    const key = await generateKeyPairSigner()
    const tx = await sampleTransaction(key, 1n)
    const wallet = partialSignerFromWire(key.address, async (wire) => {
      const { getTransactionDecoder } = await import('@solana/kit')
      const decoded = getTransactionDecoder().decode(wire)
      const [sig] = await key.signTransactions([decoded as never])
      return new Uint8Array(
        getTransactionEncoder().encode({
          ...decoded,
          signatures: { ...decoded.signatures, ...sig },
        } as Transaction),
      )
    })
    const [dict] = await wallet.signTransactions([tx as never])
    expect(dict?.[key.address]).toBeDefined()
    expect(dict?.[key.address]).toHaveLength(64)
  })

  it('refuses a wallet that changed the transaction', async () => {
    const key = await generateKeyPairSigner()
    const tx = await sampleTransaction(key, 1n)
    const other = await sampleTransaction(key, 2n)
    const wallet = partialSignerFromWire(
      key.address,
      async () => new Uint8Array(getTransactionEncoder().encode(other)),
    )
    await expect(wallet.signTransactions([tx as never])).rejects.toThrow(/changed the transaction/)
  })

  it('refuses a wallet that returns no signature for our address', async () => {
    const key = await generateKeyPairSigner()
    const tx = await sampleTransaction(key, 1n)
    const wallet = partialSignerFromWire(key.address, async (wire) => wire)
    // Unsigned slot: the decoded signature is null, so there is nothing to use.
    await expect(wallet.signTransactions([tx as never])).rejects.toThrow(
      /did not return a signature/,
    )
  })
})

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255])
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  })
})
