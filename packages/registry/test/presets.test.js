import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getProgramBySlug } from '../src/index.js'

const dir = fileURLToPath(new URL('../data/presets/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
const DANGEROUS = new Set(['authority_change', 'account_close', 'admin'])

test('at least one preset exists', () => assert.ok(files.length > 0))

for (const f of files) {
  const doc = JSON.parse(readFileSync(dir + f, 'utf8'))
  test(`preset ${f}: every referenced instruction exists`, () => {
    const refs = [...doc.permissions.map((p) => [p.program, p.instructions]), ...doc.explicitly_blocked.map((b) => [b.program, [b.instruction]])]
    for (const [slug, names] of refs) {
      const prog = getProgramBySlug(slug)
      assert.ok(prog, `unknown program ${slug}`)
      for (const n of names) assert.ok(prog.instructions.some((i) => i.name === n), `${slug}.${n} not in registry`)
    }
  })
  test(`preset ${f}: authority/close/admin/default-deny instructions of referenced programs are explicitly_blocked`, () => {
    const blocked = new Set(doc.explicitly_blocked.map((b) => `${b.program}.${b.instruction}`))
    const permitted = new Set(doc.permissions.flatMap((p) => p.instructions.map((n) => `${p.program}.${n}`)))
    for (const slug of new Set(doc.permissions.map((p) => p.program))) {
      for (const i of getProgramBySlug(slug).instructions) {
        const key = `${slug}.${i.name}`
        if (DANGEROUS.has(i.risk) || i.defaultDeny) assert.ok(blocked.has(key), `${key} (${i.risk}) not blocked`)
        assert.ok(!(blocked.has(key) && permitted.has(key)), `${key} both permitted and blocked`)
      }
    }
  })
}

test('no preset text calls the relay recipient allowlist optional or conditional', () => {
  // The relay ALWAYS enforces the allowlist; an empty allowlist refuses every transfer (relay 104).
  const bad = [
    /without (it|an allowlist|a recipient allowlist)[^.]*(any address|anyone|any recipient)/i,
    /(only fires|only applies|only enforced|only checked) when (an|the) allowlist/i,
    /allowlist (is|was) (optional|not set)/i,
    /if no (recipient )?allowlist is set/i,
    /allowlist exists/i,
  ]
  for (const f of files) {
    const text = readFileSync(dir + f, 'utf8')
    for (const re of bad) assert.ok(!re.test(text), `${f}: text contradicts the relay (allowlist is always enforced): ${re}`)
  }
  const payments = JSON.parse(readFileSync(dir + 'payments-usdc.json', 'utf8'))
  assert.match(payments.risk_summary, /empty allowlist refuses every transfer/)
})
