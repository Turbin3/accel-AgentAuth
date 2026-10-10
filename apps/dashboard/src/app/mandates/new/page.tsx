'use client'

import { RequireWallet } from '@/components/require-wallet'
import { Wizard } from '@/components/wizard'
import { PageTitle } from '@/components/ui'

export default function NewMandatePage() {
  return (
    <main>
      <PageTitle
        title="New mandate"
        lead="Choose the agent, set the limits, read what it can and cannot do, then sign two transactions."
      />
      <RequireWallet why="Creating a mandate means signing transactions from the wallet that owns the funds.">
        {(wallet) => <Wizard wallet={wallet} />}
      </RequireWallet>
    </main>
  )
}
