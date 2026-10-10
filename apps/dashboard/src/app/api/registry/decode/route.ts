import { NextResponse } from 'next/server'
import { isAddress } from '@solana/kit'
import { decodeWithRegistry } from '@/lib/registry-server'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    programId?: unknown
    data?: unknown
  } | null
  const programId = typeof body?.programId === 'string' ? body.programId.trim() : ''
  const data = typeof body?.data === 'string' ? body.data.trim().replace(/^0x/i, '') : ''
  if (!isAddress(programId))
    return NextResponse.json({ error: 'programId is not a valid address.' }, { status: 400 })
  if (!/^([0-9a-fA-F]{2})*$/.test(data) || data.length === 0 || data.length > 4096) {
    return NextResponse.json(
      { error: 'data must be hex (an even number of digits, up to 2048 bytes).' },
      { status: 400 },
    )
  }
  return NextResponse.json(await decodeWithRegistry(programId, data.toLowerCase()))
}
