import type { Metadata } from 'next'
import { connection } from 'next/server'
import { RegistryBrowser } from '@/components/registry-browser'
import { PageTitle } from '@/components/ui'
import { loadRegistryData } from '@/lib/registry-server'

export const metadata: Metadata = { title: 'Registry' }

export default async function RegistryPage() {
  await connection()
  const data = await loadRegistryData('full')
  return (
    <main>
      <PageTitle
        title="Verified registry"
        lead="Programs and instructions a mandate can name, with their risk classes. This is what turns a discriminator into a sentence."
      />
      <RegistryBrowser data={data} />
    </main>
  )
}
