/**
 * Instruction helpers the SDK deliberately does not ship: a direct mock-AMM swap (the "searcher"),
 * SPL `SetAuthority`, the mock AMM `proxy` (a CPI wrapper), and small tamper functions that turn an
 * honest SDK instruction into a hostile one (swap an account, drop one, change the data).
 */
import {
  AccountRole,
  getAddressEncoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  concatBytes,
  fromHex,
  u64ToLe,
} from '@agentauth-sol/sdk'

type Meta = AccountMeta | AccountSignerMeta

const ro = (address: Address): Meta => ({ address, role: AccountRole.READONLY })
const rw = (address: Address): Meta => ({ address, role: AccountRole.WRITABLE })

/** The 8-byte tag of the mock AMM `proxy` instruction (`FF "proxy" 00 00`). */
const PROXY_DISC = new Uint8Array([0xff, 0x70, 0x72, 0x6f, 0x78, 0x79, 0, 0])

/** Direct `swap_base_input` on the mock AMM, signed by the owner of `inAccount` (no relay, no mandate). */
export function ammSwapIx(p: {
  readonly programId: Address
  readonly payer: TransactionSigner
  readonly authority: Address
  readonly config: Address
  readonly pool: Address
  readonly inAccount: Address
  readonly outAccount: Address
  readonly inVault: Address
  readonly outVault: Address
  readonly inMint: Address
  readonly outMint: Address
  readonly observation: Address
  readonly amountIn: bigint
  readonly minOut: bigint
}): Instruction {
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer.address, role: AccountRole.READONLY_SIGNER, signer: p.payer },
      ro(p.authority),
      ro(p.config),
      rw(p.pool),
      rw(p.inAccount),
      rw(p.outAccount),
      rw(p.inVault),
      rw(p.outVault),
      ro(TOKEN_PROGRAM_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(p.inMint),
      ro(p.outMint),
      rw(p.observation),
    ],
    data: concatBytes(fromHex(SWAP_BASE_INPUT_DISC), u64ToLe(p.amountIn), u64ToLe(p.minOut)),
  }
}

/** SPL `SetAuthority` (tag 6) of kind AccountOwner (2) to `newAuthority`. Accounts `[account W, current S]`. */
export function setAccountOwnerIx(p: {
  readonly account: Address
  readonly current: TransactionSigner
  readonly newAuthority: Address
}): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      rw(p.account),
      { address: p.current.address, role: AccountRole.READONLY_SIGNER, signer: p.current },
    ],
    data: concatBytes(
      new Uint8Array([6, 2, 1]),
      new Uint8Array(getAddressEncoder().encode(p.newAuthority)),
    ),
  }
}

/** SPL `CloseAccount` (tag 9): `[account W, destination W, owner S]`. */
export function closeAccountIx(p: {
  readonly account: Address
  readonly destination: Address
  readonly owner: TransactionSigner
}): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      rw(p.account),
      rw(p.destination),
      { address: p.owner.address, role: AccountRole.READONLY_SIGNER, signer: p.owner },
    ],
    data: new Uint8Array([9]),
  }
}

/**
 * Wrap `inner` in the mock AMM `proxy` instruction, so the callee runs one CPI level deep
 * (accounts `[program, ...inner accounts]`, data = tag + inner data; the signature extends).
 */
export function proxyIx(mockAmm: Address, inner: Instruction): Instruction {
  return {
    programAddress: mockAmm,
    accounts: [ro(inner.programAddress), ...(inner.accounts ?? [])],
    data: concatBytes(PROXY_DISC, inner.data ?? new Uint8Array()),
  }
}

/** The same instruction with account `index` replaced by `address` (role and signer kept). */
export function replaceAccount(ix: Instruction, index: number, address: Address): Instruction {
  const accounts = [...(ix.accounts ?? [])]
  const old = accounts[index]
  if (old === undefined) throw new Error(`instruction has no account ${index}`)
  accounts[index] = { ...old, address }
  return { ...ix, accounts }
}

/** The same instruction without account `index`. */
export function dropAccount(ix: Instruction, index: number): Instruction {
  return { ...ix, accounts: (ix.accounts ?? []).filter((_, i) => i !== index) }
}

/** The same instruction with a read-only account appended. */
export function appendAccount(ix: Instruction, address: Address): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ro(address)] }
}

/** The same instruction with different data. */
export function withData(ix: Instruction, data: Uint8Array): Instruction {
  return { ...ix, data }
}

/** The same instruction with the signer flag of account `index` removed (a read-only, non-signing meta). */
export function unsign(ix: Instruction, index: number): Instruction {
  const accounts = [...(ix.accounts ?? [])]
  const old = accounts[index]
  if (old === undefined) throw new Error(`instruction has no account ${index}`)
  accounts[index] = { address: old.address, role: AccountRole.READONLY }
  return { ...ix, accounts }
}
