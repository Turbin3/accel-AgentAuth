import { NextResponse } from 'next/server'
import { resolveConfig, isLoopbackUrl, type AppConfig } from '../config'

export function serverConfig(): AppConfig {
  return resolveConfig(process.env)
}

function hostOf(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname
  } catch {
    return null
  }
}

/**
 * Same-machine, same-origin guard for the routes that touch demo keys. They exist only for a local
 * demo: the request must come to a loopback host, from this app's own origin, as JSON (which forces
 * a CORS preflight for any other site). Returns a response to send back when the request is refused.
 */
export function refuseNonLocal(req: Request): NextResponse | null {
  const host = hostOf(req.headers.get('host'))
  if (!host || !isLoopbackUrl(`http://${host}`)) {
    return NextResponse.json({ error: 'This route only answers on localhost.' }, { status: 403 })
  }
  const origin = req.headers.get('origin')
  if (origin !== null && hostOf(origin) !== host) {
    return NextResponse.json({ error: 'Cross-origin requests are refused.' }, { status: 403 })
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'Cross-site requests are refused.' }, { status: 403 })
  }
  if (
    req.method === 'POST' &&
    !(req.headers.get('content-type') ?? '').startsWith('application/json')
  ) {
    return NextResponse.json({ error: 'Send application/json.' }, { status: 415 })
  }
  return null
}

export function localnetOnly(): NextResponse | null {
  const config = serverConfig()
  if (config.fatal || config.cluster !== 'localnet' || !isLoopbackUrl(config.rpcUrl)) {
    return NextResponse.json(
      {
        error:
          'Available on a local validator only (NEXT_PUBLIC_AA_CLUSTER=localnet with a loopback RPC).',
      },
      { status: 404 },
    )
  }
  return null
}

/** Make the demo package talk to the same validator the dashboard is configured for. */
export function alignDemoEndpoints(): void {
  const config = serverConfig()
  process.env['AA_RPC_URL'] ??= config.rpcUrl
}
