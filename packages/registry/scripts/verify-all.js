#!/usr/bin/env node
// Recompute every Anchor discriminator and run the validator on every data file.
// Exit code 1 on any mismatch or validator error.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { anchorDisc, u8Disc, u32leDisc } from './disc.js'
import { validateProgram, validatePreset } from '../src/validate.js'

const root = fileURLToPath(new URL('../data/', import.meta.url))
const load = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ f, doc: JSON.parse(readFileSync(join(root, dir, f), 'utf8')) }))

let failures = 0
const fail = (m) => { failures++; console.error('FAIL', m) }
const programs = load('programs')

for (const { f, doc } of programs) {
  for (const e of validateProgram(doc, { fileName: f })) fail(`${f}: ${e}`)
  let checked = 0
  for (const ix of doc.instructions ?? []) {
    let want = null
    if (doc.discriminatorScheme === 'anchor-sha256') want = anchorDisc(ix.name)
    else if (doc.discriminatorScheme === 'u8-tag' && ix.rawPrefixHex?.length === 2) want = u8Disc(parseInt(ix.rawPrefixHex, 16))
    else if (doc.discriminatorScheme === 'u32le-tag') want = u32leDisc(Buffer.from(ix.rawPrefixHex ?? '', 'hex').readUInt32LE(0))
    if (want === null) continue
    checked++
    if (ix.disc8 !== want || (doc.discriminatorScheme === 'anchor-sha256' && ix.rawPrefixHex !== want)) fail(`${f}: ${ix.name} disc8 ${ix.disc8} != recomputed ${want}`)
  }
  console.log(`${f}: ${doc.instructions.length} instructions, ${checked} discriminators recomputed`)
}
for (const { f, doc } of load('presets')) for (const e of validatePreset(doc, programs.map((x) => x.doc), { fileName: f })) fail(`presets/${f}: ${e}`)

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('registry OK')
