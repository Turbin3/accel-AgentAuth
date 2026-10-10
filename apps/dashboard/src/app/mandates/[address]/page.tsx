import type { Metadata } from 'next'
import { MandateDetailView } from '@/components/mandate-detail'

export const metadata: Metadata = { title: 'Mandate' }

export default async function MandatePage(props: { params: Promise<{ address: string }> }) {
  const { address } = await props.params
  return (
    <main>
      <MandateDetailView address={address} />
    </main>
  )
}
