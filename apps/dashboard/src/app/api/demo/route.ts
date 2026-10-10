import { NextResponse } from 'next/server'
import { localnetOnly, refuseNonLocal } from '@/lib/server/guard'
import { readDemoStatus } from '@/lib/server/demo-state'

export const dynamic = 'force-dynamic'

/** Public addresses of the bootstrapped localnet demo (no keys). Lets the wizard offer real demo values. */
export async function GET(req: Request) {
  const refused = localnetOnly() ?? refuseNonLocal(req)
  if (refused) return refused
  const status = await readDemoStatus()
  if (!status.env)
    return NextResponse.json({ available: false, reason: status.reason, problems: [] })
  const e = status.env
  return NextResponse.json({
    available: status.available,
    reason: status.reason,
    problems: status.problems,
    wallets: e.wallets,
    mints: e.mints,
    tokenAccounts: e.tokenAccounts,
    pool: e.pool,
    gated: e.gated,
  })
}
