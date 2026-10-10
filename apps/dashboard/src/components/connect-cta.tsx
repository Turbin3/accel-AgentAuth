'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useWallet } from '@/lib/wallet/wallet-provider'
import { ConnectDialog } from './shell'
import { Button } from './ui'

export function ConnectCta() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  if (wallet.status === 'connected') {
    return (
      <>
        <Link
          href="/mandates"
          className="inline-flex min-h-10 items-center rounded-lg border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-ink no-underline"
        >
          Open my mandates
        </Link>
        <Link
          href="/mandates/new"
          className="inline-flex min-h-10 items-center rounded-lg border border-line-strong px-4 py-2 text-sm font-medium no-underline hover:bg-surface-2"
        >
          Create a mandate
        </Link>
      </>
    )
  }
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} data-testid="connect-cta">
        Connect a wallet
      </Button>
      <ConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
