'use client'

import { useEffect } from 'react'
import {
  AddressType,
  PhantomProvider,
  useAccounts,
  useConnect,
  useDisconnect,
  useModal,
  useSolana,
  usePhantom,
} from '@phantom/react-sdk'
import { getTransactionDecoder } from '@solana/kit'

/** What the wallet provider needs from Phantom Connect, without leaking the SDK into the rest of the app. */
export interface PhantomApi {
  /** Open the connect flow (modal when an app id is configured, otherwise the extension). */
  readonly connect: () => Promise<void>
  readonly disconnect: () => Promise<void>
  readonly signWire: (wire: Uint8Array) => Promise<Uint8Array>
}

export interface PhantomIslandProps {
  readonly appId: string | null
  readonly onApi: (api: PhantomApi) => void
  readonly onAccount: (address: string | null) => void
}

type SignedLike = Uint8Array | { serialize: (opts?: unknown) => Uint8Array }

function signedToBytes(signed: SignedLike): Uint8Array {
  if (signed instanceof Uint8Array) return signed
  // web3.js Transaction needs the options to serialize a partially signed legacy transaction.
  return signed.serialize({ requireAllSignatures: false, verifySignatures: false })
}

function Bridge({ appId, onApi, onAccount }: PhantomIslandProps) {
  const { connect } = useConnect()
  const { disconnect } = useDisconnect()
  const modal = useModal()
  const { solana } = useSolana()
  const accounts = useAccounts()
  const { isConnected } = usePhantom()

  const solAddress = accounts?.find((a) => a.addressType === AddressType.solana)?.address ?? null
  useEffect(() => {
    onAccount(isConnected ? solAddress : null)
  }, [isConnected, solAddress, onAccount])

  useEffect(() => {
    onApi({
      connect: async () => {
        if (appId) modal.open()
        else await connect({ provider: 'injected' })
      },
      disconnect: async () => {
        await disconnect()
      },
      signWire: async (wire) => {
        const decoded = getTransactionDecoder().decode(wire)
        // Phantom accepts a Kit transaction; its type declarations only name web3.js types.
        const signed = await solana.signTransaction(decoded as never)
        return signedToBytes(signed as unknown as SignedLike)
      },
    })
  }, [appId, connect, disconnect, modal, onApi, solana])
  return null
}

/** Phantom Connect (embedded wallet + extension). Loaded lazily, only when somebody picks Phantom. */
export default function PhantomIsland(props: PhantomIslandProps) {
  return (
    <PhantomProvider
      config={{
        providers: props.appId ? ['google', 'apple', 'injected'] : ['injected'],
        addressTypes: [AddressType.solana],
        ...(props.appId ? { appId: props.appId } : {}),
      }}
      appName="AgentAuth Mandate Studio"
    >
      <Bridge {...props} />
    </PhantomProvider>
  )
}
