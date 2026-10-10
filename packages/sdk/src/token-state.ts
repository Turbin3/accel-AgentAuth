import type { Address, ReadonlyUint8Array } from '@solana/kit'
import type { RawAccount } from './accounts'
import { bytesToAddress, readU32, readU64, readU8 } from './bytes'
import { TOKEN_2022_PROGRAM_ID } from './constants'
import { DecodeError } from './sdk-errors'

/** A decoded SPL token account (first 165 bytes; extensions are ignored). */
export interface TokenAccountView {
  readonly mint: Address
  readonly owner: Address
  readonly amount: bigint
  /** The SPL delegate, or `null`. */
  readonly delegate: Address | null
  /** 0 uninitialised, 1 initialised, 2 frozen. */
  readonly state: number
  readonly delegatedAmount: bigint
  readonly closeAuthority: Address | null
}

/** A decoded SPL mint (first 82 bytes). */
export interface MintView {
  readonly decimals: number
  readonly isInitialized: boolean
  readonly supply: bigint
  readonly mintAuthority: Address | null
  readonly freezeAuthority: Address | null
}

/**
 * Decode an SPL token account (RELAY-SPEC 6.5 offsets). Needs at least 165 bytes.
 * @throws DecodeError `TOKEN_ACCOUNT_BAD_LENGTH`
 */
export function decodeTokenAccount(data: ReadonlyUint8Array): TokenAccountView {
  if (data.length < 165) {
    throw new DecodeError(
      'TOKEN_ACCOUNT_BAD_LENGTH',
      `token account must be >= 165 bytes, got ${data.length}`,
    )
  }
  return {
    mint: bytesToAddress(data.subarray(0, 32)),
    owner: bytesToAddress(data.subarray(32, 64)),
    amount: readU64(data, 64),
    delegate: readU32(data, 72) === 1 ? bytesToAddress(data.subarray(76, 108)) : null,
    state: readU8(data, 108),
    delegatedAmount: readU64(data, 121),
    closeAuthority: readU32(data, 129) === 1 ? bytesToAddress(data.subarray(133, 165)) : null,
  }
}

/**
 * Decode an SPL mint. Needs at least 82 bytes.
 * @throws DecodeError `MINT_BAD_LENGTH`
 */
export function decodeMint(data: ReadonlyUint8Array): MintView {
  if (data.length < 82) {
    throw new DecodeError('MINT_BAD_LENGTH', `mint must be >= 82 bytes, got ${data.length}`)
  }
  return {
    decimals: readU8(data, 44),
    isInitialized: readU8(data, 45) === 1,
    supply: readU64(data, 36),
    mintAuthority: readU32(data, 0) === 1 ? bytesToAddress(data.subarray(4, 36)) : null,
    freezeAuthority: readU32(data, 46) === 1 ? bytesToAddress(data.subarray(50, 82)) : null,
  }
}

/** Result of the relay's `token_acct_ok` / `check_mint` mirrors: the relay error that would fire. */
export type AccountCheck = { readonly ok: true } | { readonly ok: false; readonly code: 103 | 105 }

/**
 * Mirror of the relay's `check_mint` (RELAY-SPEC 6.4): owned by `programKey`, exactly 82 bytes
 * (extension-free), initialised. Failure is relay error 103.
 */
export function checkMint(account: RawAccount | null, programKey: Address): AccountCheck {
  if (!account || account.ownerProgram !== programKey) return { ok: false, code: 103 }
  if (account.data.length !== 82 || account.data[45] !== 1) return { ok: false, code: 103 }
  return { ok: true }
}

/**
 * Mirror of the relay's `token_acct_ok` (RELAY-SPEC 6.3): owner program (103), then layout and
 * state (105). Accepts 165 bytes, or for Token-2022 exactly the 170-byte ImmutableOwner-only shape.
 */
export function checkTokenAccountShape(
  account: RawAccount | null,
  programKey: Address,
): AccountCheck {
  if (!account || account.ownerProgram !== programKey) return { ok: false, code: 103 }
  const d = account.data
  const plain = d.length === 165
  const t22 =
    programKey === TOKEN_2022_PROGRAM_ID &&
    d.length === 170 &&
    d[165] === 2 &&
    d[166] === 7 &&
    d[167] === 0 &&
    d[168] === 0 &&
    d[169] === 0
  if (!plain && !t22) return { ok: false, code: 105 }
  if (d[108] !== 1) return { ok: false, code: 105 }
  return { ok: true }
}
