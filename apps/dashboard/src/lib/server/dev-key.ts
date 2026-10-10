import { readFile } from 'node:fs/promises'
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit'
import { loadSigner } from '@agentauth-sol/demo'

/**
 * The server-side dev key: `AA_DEV_KEYPAIR_PATH` (a Solana CLI keypair file) or the demo owner key
 * under `AA_DEMO_DIR`. Loaded per request and never logged; error messages carry no key material.
 */
export async function loadDevKey(): Promise<KeyPairSigner> {
  const path = process.env['AA_DEV_KEYPAIR_PATH']?.trim()
  if (!path) return loadSigner('owner')
  let bytes: Uint8Array
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error('not a 64-byte array')
    }
    bytes = Uint8Array.from(parsed as number[])
  } catch {
    throw new Error('AA_DEV_KEYPAIR_PATH is missing or is not a Solana CLI keypair file.')
  }
  try {
    return await createKeyPairSignerFromBytes(bytes)
  } finally {
    bytes.fill(0)
  }
}
