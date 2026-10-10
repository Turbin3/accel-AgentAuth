import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

const sources = files(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))

describe('source hygiene', () => {
  it('nothing writes to stdout (it belongs to the MCP protocol) or uses console', () => {
    for (const s of sources) {
      expect(s.text, s.path).not.toMatch(/console\.(log|info|debug|warn|error)/)
      expect(s.text, s.path).not.toMatch(/process\.stdout/)
    }
  })

  it('no dynamic code execution, no child processes, no shell', () => {
    for (const s of sources) {
      expect(s.text, s.path).not.toMatch(/\beval\(|new Function\(|child_process|execSync|spawn\(/)
    }
  })

  it('the owner key path is only ever read by config.ts and start.ts', () => {
    const readers = sources
      .filter((s) => s.text.includes('AGENTAUTH_OWNER_KEYPAIR'))
      .map((s) => s.path)
      .sort()
    expect(readers).toEqual(['config.ts', 'start.ts'])
  })

  it('the agent tools never touch the owner signer', () => {
    const agent = sources.find((s) => s.path === 'tools/agent.ts')
    expect(agent?.text).not.toMatch(/ownerSigner/)
  })

  it('only the keypair loader and the idempotency store touch the file system', () => {
    const fsUsers = sources
      .filter((s) => /from 'node:fs/.test(s.text))
      .map((s) => s.path)
      .sort()
    expect(fsUsers).toEqual(['context.ts', 'guards.ts', 'keys.ts'])
  })

  it('logging never receives tool arguments', () => {
    const define = sources.find((s) => s.path === 'tools/define.ts')?.text ?? ''
    expect(define).not.toMatch(/log\.\w+\([^)]*args/)
  })
})
