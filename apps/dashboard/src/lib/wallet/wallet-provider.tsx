'use client'

import dynamic from 'next/dynamic'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { address } from '@solana/kit'
import { useConfig } from '../config-context'
import {
  connectBrowserDevSigner,
  connectServerDevSigner,
  forgetBrowserDevSigner,
} from './dev-signer'
import { partialSignerFromWire } from './signer'
import {
  connectStandardWallet,
  listStandardWallets,
  onStandardWalletsChange,
  standardOptions,
} from './wallet-standard'
import type { PhantomApi } from './phantom-island'
import type { ConnectedWallet, WalletContextValue, WalletOption } from './types'

const PhantomIsland = dynamic(() => import('./phantom-island'), { ssr: false })

const WalletContext = createContext<WalletContextValue | null>(null)

/** Remember (per tab) that a dev signer was connected, so a reload does not drop the session. */
function rememberDevSession(id: 'dev-browser' | 'dev-server' | null): void {
  try {
    if (id) window.sessionStorage.setItem('aa.wallet.dev', id)
    else window.sessionStorage.removeItem('aa.wallet.dev')
  } catch {
    // sessionStorage unavailable: the session just is not restored
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let standardVersion = 0
function subscribeStandard(listener: () => void): () => void {
  return onStandardWalletsChange(() => {
    standardVersion++
    listener()
  })
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const config = useConfig()
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phantomWanted, setPhantomWanted] = useState(false)
  const phantomApi = useRef<PhantomApi | null>(null)
  const phantomWaiters = useRef<Array<(api: PhantomApi) => void>>([])

  useSyncExternalStore(
    subscribeStandard,
    () => standardVersion,
    () => 0,
  )
  const standardList = typeof window === 'undefined' ? [] : listStandardWallets()

  const options = useMemo<WalletOption[]>(() => {
    const list: WalletOption[] = [
      {
        id: 'phantom',
        kind: 'phantom',
        label: 'Phantom',
        description: config.phantomAppId
          ? 'Phantom Connect: extension, Google or Apple login'
          : 'Phantom browser extension (set NEXT_PUBLIC_PHANTOM_APP_ID for social login)',
      },
    ]
    for (const o of standardOptions()) {
      if (o.label.toLowerCase() !== 'phantom') list.push(o)
    }
    if (config.devSigner.serverKey) {
      list.push({
        id: 'dev-server',
        kind: 'dev-server',
        label: 'Demo owner (dev signer)',
        description: 'Localnet demo owner key, kept on the server. Development only.',
        badge: 'DEV',
      })
    }
    if (config.devSigner.browserKey) {
      list.push({
        id: 'dev-browser',
        kind: 'dev-browser',
        label: 'Throwaway browser key',
        description: 'A random key in this tab (sessionStorage). Never put real funds on it.',
        badge: 'DEV',
      })
    }
    return list
    // standardList is read so the memo refreshes when wallets register.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, standardList.length])

  const onPhantomApi = useCallback((api: PhantomApi) => {
    phantomApi.current = api
    const waiters = phantomWaiters.current
    phantomWaiters.current = []
    for (const w of waiters) w(api)
  }, [])

  const onPhantomAccount = useCallback((addr: string | null) => {
    if (addr === null) {
      setWallet((w) => (w?.kind === 'phantom' ? null : w))
      return
    }
    const api = phantomApi.current
    if (!api) return
    setWallet({
      address: address(addr),
      kind: 'phantom',
      label: 'Phantom',
      signer: partialSignerFromWire(address(addr), (wire) => api.signWire(wire)),
    })
    setConnecting(false)
  }, [])

  const awaitPhantom = useCallback(
    () =>
      new Promise<PhantomApi>((resolve) => {
        if (phantomApi.current) resolve(phantomApi.current)
        else phantomWaiters.current.push(resolve)
      }),
    [],
  )

  const connect = useCallback(
    async (id: string) => {
      setError(null)
      setConnecting(true)
      try {
        if (config.fatal) throw new Error(config.fatal)
        if (id === 'dev-browser' || id === 'dev-server') {
          setWallet(
            id === 'dev-browser'
              ? await connectBrowserDevSigner(config)
              : await connectServerDevSigner(config),
          )
          rememberDevSession(id)
        } else if (id.startsWith('ws:')) setWallet(await connectStandardWallet(id, config))
        else if (id === 'phantom') {
          setPhantomWanted(true)
          const api = await awaitPhantom()
          await api.connect()
          // The account arrives through onPhantomAccount (the modal can take a while).
          return
        } else throw new Error(`Unknown wallet option ${id}`)
      } catch (e) {
        setError(errorText(e))
      }
      setConnecting(false)
    },
    [awaitPhantom, config],
  )

  const disconnect = useCallback(async () => {
    const current = wallet
    setWallet(null)
    setError(null)
    if (current?.kind === 'dev-browser') forgetBrowserDevSigner()
    rememberDevSession(null)
    if (current?.kind === 'phantom') await phantomApi.current?.disconnect()
  }, [wallet])

  // Re-open a dev session after a reload so a refresh does not lose the throwaway key's context.
  useEffect(() => {
    let id: string | null = null
    try {
      id = window.sessionStorage.getItem('aa.wallet.dev')
    } catch {
      id = null
    }
    const timer = setTimeout(() => {
      if (id === 'dev-browser' && config.devSigner.browserKey) void connect('dev-browser')
      if (id === 'dev-server' && config.devSigner.serverKey) void connect('dev-server')
    }, 0)
    return () => clearTimeout(timer)
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const value = useMemo<WalletContextValue>(
    () => ({
      status: wallet ? 'connected' : connecting ? 'connecting' : 'disconnected',
      wallet,
      error,
      options,
      isDevSigner: wallet?.kind === 'dev-browser' || wallet?.kind === 'dev-server',
      connect,
      disconnect,
    }),
    [wallet, connecting, error, options, connect, disconnect],
  )

  return (
    <WalletContext.Provider value={value}>
      {children}
      {phantomWanted ? (
        <PhantomIsland
          appId={config.phantomAppId}
          onApi={onPhantomApi}
          onAccount={onPhantomAccount}
        />
      ) : null}
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
