import type { Metadata } from 'next'
import { Simulator } from '@/components/simulator'
import { PageTitle } from '@/components/ui'

export const metadata: Metadata = { title: 'Try to break it' }

export default function SimulatorPage() {
  return (
    <main>
      <PageTitle
        title="Try to break it"
        lead="A scripted compromised agent attacks a demo mandate. Each result is the real on-chain error, decoded."
      />
      <Simulator />
    </main>
  )
}
