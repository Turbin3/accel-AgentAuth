// Dependency-free validator for the registry file format described in SCHEMA.md.
// Every function returns an array of human-readable error strings ([] = valid).

export const CLUSTERS = ['mainnet-beta', 'devnet', 'testnet']
export const KINDS = ['native', 'anchor', 'pinocchio', 'other']
export const SCHEMES = ['anchor-sha256', 'u8-tag', 'u32le-tag', 'borsh-enum-u8', 'custom']
export const RISKS = ['read_only', 'value_out', 'value_swap', 'position_mgmt', 'authority_change', 'account_close', 'admin', 'other']
export const MUST_DENY = ['authority_change', 'account_close', 'admin']
// value_out is deliberately absent: a few value_out instructions (withdraw_excess_lamports,
// confidential transfers, ...) are conservatively default-deny in the data, which SCHEMA.md allows.
export const MUST_ALLOW = ['read_only', 'value_swap', 'position_mgmt']
export const SOURCE_KINDS = ['idl', 'docs', 'source']
export const AMOUNT_TYPES = { u32le: 4, u64le: 8 }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_MAP = new Map([...B58].map((c, i) => [c, i]))

/** Decode a base58 string to bytes. Throws on an invalid character. */
export function base58Decode(s) {
  if (typeof s !== 'string' || s.length === 0) throw new Error('empty base58 string')
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const digits = [] // little-endian base-256
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP.get(s[i])
    if (v === undefined) throw new Error(`invalid base58 character '${s[i]}'`)
    let carry = v
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58
      digits[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { digits.push(carry & 0xff); carry >>= 8 }
  }
  const out = new Uint8Array(zeros + digits.length)
  for (let i = 0; i < digits.length; i++) out[out.length - 1 - i] = digits[i]
  return out
}

/** True if s is a base58 string that decodes to exactly 32 bytes (a Solana public key). */
export function isBase58Pubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false
  try { return base58Decode(s).length === 32 } catch { return false }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.trim().length > 0
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
const isLowerHex = (v) => typeof v === 'string' && /^([0-9a-f]{2})*$/.test(v)
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length

function validateAmount(a, p, errs) {
  if (a === null) return
  if (!isObj(a)) { errs.push(`${p}.amount must be null or an object`); return }
  if (!Number.isInteger(a.offset) || a.offset < 0) errs.push(`${p}.amount.offset must be a non-negative integer`)
  if (!(a.type in AMOUNT_TYPES)) errs.push(`${p}.amount.type must be one of ${Object.keys(AMOUNT_TYPES).join('|')}`)
  else if (a.size !== AMOUNT_TYPES[a.type]) errs.push(`${p}.amount.size ${a.size} does not match type ${a.type}`)
  if (!isStr(a.unit)) errs.push(`${p}.amount.unit must be a non-empty string`)
}

/**
 * Validate one parsed program file.
 * @param {unknown} doc parsed JSON
 * @param {{fileName?: string}} [opts] fileName like "spl-token.json" enables the slug==file check
 */
