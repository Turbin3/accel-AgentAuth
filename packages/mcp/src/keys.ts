import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit'
import type { Logger } from './log'

/**
 * Load a Solana CLI keypair file (JSON array of 64 bytes). Failure messages never contain file
 * content (a JSON parse error can quote the text it choked on).
 */
export async function loadKeypairSigner(
  path: string,
  role: 'agent' | 'owner',
  log: Logger,
): Promise<KeyPairSigner> {
  try {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      log.warn('keypair_file_permissions', {
        role,
        note: `keypair file is readable by group/others (mode ${mode.toString(8)}); run chmod 600`,
      })
    }
  } catch {
    throw new Error(`cannot read the ${role} keypair file (check the path and permissions)`)
  }
  let bytes: Uint8Array
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error('shape')
    }
    bytes = Uint8Array.from(parsed as number[])
  } catch {
    throw new Error(
      `the ${role} keypair file is not a Solana CLI keypair (a JSON array of 64 bytes)`,
    )
  }
  try {
    return await createKeyPairSignerFromBytes(bytes)
  } catch {
    throw new Error(`the ${role} keypair file does not contain a valid ed25519 keypair`)
  } finally {
    bytes.fill(0)
  }
}
