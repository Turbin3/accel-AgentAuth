import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit'
import { keysDir } from './paths'

/**
 * Wallets of the demo cast (see scripts/README.md):
 * - `owner`     the human; owns the funds, signs onboarding, revokes and unwind
 * - `agent`     the AI agent key (holds fee SOL only, no token accounts)
 * - `attacker`  the scripted "compromised agent" counterparty (Mallory); a script, not an AI
 * - `recipient` the allowlisted payee (Alice)
 * - `harness`   mint authority of both demo mints; also the "searcher" of the price-floor beat
 * - `hot`       a naive agent whose own wallet holds funds (the control beat)
 */
export const WALLET_ROLES = ['owner', 'agent', 'attacker', 'recipient', 'harness', 'hot'] as const
export type WalletRole = (typeof WALLET_ROLES)[number]

/** Keypairs of on-chain objects that must sign their own creation (kept so addresses are stable). */
export const OBJECT_KEYS = [
  'dusd-mint',
  'dout-mint',
  'pool',
  'amm-config',
  'observation',
  'attacker-dusd-b',
  'simulator-dusd',
] as const
export type ObjectKey = (typeof OBJECT_KEYS)[number]

export type KeyName = WalletRole | ObjectKey

function fileFor(name: KeyName): string {
  return join(keysDir(), `${name}.json`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Create `<name>.json` (Solana CLI keypair format: a JSON array of 64 bytes) if it does not exist.
 * The directory is mode 700 and the file mode 600; the bytes are never logged or returned.
 * Returns true when a new key was generated.
 */
export async function ensureKeypair(name: KeyName): Promise<boolean> {
  await mkdir(keysDir(), { recursive: true, mode: 0o700 })
  await chmod(keysDir(), 0o700)
  const path = fileFor(name)
  if (await exists(path)) {
    await fixMode(path)
    return false
  }
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const signer = await createKeyPairSignerFromPrivateKeyBytes(secret)
  const full = new Uint8Array(64)
  full.set(secret, 0)
  full.set(getAddressEncoder().encode(signer.address), 32)
  try {
    // 'wx': never overwrite a key that appeared in the meantime.
    await writeFile(path, JSON.stringify(Array.from(full)), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    full.fill(0)
    secret.fill(0)
  }
  await chmod(path, 0o600)
  return true
}

async function fixMode(path: string): Promise<void> {
  const { mode } = await stat(path)
  if ((mode & 0o077) !== 0) await chmod(path, 0o600)
}

/** Load a keypair file as a Kit signer. Throws a message that never contains key material. */
export async function loadSigner(name: KeyName): Promise<KeyPairSigner> {
  const path = fileFor(name)
  let bytes: Uint8Array
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(isByte)) {
      throw new Error('not a 64-byte array')
    }
    bytes = Uint8Array.from(parsed)
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
    throw new Error(
      `demo key "${name}" is ${reason} (${path}); run \`pnpm --filter @agentauth-sol/demo bootstrap\``,
    )
  }
  try {
    return await createKeyPairSignerFromBytes(bytes)
  } catch {
    throw new Error(
      `demo key "${name}" is corrupt (${path}); delete the .demo directory and bootstrap again`,
    )
  } finally {
    bytes.fill(0)
  }
}

function isByte(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255
}

/** Signers of the whole cast, loaded from `.demo/keys`. */
export type DemoSigners = Readonly<Record<WalletRole, KeyPairSigner>>

export async function loadWalletSigners(): Promise<DemoSigners> {
  const entries = await Promise.all(
    WALLET_ROLES.map(async (role) => [role, await loadSigner(role)] as const),
  )
  return Object.fromEntries(entries) as DemoSigners
}
