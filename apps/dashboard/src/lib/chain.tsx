'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createClient, type Client } from '@agentauth-sol/sdk'
import { useConfig } from './config-context'
import { makeRegistry, type RegistryData } from './registry-data'

interface ChainContextValue {
  readonly client: Client
  readonly registryData: RegistryData
}

const ChainContext = createContext<ChainContextValue | null>(null)

export function ChainProvider({
  registryData,
  children,
}: {
  registryData: RegistryData
  children: ReactNode
}) {
  const config = useConfig()
  const value = useMemo<ChainContextValue>(() => {
    const client = createClient({
      cluster: config.cluster,
      rpcUrl: config.rpcUrl,
      registry: makeRegistry(registryData),
      commitment: 'confirmed',
    })
    return { client, registryData }
  }, [config.cluster, config.rpcUrl, registryData])
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>
}

export function useChain(): ChainContextValue {
  const ctx = useContext(ChainContext)
  if (!ctx) throw new Error('useChain must be used inside <ChainProvider>')
  return ctx
}

export function useClient(): Client {
  return useChain().client
}
