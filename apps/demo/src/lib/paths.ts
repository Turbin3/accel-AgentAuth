import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives at apps/demo/src/lib). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/**
 * Directory of the local demo state. Gitignored. `AA_DEMO_DIR` overrides it (tests, parallel
 * environments).
 */
export function demoDir(): string {
  const override = process.env['AA_DEMO_DIR']
  return override && override.length > 0 ? resolve(override) : join(REPO_ROOT, '.demo')
}

/** Directory with the demo keypair files (mode 700; files are mode 600). */
export function keysDir(): string {
  return join(demoDir(), 'keys')
}

/** `state.json`: every PUBLIC address of the environment, never a secret. */
export function stateFile(): string {
  return join(demoDir(), 'state.json')
}
