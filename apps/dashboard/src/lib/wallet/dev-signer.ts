import {
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type KeyPairSigner,
} from '@solana/kit'
import type { AppConfig } from '../config'
import type { ConnectedWallet } from './types'
import { fromBase64, partialSignerFromWire, toBase64 } from './signer'

const STORAGE_KEY = 'aa.dev.browser-key.v1'

/** Hard gate used by every dev-signer code path. There is no way to pass it on mainnet. */
export function assertDevSignerAllowed(config: AppConfig, kind: 'browser' | 'server'): void {
  const ok = kind === 'browser' ? config.devSigner.browserKey : config.devSigner.serverKey
  if (
    config.fatal !== null ||
    (config.cluster !== 'localnet' && config.cluster !== 'devnet') ||
    !ok
  ) {
    throw new Error('The dev signer is not enabled for this cluster.')
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Throwaway key kept in sessionStorage only (gone when the tab closes). Never a real wallet. */
export async function loadBrowserDevSigner(config: AppConfig): Promise<KeyPairSigner> {
  assertDevSignerAllowed(config, 'browser')
  let seed: Uint8Array | null = null
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored && /^[0-9a-f]{64}$/.test(stored)) seed = unhex(stored)
  } catch {
    seed = null
  }
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32))
    try {
      window.sessionStorage.setItem(STORAGE_KEY, hex(seed))
    } catch {
      // Private mode: the key lives for this page load only. That is fine for a throwaway.
    }
  }
  return createKeyPairSignerFromPrivateKeyBytes(seed)
}

export function forgetBrowserDevSigner(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // nothing to forget
  }
}

export async function connectBrowserDevSigner(config: AppConfig): Promise<ConnectedWallet> {
  const signer = await loadBrowserDevSigner(config)
  return {
    address: signer.address,
    kind: 'dev-browser',
    label: 'Throwaway browser key',
    signer,
  }
}

interface ServerSignerInfo {
  readonly address: Address
}

/** The demo owner key lives on the server (localnet only); the browser only ever sees signatures. */
export async function connectServerDevSigner(config: AppConfig): Promise<ConnectedWallet> {
  assertDevSignerAllowed(config, 'server')
  const res = await fetch('/api/dev/signer', { cache: 'no-store' })
  const body = (await res.json()) as ServerSignerInfo | { error: string }
  if (!res.ok || !('address' in body)) {
    throw new Error('error' in body ? body.error : 'The server dev signer is not available.')
  }
  const address = body.address
  const signer = partialSignerFromWire(address, async (wire) => {
    const signRes = await fetch('/api/dev/signer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: toBase64(wire) }),
    })
    const signBody = (await signRes.json()) as { transaction: string } | { error: string }
    if (!signRes.ok || !('transaction' in signBody)) {
      throw new Error('error' in signBody ? signBody.error : 'The dev signer refused to sign.')
    }
    return fromBase64(signBody.transaction)
  })
  return { address, kind: 'dev-server', label: 'Demo owner (server dev key)', signer }
}
