import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { validateProgram, validatePreset, base58Decode, isBase58Pubkey } from '../src/validate.js'

const dir = fileURLToPath(new URL('../data/programs/', import.meta.url))
const pdir = fileURLToPath(new URL('../data/presets/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))

test('there are data files', () => assert.ok(files.length >= 9))

for (const f of files) {
  test(`validator accepts ${f}`, () => assert.deepEqual(validateProgram(load(f), { fileName: f }), []))
}

test('validator accepts every preset', () => {
  const progs = files.map(load)
  for (const f of readdirSync(pdir)) assert.deepEqual(validatePreset(JSON.parse(readFileSync(join(pdir, f), 'utf8')), progs, { fileName: f }), [], f)
})

test('base58 decoding', () => {
  assert.equal(base58Decode('11111111111111111111111111111111').length, 32)
  assert.ok(base58Decode('11111111111111111111111111111111').every((b) => b === 0))
  assert.equal(base58Decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').length, 32)
  assert.deepEqual([...base58Decode('2')], [1])
  assert.deepEqual([...base58Decode('1z')], [0, 57])
  assert.equal(isBase58Pubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), true)
  assert.equal(isBase58Pubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D0'), false) // '0' is not base58
  assert.equal(isBase58Pubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5'), false) // too short
})

// ---- negative tests: each mutation of a good copy must be rejected ----
const mutations = {
  'bad schemaVersion': (d) => { d.schemaVersion = 2 },
  'slug not matching file': (d) => { d.slug = 'something-else' },
  'bad program id char': (d) => { d.programIds['mainnet-beta'] = d.programIds['mainnet-beta'].slice(0, -1) + '0' },
  'truncated program id': (d) => { d.programIds['mainnet-beta'] = d.programIds['mainnet-beta'].slice(0, -3) },
  'unknown cluster': (d) => { d.programIds.moon = d.programIds['mainnet-beta'] },
  'unknown scheme': (d) => { d.discriminatorScheme = 'magic' },
  'corrupted disc8': (d) => { d.instructions[0].disc8 = d.instructions[0].disc8.replace(/.$/, (c) => (c === 'f' ? '0' : 'f')) },
  'uppercase disc8': (d) => { d.instructions[0].disc8 = 'AAAAAAAAAAAAAAAA' },
  'short disc8': (d) => { d.instructions[0].disc8 = '00' },
  'rawPrefixHex odd length': (d) => { d.instructions[0].rawPrefixHex = 'abc' },
  'duplicate name': (d) => { d.instructions.push({ ...clone(d.instructions[0]), disc8: '1122334455667788', rawPrefixHex: '1122334455667788' }) },
  'duplicate disc8': (d) => { if (d.instructions.length < 2) throw new Error('skip'); d.instructions[1].disc8 = d.instructions[0].disc8 },
  'bad risk': (d) => { d.instructions[0].risk = 'scary' },
  'admin without defaultDeny': (d) => { d.instructions[0].risk = 'admin'; d.instructions[0].defaultDeny = false },
  'read_only with defaultDeny': (d) => { d.instructions[0].risk = 'read_only'; d.instructions[0].defaultDeny = true },
  'defaultDeny not boolean': (d) => { d.instructions[0].defaultDeny = 'yes' },
  'rationale over 25 words': (d) => { d.instructions[0].rationale = Array(26).fill('word').join(' ') },
  'bad amount size': (d) => { d.instructions[0].amount = { offset: 0, size: 3, type: 'u64le', unit: 'x' } },
  'amount missing': (d) => { delete d.instructions[0].amount },
  'no sources': (d) => { d.sources = [] },
  'source not https': (d) => { d.sources[0].url = 'http://example.com' },
  'bad checkedAt': (d) => { d.verification.checkedAt = 'yesterday' },
  'idl mismatch flag': (d) => { d.verification.idlExplicitDiscriminatorsMatch = false },
  'onchainExecutable for missing cluster': (d) => { d.verification.onchainExecutable = { testnet: true } },
  'no instructions': (d) => { d.instructions = [] },
}

for (const f of files) {
  for (const [label, mutate] of Object.entries(mutations)) {
    test(`corrupted ${f} (${label}) fails`, (t) => {
      const d = clone(load(f))
      try { mutate(d) } catch (e) { if (e.message === 'skip') return t.skip(); throw e }
      assert.notDeepEqual(validateProgram(d, { fileName: f }), [], label)
    })
  }
}

test('prefix collision is rejected', () => {
  const d = clone(load('spl-token-2022.json'))
  const ext = d.instructions.find((i) => i.rawPrefixHex.length === 4)
  const bare = clone(ext); bare.name = 'bare_tag'; bare.rawPrefixHex = ext.rawPrefixHex.slice(0, 2); bare.disc8 = bare.rawPrefixHex.padEnd(16, '0')
  d.instructions.push(bare)
  assert.ok(validateProgram(d, { fileName: 'spl-token-2022.json' }).some((e) => e.includes('ambiguous')))
})

test('anchor disc8 must differ from recomputed name is caught by verify-all, anchor recompute flag is required', () => {
  const d = clone(load('raydium-cpmm.json'))
  d.verification.disc8RecomputedFromNames = false
  assert.notDeepEqual(validateProgram(d, { fileName: 'raydium-cpmm.json' }), [])
})

test('preset validation rejects unknown instruction and defaultDeny instruction', () => {
  const progs = files.map(load)
  const bad = { schemaVersion: 1, name: 'p', title: 't', description: 'd', permissions: [{ program: 'spl-token', instructions: ['nope'] }] }
  assert.notDeepEqual(validatePreset(bad, progs), [])
  const deny = { ...bad, permissions: [{ program: 'spl-token', instructions: ['set_authority'] }] }
  assert.ok(validatePreset(deny, progs).some((e) => e.includes('defaultDeny')))
})
