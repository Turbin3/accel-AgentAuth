// @agentauth-sol/registry - human-readable instruction registry for AgentAuth mandates.
// Plain ESM, no runtime dependencies. Data lives in ../data/programs/*.json (see SCHEMA.md).
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url))

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze(o[k])
  }
  return o
}

function loadDir(dir) {
  let files
  try { files = readdirSync(join(DATA_DIR, dir)).filter((f) => f.endsWith('.json')).sort() } catch { return [] }
  return files.map((f) => deepFreeze(JSON.parse(readFileSync(join(DATA_DIR, dir, f), 'utf8'))))
}

/** All program definitions (frozen), sorted by file name. */
export const programs = Object.freeze(loadDir('programs'))

// Per-program lookup tables, built once.
const TABLES = new Map()
for (const p of programs) {
  const byLen = new Map() // byte length -> Map(prefix hex -> instruction)
  for (const ix of p.instructions) {
    const len = ix.rawPrefixHex.length / 2
    if (!byLen.has(len)) byLen.set(len, new Map())
    byLen.get(len).set(ix.rawPrefixHex, ix)
  }
  TABLES.set(p.slug, {
    lens: [...byLen.keys()].sort((a, b) => b - a),
    byLen,
    byDisc: new Map(p.instructions.map((ix) => [ix.disc8, ix])),
    byName: new Map(p.instructions.map((ix) => [ix.name, ix])),
  })
}

// Legacy behaviour that is not visible in the tag table: the legacy ATA processor treats
// EMPTY instruction data as Create (see the note on associated-token-account.create).
const EMPTY_DATA_INSTRUCTION = { 'associated-token-account': 'create' }

const HEX = /^[0-9a-fA-F]*$/

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data) && data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Uint8Array.from(data)
  if (typeof data === 'string') {
    const h = data.startsWith('0x') || data.startsWith('0X') ? data.slice(2) : data
    if (h.length % 2 !== 0 || !HEX.test(h)) throw new TypeError('instruction data must be an even-length hex string, a Uint8Array or a byte array')
    return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
  }
  throw new TypeError('instruction data must be an even-length hex string, a Uint8Array or a byte array')
}

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

function normDisc8(d) {
  const h = typeof d === 'string' ? (d.startsWith('0x') ? d.slice(2) : d).toLowerCase() : d instanceof Uint8Array ? toHex(d) : ''
  return /^[0-9a-f]{16}$/.test(h) ? h : null
}

/** Find a program by base58 id (optionally restricted to one cluster). Returns the program or null. */
export function getProgramById(id, cluster) {
  for (const p of programs) {
    if (cluster !== undefined) {
      if (p.programIds[cluster] === id) return p
    } else if (Object.values(p.programIds).includes(id)) return p
  }
  return null
}

/** Find a program by slug. Returns the program or null. */
export function getProgramBySlug(slug) {
  return programs.find((p) => p.slug === slug) ?? null
}

function resolve(programIdOrSlug) {
  return getProgramBySlug(programIdOrSlug) ?? getProgramById(programIdOrSlug)
}

/** Find an instruction by snake_case name in a program (id or slug). Returns the instruction or null. */
export function instructionByName(programIdOrSlug, name) {
  const p = resolve(programIdOrSlug)
  return p ? TABLES.get(p.slug).byName.get(name) ?? null : null
}

function match(p, bytes) {
  const t = TABLES.get(p.slug)
  for (const len of t.lens) {
    if (bytes.length < len) continue
    const ix = t.byLen.get(len).get(toHex(bytes.subarray(0, len)))
    if (ix) return ix
  }
  if (bytes.length === 0 && EMPTY_DATA_INSTRUCTION[p.slug]) return t.byName.get(EMPTY_DATA_INSTRUCTION[p.slug]) ?? null
  return null
}

