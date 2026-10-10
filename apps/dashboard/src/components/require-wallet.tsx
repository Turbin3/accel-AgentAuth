'use client'

import { useState, type ReactNode } from 'react'
import { useWallet } from '@/lib/wallet/wallet-provider'
import type { ConnectedWallet } from '@/lib/wallet/types'
import { ConnectDialog } from './shell'
import { Button, EmptyState } from './ui'

/** Renders children with the connected wallet, or an honest empty state with a connect action. */
export function RequireWallet({
  children,
  why,
}: {
  children: (wallet: ConnectedWallet) => ReactNode
  why: string
}) {
  const { wallet, status } = useWallet()
  const [open, setOpen] = useState(false)
  if (wallet) return <>{children(wallet)}</>
  return (
    <>
      <EmptyState
        title="Connect a wallet to continue"
        action={
          <Button
            variant="primary"
            onClick={() => setOpen(true)}
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? 'Connecting...' : 'Connect wallet'}
          </Button>
        }
      >
        <p>{why}</p>
      </EmptyState>
      <ConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
