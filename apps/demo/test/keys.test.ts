import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureKeypair, loadSigner } from '../src/lib/keys'

let dir: string
const saved = process.env['AA_DEMO_DIR']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aa-demo-keys-'))
  process.env['AA_DEMO_DIR'] = dir
})
afterEach(async () => {
  if (saved === undefined) delete process.env['AA_DEMO_DIR']
  else process.env['AA_DEMO_DIR'] = saved
  await rm(dir, { recursive: true, force: true })
})

describe('demo keypair files', () => {
  it('creates a 64-byte Solana CLI keypair, mode 600 in a 700 directory, and is idempotent', async () => {
    expect(await ensureKeypair('owner')).toBe(true)
    const file = join(dir, 'keys', 'owner.json')
    const bytes: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(Array.isArray(bytes) && bytes.length === 64).toBe(true)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'keys'))).mode & 0o777).toBe(0o700)

    const before = await readFile(file, 'utf8')
    expect(await ensureKeypair('owner')).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('loads a signer whose address matches the public half stored in the file', async () => {
    await ensureKeypair('agent')
    const signer = await loadSigner('agent')
    const again = await loadSigner('agent')
    expect(signer.address).toBe(again.address)
  })

  it('tightens loose permissions on an existing key', async () => {
    await ensureKeypair('hot')
    const file = join(dir, 'keys', 'hot.json')
    await chmod(file, 0o644)
    await ensureKeypair('hot')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('reports a missing or corrupt key without leaking its content', async () => {
    await expect(loadSigner('harness')).rejects.toThrow(/missing.*bootstrap/)
    await ensureKeypair('harness')
    const file = join(dir, 'keys', 'harness.json')
    const secretLooking = JSON.stringify(new Array(64).fill(7))
    await writeFile(file, secretLooking, { mode: 0o600 })
    const error = await loadSigner('harness').then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/corrupt/)
    expect(error!.message).not.toContain('7,7,7')
  })
})
