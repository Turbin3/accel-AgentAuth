import type { Address, KeyPairSigner } from '@solana/kit'
import type { Client } from '@agentauth-sol/sdk'
import type { Deps } from '../src/env'

export interface Captured {
  stdout: string
  stderr: string
}

export interface Harness {
  readonly deps: Deps
  readonly captured: Captured
}

/** Deps with captured output, a fixed clock and no real machine access. Override what a test needs. */
export function harness(
  overrides: Partial<Deps> = {},
  files: Record<string, string> = {},
): Harness {
  const captured: Captured = { stdout: '', stderr: '' }
  const deps: Deps = {
    env: {},
    cwd: '/nowhere',
    stdout: { write: (s: string) => (captured.stdout += s) },
    stderr: { write: (s: string) => (captured.stderr += s) },
    stdinIsTTY: false,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    readFile: async (path: string) => {
      const text = files[path]
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      }
      return text
    },
    readStdin: async () => files['<stdin>'] ?? '',
    loadKeypair: async (path: string) => {
      throw new Error(`unexpected keypair load: ${path}`)
    },
    createClient: () => {
      throw new Error('unexpected createClient')
    },
    confirm: async () => true,
    ...overrides,
  }
  return { deps, captured }
}

export function fakeSigner(address: string): KeyPairSigner {
  return { address: address as Address } as unknown as KeyPairSigner
}

export function fakeClient(partial: Record<string, unknown>): Client {
  return partial as unknown as Client
}