// disc8 for data that matches no registered instruction, following the canonical convention.
function fallbackDisc8(p, bytes) {
  const pad = (n) => (bytes.length >= n ? toHex(bytes.subarray(0, n)).padEnd(16, '0') : null)
  switch (p.discriminatorScheme) {
    case 'anchor-sha256': return pad(8)
    case 'u32le-tag': return pad(4)
    default: {
      if (bytes.length === 0) return null
      // If registered instructions of this tag use a longer prefix (e.g. Token-2022 tag+sub-tag),
      // an unknown sub-tag is reported with that same prefix length.
      let n = 1
      for (const ix of p.instructions) {
        const l = ix.rawPrefixHex.length / 2
        if (l > n && ix.rawPrefixHex.slice(0, 2) === toHex(bytes.subarray(0, 1))) n = l
      }
      return pad(Math.min(n, bytes.length)) ?? pad(1)
    }
  }
}

/**
 * Decode instruction data sent to a program.
 * Returns {known, program, instruction|null, disc8, risk, defaultDeny}.
 * Unknown program: program=null, disc8=null, risk='unknown', defaultDeny=false (registry has no opinion).
 * Known program, unknown instruction: instruction=null, disc8 per convention, risk='unknown', defaultDeny=false.
 * `known` is true only when an instruction matched; fail-closed consumers should deny when !known.
 */
export function decodeInstruction(programId, ixData, cluster) {
  const bytes = toBytes(ixData)
  const p = getProgramById(programId, cluster)
  if (!p) return { known: false, program: null, instruction: null, disc8: null, risk: 'unknown', defaultDeny: false }
  const program = { slug: p.slug, name: p.name, programId }
  const ix = match(p, bytes)
  if (!ix) return { known: false, program, instruction: null, disc8: fallbackDisc8(p, bytes), risk: 'unknown', defaultDeny: false }
  return { known: true, program, instruction: ix, disc8: ix.disc8, risk: ix.risk, defaultDeny: ix.defaultDeny }
}

/** Canonical disc8 (16 hex chars) for instruction data sent to programId, or null if it cannot be determined. */
export function canonicalDisc8(programId, ixData) {
  return decodeInstruction(programId, ixData).disc8
}

function byDisc(programId, disc8) {
  const p = getProgramById(programId)
  const d = normDisc8(disc8)
  if (!p || !d) return null
  return TABLES.get(p.slug).byDisc.get(d) ?? null
}

/** Risk class of (programId, disc8), or null when the pair is not in the registry. */
export function riskOf(programId, disc8) {
  return byDisc(programId, disc8)?.risk ?? null
}

/** True when the registry flags (programId, disc8) as default-deny. Unknown pairs return false. */
export function isDefaultDeny(programId, disc8) {
  return byDisc(programId, disc8)?.defaultDeny ?? false
}

/**
 * Read the token/lamport amount from raw instruction data using the instruction's amount descriptor.
 * Returns a bigint, or null when the instruction has no amount, is unknown, or the data is too short.
 */
export function parseAmount(programId, ixData) {
  const bytes = toBytes(ixData)
  const { instruction } = decodeInstruction(programId, bytes)
  const a = instruction?.amount
  if (!a || bytes.length < a.offset + a.size) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (a.type === 'u64le') return view.getBigUint64(a.offset, true)
  if (a.type === 'u32le') return BigInt(view.getUint32(a.offset, true))
  return null
}

// ---- presets ----------------------------------------------------------------------------
const presetDocs = loadDir('presets')

function resolvePreset(doc) {
  const { permissions, ...rest } = doc
  return deepFreeze({
    ...structuredClone(rest),
    permissions: permissions.map((r) => {
      const p = getProgramBySlug(r.program)
      return {
        slug: p.slug,
        programIds: { ...p.programIds },
        instructions: r.instructions.map((n) => {
          const ix = TABLES.get(p.slug).byName.get(n)
          return { name: ix.name, title: ix.title, disc8: ix.disc8, risk: ix.risk, amount: ix.amount }
        }),
        notes: r.notes ?? '',
        suggested: r.suggested ?? null,
      }
    }),
  })
}

/** All presets, resolved to program ids and canonical disc8 values. */
export function presets() {
  return presetDocs.map(resolvePreset)
}

/** One preset by name, or null. */
export function preset(name) {
  const d = presetDocs.find((x) => x.name === name)
  return d ? resolvePreset(d) : null
}
