import { NextResponse } from 'next/server'
import {
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
} from '@solana/kit'
import { loadDevKey } from '@/lib/server/dev-key'
import { localnetOnly, refuseNonLocal, serverConfig } from '@/lib/server/guard'

export const dynamic = 'force-dynamic'

function gate(req: Request): NextResponse | null {
  const config = serverConfig()
  if (!config.devSigner.serverKey) {
    return NextResponse.json({ error: 'The server dev signer is not enabled.' }, { status: 404 })
  }
  return localnetOnly() ?? refuseNonLocal(req)
}

export async function GET(req: Request) {
  const refused = gate(req)
  if (refused) return refused
  try {
    const signer = await loadDevKey()
    return NextResponse.json({ address: signer.address })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not load the dev key.' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const refused = gate(req)
  if (refused) return refused
  try {
    const body = (await req.json()) as { transaction?: unknown }
    if (typeof body.transaction !== 'string' || body.transaction.length > 4096) {
      return NextResponse.json(
        { error: 'Send { transaction: <base64 wire transaction> }.' },
        { status: 400 },
      )
    }
    const signer = await loadDevKey()
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(body.transaction))
    if (!(signer.address in tx.signatures)) {
      return NextResponse.json(
        { error: 'The dev key is not a signer of this transaction.' },
        { status: 400 },
      )
    }
    const [dict] = await signer.signTransactions([tx] as unknown as Parameters<
      typeof signer.signTransactions
    >[0])
    const signed: Transaction = { ...tx, signatures: { ...tx.signatures, ...dict } }
    const wire = getTransactionEncoder().encode(signed)
    return NextResponse.json({ transaction: getBase64Decoder().decode(wire) })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Signing failed.' },
      { status: 400 },
    )
  }
}
