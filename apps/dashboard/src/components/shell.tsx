'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { clusterLabel } from '@/lib/config'
import { useConfig } from '@/lib/config-context'
import { useWallet } from '@/lib/wallet/wallet-provider'
import { AddressText } from './address'
import { Button, Chip, Dialog, ErrorBox } from './ui'

const LINKS = [
  { href: '/mandates', label: 'Mandates' },
  { href: '/mandates/new', label: 'New mandate' },
  { href: '/simulator', label: 'Try to break it' },
  { href: '/registry', label: 'Registry' },
  { href: '/docs', label: 'Docs' },
]

type Theme = 'system' | 'light' | 'dark'

// The theme lives in localStorage and on <html data-theme>. A tiny external store keeps React in sync.
const themeListeners = new Set<() => void>()
function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem('aa.theme')
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}
function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}
function applyTheme(next: Theme): void {
  const root = document.documentElement
  if (next === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', next)
  try {
    if (next === 'system') window.localStorage.removeItem('aa.theme')
    else window.localStorage.setItem('aa.theme', next)
  } catch {
    // not persisted; still applied for this page
  }
  themeListeners.forEach((l) => l())
}

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'system' as Theme)
  const order: Theme[] = ['system', 'light', 'dark']
  const next = order[(order.indexOf(theme) + 1) % order.length] as Theme
  return (
    <Button
      variant="ghost"
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      onClick={() => applyTheme(next)}
    >
      <span aria-hidden="true">
        {theme === 'dark' ? '\u263E' : theme === 'light' ? '\u2600' : '\u25D1'}
      </span>
      <span className="text-xs">{theme}</span>
    </Button>
  )
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet()
  const config = useConfig()
  useEffect(() => {
    if (wallet.status === 'connected' && open) onClose()
  }, [wallet.status, open, onClose])
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a wallet"
      description={`You sign every change yourself. The dashboard never holds your keys. Cluster: ${clusterLabel(config.cluster)}.`}
    >
      <ul className="space-y-2">
        {wallet.options.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              disabled={wallet.status === 'connecting'}
              onClick={() => void wallet.connect(o.id)}
              data-testid={`connect-${o.id}`}
              className="flex w-full items-start gap-3 rounded-lg border border-line-strong bg-surface p-3 text-left hover:bg-surface-2 disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {o.label}
                  {o.badge ? (
                    <Chip tone="warn" mark={false}>
                      {o.badge}
                    </Chip>
                  ) : null}
                </span>
                <span className="block text-xs text-muted">{o.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {wallet.status === 'connecting' ? (
        <p className="mt-3 text-sm text-muted" role="status">
          Waiting for the wallet...
        </p>
      ) : null}
      {wallet.error ? (
        <div className="mt-3">
          <ErrorBox error={{ title: 'Could not connect', detail: wallet.error }} />
        </div>
      ) : null}
    </Dialog>
  )
}

export function WalletButton() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  if (wallet.status === 'connected' && wallet.wallet) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline" data-testid="wallet-address">
          <AddressText value={wallet.wallet.address} />
        </span>
        <Button variant="secondary" onClick={() => void wallet.disconnect()}>
          Disconnect
        </Button>
      </div>
    )
  }
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} data-testid="connect-button">
        Connect wallet
      </Button>
      <ConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

export function Header() {
  const pathname = usePathname()
  const config = useConfig()
  const [menu, setMenu] = useState(false)
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold no-underline">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs text-accent-ink"
          >
            AA
          </span>
          <span>Mandate Studio</span>
        </Link>
        <Chip
          tone={config.cluster === 'localnet' ? 'neutral' : 'neutral'}
          mark={false}
          title="Cluster this dashboard reads and writes"
        >
          {clusterLabel(config.cluster)}
        </Chip>
        <button
          type="button"
          className="ml-auto rounded-lg border border-line-strong px-3 py-2 text-sm md:hidden"
          aria-expanded={menu}
          aria-controls="main-nav"
          onClick={() => setMenu((m) => !m)}
        >
          Menu
        </button>
        <nav
          id="main-nav"
          aria-label="Main"
          className={`${menu ? 'flex' : 'hidden'} w-full flex-col gap-1 md:ml-2 md:flex md:w-auto md:flex-row md:items-center`}
        >
          {LINKS.map((l) => {
            const active =
              l.href === '/mandates'
                ? pathname === '/mandates' ||
                  (pathname.startsWith('/mandates/') && pathname !== '/mandates/new')
                : pathname === l.href
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMenu(false)}
                className={`rounded-md px-3 py-2 text-sm no-underline hover:bg-surface-2 ${active ? 'bg-surface-2 font-semibold' : 'text-muted'}`}
              >
                {l.label}
              </Link>
            )
          })}
        </nav>
        <div
          className={`${menu ? 'flex' : 'hidden'} w-full items-center gap-2 md:ml-auto md:flex md:w-auto`}
        >
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  )
}

/** Always visible, on every page. The honesty contract in one line. */
export function HonestyStrip() {
  return (
    <div role="note" className="border-b border-warn/40 bg-warn-bg">
      <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-ink sm:px-6">
        <strong className="text-warn">Unaudited devnet prototype.</strong> Hard enforcement exists
        only for the relay transfer and the pinned swap; everything else a mandate lists is
        advisory. Do not put funds behind it that you cannot lose.
      </p>
    </div>
  )
}

/** Shown while a dev signer is active, so a demo can never be mistaken for a real wallet session. */
export function DevSignerBanner() {
  const wallet = useWallet()
  if (!wallet.isDevSigner) return null
  return (
    <div role="status" data-testid="dev-banner" className="border-b border-bad/50 bg-bad-bg">
      <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-ink sm:px-6">
        <strong className="text-bad">DEV SIGNER ACTIVE.</strong> You are signing with a throwaway or
        demo key, not a real wallet. This exists for local demos and automated tests and is
        impossible to enable on mainnet.
      </p>
    </div>
  )
}

export function Footer() {
  const config = useConfig()
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted sm:px-6">
        <p>
          AgentAuth Mandate Studio, MIT licensed. Reads {clusterLabel(config.cluster)} through{' '}
          <span className="font-mono">{new URL(config.rpcUrl).host}</span>.
        </p>
        <p>
          <Link href="/docs">Security model and limits</Link>
        </p>
      </div>
    </footer>
  )
}
