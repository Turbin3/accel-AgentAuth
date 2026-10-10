import {
  getAddressDecoder,
  getAddressEncoder,
  type Address,
  type ReadonlyUint8Array,
} from '@solana/kit'
import { ValidationError } from './sdk-errors'

/** Largest u64. */
export const U64_MAX = (1n << 64n) - 1n
/** Largest u32. */
export const U32_MAX = 0xffff_ffff
/** Largest i64. */
export const I64_MAX = (1n << 63n) - 1n
/** Smallest i64. */
export const I64_MIN = -(1n << 63n)

/** Lower-case hex of a byte array. */
export function toHex(bytes: ReadonlyUint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Strict hex parser: optional `0x` prefix, even length, hex digits only.
 * @param expectedLength when given, the decoded length must match exactly.
 * @throws ValidationError `BAD_HEX`
 */
export function fromHex(hex: string, expectedLength?: number): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new ValidationError('BAD_HEX', `not a hex string: ${JSON.stringify(hex.slice(0, 40))}`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new ValidationError(
      'BAD_HEX',
      `expected ${expectedLength} bytes of hex, got ${out.length}`,
    )
  }
  return out
}

/** Concatenate byte arrays into a new array. */
export function concatBytes(...parts: readonly ReadonlyUint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Constant-shape equality of two byte arrays. */
export function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function view(bytes: ReadonlyUint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Read a u8 (bounds-checked by typed array semantics: caller must pre-check length). */
export function readU8(bytes: ReadonlyUint8Array, offset: number): number {
  return bytes[offset] as number
}
/** Read a little-endian u16. */
export function readU16(bytes: ReadonlyUint8Array, offset: number): number {
  return view(bytes).getUint16(offset, true)
}
/** Read a little-endian u32. */
export function readU32(bytes: ReadonlyUint8Array, offset: number): number {
  return view(bytes).getUint32(offset, true)
}
/** Read a little-endian u64 as bigint. */
export function readU64(bytes: ReadonlyUint8Array, offset: number): bigint {
  return view(bytes).getBigUint64(offset, true)
}
/** Read a little-endian i64 as bigint. */
export function readI64(bytes: ReadonlyUint8Array, offset: number): bigint {
  return view(bytes).getBigInt64(offset, true)
}

/** Encode a u64 little-endian. @throws ValidationError `U64_RANGE` */
export function u64ToLe(value: bigint, field = 'value'): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new ValidationError('U64_RANGE', `${field} must be a bigint in [0, 2^64-1]`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

/** Encode an i64 little-endian. @throws ValidationError `I64_RANGE` */
export function i64ToLe(value: bigint, field = 'value'): Uint8Array {
  if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
    throw new ValidationError('I64_RANGE', `${field} must be a bigint in [-2^63, 2^63-1]`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

/** Encode a u32 little-endian. @throws ValidationError `U32_RANGE` */
export function u32ToLe(value: number, field = 'value'): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new ValidationError('U32_RANGE', `${field} must be an integer in [0, 2^32-1]`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

/** 32 raw bytes of an address. */
export function addressToBytes(addr: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(addr))
}

/** Address from exactly 32 raw bytes. */
export function bytesToAddress(bytes: ReadonlyUint8Array): Address {
  return getAddressDecoder().decode(bytes)
}

/** Normalise unix seconds given as number or bigint to bigint. @throws ValidationError `BAD_TIME` */
export function toSeconds(value: bigint | number, field = 'time'): bigint {
  if (typeof value === 'bigint') return value
  if (!Number.isFinite(value)) throw new ValidationError('BAD_TIME', `${field} must be finite`)
  return BigInt(Math.floor(value))
}

/** Current unix time in whole seconds. Impure; used only as a documented default. */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}
