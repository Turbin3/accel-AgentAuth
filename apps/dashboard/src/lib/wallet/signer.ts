import {
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
} from '@solana/kit'

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Wrap any "sign these wire bytes" function (a wallet, a dev endpoint) as a Kit partial signer.
 *
 * The returned signature is only accepted when the wallet signed exactly the message we sent. A
 * wallet that rewrites the transaction (for example by adding a guard instruction) would produce a
 * signature that is not valid for the transaction the SDK sends, so we refuse with a clear message
 * instead of failing later with an opaque "signature verification failure".
 */
export function partialSignerFromWire(
  address: Address,
  signWire: (wire: Uint8Array) => Promise<Uint8Array>,
): TransactionPartialSigner {
  const encoder = getTransactionEncoder()
  const decoder = getTransactionDecoder()
  return {
    address,
    signTransactions: async (transactions: readonly Transaction[]) =>
      Promise.all(
        transactions.map(async (tx) => {
          const signedWire = await signWire(new Uint8Array(encoder.encode(tx)))
          const signed = decoder.decode(signedWire)
          if (!sameBytes(signed.messageBytes, tx.messageBytes)) {
            throw new Error(
              'The wallet changed the transaction before signing (for example by adding a guard instruction). ' +
                'Its signature would not match the transaction we send, so nothing was sent.',
            )
          }
          const signature = signed.signatures[address]
          if (!signature) throw new Error('The wallet did not return a signature for your address.')
          return Object.freeze({ [address]: signature as SignatureBytes })
        }),
      ),
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
