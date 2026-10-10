import type { Address } from '@solana/kit'
import { concatBytes, u32ToLe, u64ToLe } from './bytes'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants'
import {
  instruction,
  meta,
  positiveU64,
  signerMeta,
  type AddressOrSigner,
  type BuiltInstruction,
} from './ix'
import { associatedTokenAddress, relayAuthorityPda } from './pda'
import { ValidationError } from './sdk-errors'

/** Parameters of {@link approveIx}. */
export interface ApproveParams {
  /** The owner's token account that gets delegated (the policy `sourceAccount`). */
  readonly source: Address
  /** The owner (signer). Approve MUST be a top-level instruction signed by the owner. */
  readonly owner: AddressOrSigner
  /** Delegate. Omit to use the relay authority PDA of `mandate`. */
  readonly delegate?: Address
  /** Mandate used to derive the relay authority PDA when `delegate` is omitted. */
  readonly mandate?: Address
  /** Delegated amount in raw units (> 0). The Token program enforces this as a hard cap. */
  readonly amount: bigint
  /** Token or Token-2022 program id. Defaults to the classic Token program. */
  readonly tokenProgram?: Address
  readonly relayProgram?: Address
}

/**
 * SPL `Approve` (tag 4): a BOUNDED delegation of `amount` raw units from `source` to the relay
 * authority PDA (or an explicit `delegate`). Accounts `[source W, delegate R, owner R+S]`, data
 * `[4] + amount u64`. One SPL delegate exists per token account, so this overwrites any earlier
 * delegation on `source`.
 *
 * @throws ValidationError `BAD_AMOUNT | MISSING_ADDRESS`
 */
export async function approveIx(params: ApproveParams): Promise<BuiltInstruction> {
  const amount = positiveU64(params.amount, 'amount')
  let delegate = params.delegate
  if (delegate === undefined) {
    if (params.mandate === undefined) {
      throw new ValidationError(
        'MISSING_ADDRESS',
        'pass `delegate` or `mandate` (to derive the relay authority)',
      )
    }
    delegate = (await relayAuthorityPda(params.mandate, params.relayProgram ?? RELAY_PROGRAM_ID))
      .address
  }
  return instruction(
    params.tokenProgram ?? TOKEN_PROGRAM_ID,
    [meta(params.source, true), meta(delegate, false), signerMeta(params.owner, false)],
    concatBytes(new Uint8Array([4]), u64ToLe(amount, 'amount')),
  )
}

/** Parameters of {@link revokeDelegateIx}. */
export interface RevokeDelegateParams {
  readonly source: Address
  readonly owner: AddressOrSigner
  readonly tokenProgram?: Address
}

/** SPL `Revoke` (tag 5): clears the delegate of `source`. Accounts `[source W, owner R+S]`, data `[5]`. */
export function revokeDelegateIx(params: RevokeDelegateParams): BuiltInstruction {
  return instruction(
    params.tokenProgram ?? TOKEN_PROGRAM_ID,
    [meta(params.source, true), signerMeta(params.owner, false)],
    new Uint8Array([5]),
  )
}

/** Parameters of {@link transferCheckedIx}. */
export interface TransferCheckedParams {
  readonly source: Address
  readonly mint: Address
  readonly destination: Address
  /** Authority: the token account owner (or delegate). Signer. */
  readonly authority: AddressOrSigner
  readonly amount: bigint
  readonly decimals: number
  readonly tokenProgram?: Address
}

/**
 * Raw SPL `TransferChecked` (tag 12). Accounts `[source W, mint R, destination W, authority R+S]`,
 * data `[12] + amount u64 + decimals`. Used by the hot-wallet contrast and attack demos; it is NOT
 * gated by AgentAuth.
 */
export function transferCheckedIx(params: TransferCheckedParams): BuiltInstruction {
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 255) {
    throw new ValidationError('BAD_DECIMALS', 'decimals must be an integer in [0, 255]')
  }
  return instruction(
    params.tokenProgram ?? TOKEN_PROGRAM_ID,
    [
      meta(params.source, true),
      meta(params.mint, false),
      meta(params.destination, true),
      signerMeta(params.authority, false),
    ],
    concatBytes(
      new Uint8Array([12]),
      u64ToLe(positiveU64(params.amount, 'amount'), 'amount'),
      new Uint8Array([params.decimals]),
    ),
  )
}

/** Parameters of {@link createAtaIdempotentIx}. */
export interface CreateAtaParams {
  /** Rent payer (signer). */
  readonly payer: AddressOrSigner
  /** Wallet that will own the token account. */
  readonly owner: Address
  readonly mint: Address
  readonly tokenProgram?: Address
  /** ATA address; derived when omitted. */
  readonly ata?: Address
  readonly associatedTokenProgram?: Address
}

/**
 * Associated Token Account `CreateIdempotent` (tag 1). Accounts
 * `[payer WS, ata W, owner R, mint R, system R, token_program R]`, data `[1]`. A no-op when the ATA
 * already exists with the right owner and mint.
 */
export async function createAtaIdempotentIx(params: CreateAtaParams): Promise<BuiltInstruction> {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID
  const ata =
    params.ata ??
    (
      await associatedTokenAddress(
        params.owner,
        params.mint,
        tokenProgram,
        params.associatedTokenProgram,
      )
    ).address
  return instruction(
    params.associatedTokenProgram ?? ASSOCIATED_TOKEN_PROGRAM_ID,
    [
      signerMeta(params.payer, true),
      meta(ata, true),
      meta(params.owner, false),
      meta(params.mint, false),
      meta(SYSTEM_PROGRAM_ID, false),
      meta(tokenProgram, false),
    ],
    new Uint8Array([1]),
  )
}

/** Parameters of {@link systemTransferIx}. */
export interface SystemTransferParams {
  readonly from: AddressOrSigner
  readonly to: Address
  readonly lamports: bigint
}

/** System `Transfer` (tag 2 as u32). Accounts `[from WS, to W]`, data `[2,0,0,0] + lamports u64`. */
export function systemTransferIx(params: SystemTransferParams): BuiltInstruction {
  return instruction(
    SYSTEM_PROGRAM_ID,
    [signerMeta(params.from, true), meta(params.to, true)],
    concatBytes(u32ToLe(2), u64ToLe(positiveU64(params.lamports, 'lamports'), 'lamports')),
  )
}
