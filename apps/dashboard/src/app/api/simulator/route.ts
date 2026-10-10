import { NextResponse } from 'next/server'
import { toJsonSafe } from '@agentauth-sol/sdk'
import { localnetOnly, refuseNonLocal } from '@/lib/server/guard'
import {
  ATTACKS,
  readSimulatorState,
  resetMandate,
  runAttack,
  serialised,
  type AttackId,
} from '@/lib/server/simulator'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function gate(req: Request): NextResponse | null {
  return localnetOnly() ?? refuseNonLocal(req)
}

export async function GET(req: Request) {
  const refused = gate(req)
  if (refused) return refused
  try {
    return NextResponse.json(toJsonSafe(await readSimulatorState()))
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not read the simulator state.' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const refused = gate(req)
  if (refused) return refused
  const body = (await req.json().catch(() => null)) as { action?: unknown; id?: unknown } | null
  try {
    if (body?.action === 'reset') {
      const steps = await serialised(() => resetMandate())
      return NextResponse.json(toJsonSafe({ steps }))
    }
    if (
      body?.action === 'attack' &&
      typeof body.id === 'string' &&
      ATTACKS.some((a) => a.id === body.id)
    ) {
      const result = await serialised(() => runAttack(body.id as AttackId))
      return NextResponse.json(toJsonSafe(result))
    }
    return NextResponse.json(
      { error: 'Send { action: "attack", id } or { action: "reset" }.' },
      { status: 400 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'The simulator failed.' },
      { status: 500 },
    )
  }
}
