export const CLUSTERS: readonly string[]
export const KINDS: readonly string[]
export const SCHEMES: readonly string[]
export const RISKS: readonly string[]
export const MUST_DENY: readonly string[]
export const MUST_ALLOW: readonly string[]
export const SOURCE_KINDS: readonly string[]
export const AMOUNT_TYPES: Readonly<Record<'u32le' | 'u64le', number>>
export function base58Decode(s: string): Uint8Array
export function isBase58Pubkey(s: string): boolean
/** Returns a list of error strings; empty means valid. */
export function validateProgram(doc: unknown, opts?: { fileName?: string }): string[]
export function validatePreset(doc: unknown, programs: readonly unknown[], opts?: { fileName?: string }): string[]
