import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNoopSigner, getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of a file under test/fixtures. */
export function fixturePath(name: string): string {
  return join(here, 'fixtures', name)
}

/** Read a golden hex file as bytes. */
export function fixtureHex(name: string): Uint8Array {
  const hex = readFileSync(fixturePath(name), 'utf8').trim()
  return Uint8Array.from(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
}

/** Read a binary fixture. */
export function fixtureBin(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)))
}

/** The repo-level IDL files (source of truth; IDL drift must fail the tests). */
export function readIdl(name: 'core-idl' | 'relay-idl'): any {
  return JSON.parse(readFileSync(join(here, '..', '..', '..', 'idl', `${name}.json`), 'utf8'))
}

/** A deterministic fake address: 32 copies of `byte`. */
export function fakeAddress(byte: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(byte))
}

/** Raw 32 bytes of an address. */
export function raw(addr: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(addr))
}

/** A signer object that never signs (the SDK only needs its address). */
export function noopSigner(addr: Address) {
  return createNoopSigner(addr)
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface TestPermission {
  program: Address
  spendLimit: bigint
  perTxLimit: bigint
  spendTotal?: bigint
  callCount?: number
  /** hex strings of 16 chars */
  discs: string[]
}

export interface TestMandate {
  owner: Address
  agent: Address
  expiry: bigint
  active?: boolean
  version?: number
  bump?: number
  permissions: TestPermission[]
}

/**
 * Independent minimal encoder of the 2136-byte core mandate layout, written straight from
 * idl/core-idl.json (NOT using any SDK code) so that decoder bugs cannot cancel out.
 */
export function encodeMandateBytes(m: TestMandate): Uint8Array {
  const out = new Uint8Array(2136)
  const dv = new DataView(out.buffer)
  out[0] = 1
  out.set(raw(m.owner), 1)
  out.set(raw(m.agent), 33)
  dv.setBigInt64(65, m.expiry, true)
  out[73] = m.active === false ? 0 : 1
  dv.setUint16(77, m.permissions.length, true)
  out[79] = m.version ?? 1
  out[80] = m.bump ?? 254
  m.permissions.forEach((p, i) => {
    const base = 88 + i * 128
    out.set(raw(p.program), base)
    dv.setBigUint64(base + 32, p.spendLimit, true)
    dv.setBigUint64(base + 40, p.perTxLimit, true)
    dv.setBigUint64(base + 48, p.spendTotal ?? 0n, true)
    dv.setUint32(base + 56, p.callCount ?? 0, true)
    out[base + 60] = p.discs.length
    p.discs.forEach((d, j) => {
      out.set(Uint8Array.from(d.match(/../g)!.map((h) => parseInt(h, 16))), base + 64 + j * 8)
    })
  })
  return out
}