export function validateProgram(doc, opts = {}) {
  const errs = []
  if (!isObj(doc)) return ['file root must be an object']
  if (doc.schemaVersion !== 1) errs.push('schemaVersion must be 1')
  if (!isStr(doc.slug) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(doc.slug)) errs.push('slug must be kebab-case')
  else if (opts.fileName && opts.fileName.replace(/\.json$/, '') !== doc.slug) errs.push(`slug "${doc.slug}" must equal file name "${opts.fileName}"`)
  if (!isStr(doc.name)) errs.push('name must be a non-empty string')
  if (!KINDS.includes(doc.kind)) errs.push(`kind must be one of ${KINDS.join('|')}`)

  if (!isObj(doc.programIds) || Object.keys(doc.programIds).length === 0) errs.push('programIds must be a non-empty object')
  else {
    for (const [c, id] of Object.entries(doc.programIds)) {
      if (!CLUSTERS.includes(c)) errs.push(`programIds: unknown cluster "${c}"`)
      if (!isBase58Pubkey(id)) errs.push(`programIds.${c}: "${id}" is not a base58 32-byte public key`)
    }
  }

  const scheme = doc.discriminatorScheme
  if (!SCHEMES.includes(scheme)) errs.push(`discriminatorScheme must be one of ${SCHEMES.join('|')}`)

  if (!Array.isArray(doc.instructions) || doc.instructions.length === 0) {
    errs.push('instructions must be a non-empty array')
  } else {
    const names = new Set(), discs = new Set(), prefixes = []
    doc.instructions.forEach((ix, n) => {
      const p = `instructions[${n}]${isObj(ix) && typeof ix.name === 'string' ? ` (${ix.name})` : ''}`
      if (!isObj(ix)) { errs.push(`${p} must be an object`); return }
      if (!isStr(ix.name) || !/^[a-z][a-z0-9_]*$/.test(ix.name)) errs.push(`${p}.name must be snake_case`)
      else if (names.has(ix.name)) errs.push(`${p}.name is duplicated`)
      else names.add(ix.name)
      if (!isStr(ix.title)) errs.push(`${p}.title must be a non-empty string`)

      const dOk = typeof ix.disc8 === 'string' && /^[0-9a-f]{16}$/.test(ix.disc8)
      if (!dOk) errs.push(`${p}.disc8 must be 16 lowercase hex chars`)
      else if (discs.has(ix.disc8)) errs.push(`${p}.disc8 ${ix.disc8} is duplicated`)
      else discs.add(ix.disc8)

      const rOk = isLowerHex(ix.rawPrefixHex) && ix.rawPrefixHex.length <= 16
      if (!rOk) errs.push(`${p}.rawPrefixHex must be lowercase hex of 0..8 bytes`)
      else {
        prefixes.push([ix.rawPrefixHex, ix.name])
        if (dOk && ix.disc8 !== ix.rawPrefixHex.padEnd(16, '0')) errs.push(`${p}.disc8 must equal rawPrefixHex zero-padded to 8 bytes`)
        const need = { 'anchor-sha256': 16, 'u8-tag': 2, 'u32le-tag': 8 }[scheme]
        if (scheme === 'anchor-sha256' && ix.rawPrefixHex.length !== 16) errs.push(`${p}.rawPrefixHex must be 8 bytes for anchor-sha256`)
        else if (need && ix.rawPrefixHex.length < need) errs.push(`${p}.rawPrefixHex is shorter than the ${scheme} tag`)
        if (scheme === 'borsh-enum-u8' && ix.rawPrefixHex.length < 2) errs.push(`${p}.rawPrefixHex must hold at least the variant byte`)
      }

      if (!RISKS.includes(ix.risk)) errs.push(`${p}.risk must be one of ${RISKS.join('|')}`)
      if (typeof ix.defaultDeny !== 'boolean') errs.push(`${p}.defaultDeny must be a boolean`)
      else if (MUST_DENY.includes(ix.risk) && !ix.defaultDeny) errs.push(`${p}: risk ${ix.risk} requires defaultDeny=true`)
      else if (MUST_ALLOW.includes(ix.risk) && ix.defaultDeny) errs.push(`${p}: risk ${ix.risk} must have defaultDeny=false`)
      if (!isStr(ix.rationale)) errs.push(`${p}.rationale must be a non-empty string`)
      else if (words(ix.rationale) > 25) errs.push(`${p}.rationale has ${words(ix.rationale)} words (max 25)`)
      if (typeof ix.notes !== 'string') errs.push(`${p}.notes must be a string`)
      if (!('amount' in ix)) errs.push(`${p}.amount is required (null if none)`)
      else validateAmount(ix.amount, p, errs)
    })
    // Prefix-freeness is only required between distinct non-empty prefixes; an empty
    // prefix is allowed only when it is the sole instruction (memo-style programs).
    for (const [a, an] of prefixes) for (const [b, bn] of prefixes) {
      if (an === bn) continue
      if (a === b) errs.push(`instructions ${an} and ${bn} share rawPrefixHex "${a}"`)
      else if (b.startsWith(a)) errs.push(`rawPrefixHex of ${an} ("${a}") is a prefix of ${bn} ("${b}"): decoding is ambiguous`)
    }
  }

  if (!Array.isArray(doc.sources) || doc.sources.length === 0) errs.push('sources must be a non-empty array')
  else doc.sources.forEach((s, n) => {
    const p = `sources[${n}]`
    if (!isObj(s)) { errs.push(`${p} must be an object`); return }
    if (!isStr(s.url) || !/^https:\/\//.test(s.url)) errs.push(`${p}.url must be an https URL`)
    if (!SOURCE_KINDS.includes(s.kind)) errs.push(`${p}.kind must be one of ${SOURCE_KINDS.join('|')}`)
    if (!isStr(s.ref)) errs.push(`${p}.ref must be a non-empty string`)
    if (!isDate(s.retrieved)) errs.push(`${p}.retrieved must be YYYY-MM-DD`)
  })

  const v = doc.verification
  if (!isObj(v)) errs.push('verification must be an object')
  else {
    if (typeof v.disc8RecomputedFromNames !== 'boolean') errs.push('verification.disc8RecomputedFromNames must be a boolean')
    else if (scheme === 'anchor-sha256' && !v.disc8RecomputedFromNames) errs.push('anchor program must have verification.disc8RecomputedFromNames=true')
    if (!(v.idlExplicitDiscriminatorsMatch === null || typeof v.idlExplicitDiscriminatorsMatch === 'boolean')) errs.push('verification.idlExplicitDiscriminatorsMatch must be boolean|null')
    if (v.idlExplicitDiscriminatorsMatch === false) errs.push('verification.idlExplicitDiscriminatorsMatch is false')
    if (!isDate(v.checkedAt)) errs.push('verification.checkedAt must be YYYY-MM-DD')
    if (v.onchainExecutable !== undefined) {
      if (!isObj(v.onchainExecutable)) errs.push('verification.onchainExecutable must be an object')
      else for (const [c, b] of Object.entries(v.onchainExecutable)) {
        if (!CLUSTERS.includes(c)) errs.push(`verification.onchainExecutable: unknown cluster "${c}"`)
        else if (isObj(doc.programIds) && !(c in doc.programIds)) errs.push(`verification.onchainExecutable.${c} has no matching programIds entry`)
        if (typeof b !== 'boolean') errs.push(`verification.onchainExecutable.${c} must be a boolean`)
      }
    }
  }
  return errs
}

/** Validate a preset document against already-loaded programs (array of program docs). */
export function validatePreset(doc, programs, opts = {}) {
  const errs = []
  if (!isObj(doc)) return ['preset root must be an object']
  if (doc.schemaVersion !== 1) errs.push('schemaVersion must be 1')
  if (!isStr(doc.name) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(doc.name)) errs.push('name must be kebab-case')
  else if (opts.fileName && opts.fileName.replace(/\.json$/, '') !== doc.name) errs.push(`name "${doc.name}" must equal file name "${opts.fileName}"`)
  if (!isStr(doc.title)) errs.push('title must be a non-empty string')
  if (!isStr(doc.description)) errs.push('description must be a non-empty string')
  if (!Array.isArray(doc.permissions) || doc.permissions.length === 0) errs.push('permissions must be a non-empty array')
  else doc.permissions.forEach((r, n) => {
    const p = `permissions[${n}]`
    const prog = isObj(r) ? programs.find((x) => x.slug === r.program) : null
    if (!prog) { errs.push(`${p}.program "${isObj(r) ? r.program : r}" is not a known slug`); return }
    if (!Array.isArray(r.instructions) || r.instructions.length === 0) { errs.push(`${p}.instructions must be non-empty`); return }
    for (const nm of r.instructions) {
      const ix = prog.instructions.find((i) => i.name === nm)
      if (!ix) errs.push(`${p}: ${prog.slug} has no instruction "${nm}"`)
      else if (ix.defaultDeny) errs.push(`${p}: ${prog.slug}.${nm} is defaultDeny and cannot be part of a preset`)
    }
  })
  if (doc.explicitly_blocked !== undefined) {
    if (!Array.isArray(doc.explicitly_blocked)) errs.push('explicitly_blocked must be an array')
    else doc.explicitly_blocked.forEach((b, n) => {
      const p = `explicitly_blocked[${n}]`
      const prog = isObj(b) ? programs.find((x) => x.slug === b.program) : null
      if (!prog) { errs.push(`${p}.program is not a known slug`); return }
      if (!prog.instructions.some((i) => i.name === b.instruction)) errs.push(`${p}: ${prog.slug} has no instruction "${b.instruction}"`)
      if (Array.isArray(doc.permissions) && doc.permissions.some((r) => isObj(r) && r.program === b.program && Array.isArray(r.instructions) && r.instructions.includes(b.instruction))) errs.push(`${p}: ${b.program}.${b.instruction} is both permitted and blocked`)
    })
  }
  return errs
}
