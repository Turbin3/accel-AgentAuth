import { NextResponse } from 'next/server'
import { loadRegistryData } from '@/lib/registry-server'

export const dynamic = 'force-static'

export async function GET() {
  return NextResponse.json(await loadRegistryData('full'), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
}
