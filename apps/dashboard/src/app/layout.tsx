import type { Metadata, Viewport } from 'next'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import { DevSignerBanner, Footer, Header, HonestyStrip } from '@/components/shell'
import { FatalConfig } from '@/components/fatal'
import { ChainProvider } from '@/lib/chain'
import { resolveConfig } from '@/lib/config'
import { ConfigProvider } from '@/lib/config-context'
import { loadRegistryData } from '@/lib/registry-server'
import { WalletProvider } from '@/lib/wallet/wallet-provider'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'AgentAuth Mandate Studio', template: '%s | AgentAuth Mandate Studio' },
  description:
    'Give an AI agent a bounded, revocable mandate on Solana, read what it can and cannot do, and watch every allowed and blocked attempt. Unaudited devnet prototype.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#111110' },
  ],
}

// Applies the stored theme before first paint so there is no flash and no layout shift.
const THEME_SCRIPT = `try{var t=localStorage.getItem('aa.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Configuration is read per request, so one build serves any cluster / RPC.
  await connection()
  const config = resolveConfig(process.env)
  const registry = await loadRegistryData('compact')
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink"
        >
          Skip to content
        </a>
        <ConfigProvider config={config}>
          {config.fatal ? (
            <FatalConfig message={config.fatal} />
          ) : (
            <ChainProvider registryData={registry}>
              <WalletProvider>
                <HonestyStrip />
                <DevSignerBanner />
                <Header />
                <div
                  id="main"
                  tabIndex={-1}
                  className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12"
                >
                  {children}
                </div>
                <Footer />
              </WalletProvider>
            </ChainProvider>
          )}
        </ConfigProvider>
      </body>
    </html>
  )
}
