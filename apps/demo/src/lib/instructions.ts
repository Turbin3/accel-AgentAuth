/**
 * The few instructions the SDK deliberately does not ship because only a test/demo environment
 * needs them: System CreateAccount, SPL mint creation and minting, the mock AMM `init_pool` and the
 * gated-example `init` / `gated_action`. Everything about mandates, the relay, Approve, ATAs and
 * transfers comes from @agentauth-sol/sdk.
 */
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  GATED_ACTION_DISC,
  GATED_EXAMPLE_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  concatBytes,
  u64ToLe,
} from '@agentauth-sol/sdk'

type Meta = AccountMeta | AccountSignerMeta

const addressBytes = (a: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(a))

function ro(address: Address): Meta {
  return { address, role: AccountRole.READONLY }
}
function rw(address: Address): Meta {
  return { address, role: AccountRole.WRITABLE }
}
function signer(s: TransactionSigner, writable: boolean): AccountSignerMeta {
  return {
    address: s.address,
    role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
    signer: s,
  }
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

// ---------------------------------------------------------------------------------------------
// System program
// ---------------------------------------------------------------------------------------------

/** System `CreateAccount` (tag 0 as u32): both `payer` and `newAccount` sign. */
export function createAccountIx(p: {
  readonly payer: TransactionSigner
  readonly newAccount: TransactionSigner
  readonly lamports: bigint
  readonly space: bigint
  readonly owner: Address
}): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [signer(p.payer, true), signer(p.newAccount, true)],
    data: concatBytes(u32le(0), u64ToLe(p.lamports), u64ToLe(p.space), addressBytes(p.owner)),
  }
}

// ---------------------------------------------------------------------------------------------
// SPL Token (classic)
// ---------------------------------------------------------------------------------------------

/** Size of an SPL mint account. */
export const MINT_SIZE = 82n

/** SPL `InitializeMint2` (tag 20): no rent sysvar account, no freeze authority. */
export function initializeMint2Ix(p: {
  readonly mint: Address
  readonly decimals: number
  readonly mintAuthority: Address
}): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [rw(p.mint)],
    data: concatBytes(
      new Uint8Array([20, p.decimals]),
      addressBytes(p.mintAuthority),
      new Uint8Array([0]), // freeze authority: None
    ),
  }
}

/** Size of an SPL token account. */
export const TOKEN_ACCOUNT_SIZE = 165n

/** SPL `InitializeAccount3` (tag 18): `[account W, mint R]`, data `[18] + owner`. No rent sysvar needed. */
export function initializeAccount3Ix(p: {
  readonly account: Address
  readonly mint: Address
  readonly owner: Address
}): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [rw(p.account), ro(p.mint)],
    data: concatBytes(new Uint8Array([18]), addressBytes(p.owner)),
  }
}

/** SPL `MintToChecked` (tag 14): decimals are verified by the Token program. */
export function mintToCheckedIx(p: {
  readonly mint: Address
  readonly destination: Address
  readonly authority: TransactionSigner
  readonly amount: bigint
  readonly decimals: number
}): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [rw(p.mint), rw(p.destination), signer(p.authority, false)],
    data: concatBytes(new Uint8Array([14]), u64ToLe(p.amount), new Uint8Array([p.decimals])),
  }
}

// ---------------------------------------------------------------------------------------------
// mock-amm (programs/mock-amm; test/demo only)
// ---------------------------------------------------------------------------------------------

/** Size of a mock-amm `pool_state` account. */
export const MOCK_POOL_STATE_SIZE = 104n
/** `mode` byte 0: the honest constant-product swap. */
export const MOCK_AMM_MODE_NORMAL = 0
const INIT_POOL_DISC = new Uint8Array([0xff, 0x69, 0x6e, 0x69, 0x74, 0, 0, 0])

/** The pool authority PDA `["mock_amm_auth"]` under the mock AMM: token owner of both vaults. */
export async function mockAmmAuthority(programId: Address = MOCK_AMM_PROGRAM_ID): Promise<{
  address: Address
  bump: number
}> {
  const [address, bump] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode('mock_amm_auth')],
  })
  return { address, bump }
}

/**
 * mock-amm `init_pool`: `[pool W, vault_0 R, vault_1 R]`, data = disc + mode + aux_key[32].
 * `pool` must already exist (104 zero bytes owned by the mock AMM).
 */
export function mockAmmInitPoolIx(p: {
  readonly pool: Address
  readonly vault0: Address
  readonly vault1: Address
  readonly mode?: number
  readonly auxKey?: Address
  readonly programId?: Address
}): Instruction {
  return {
    programAddress: p.programId ?? MOCK_AMM_PROGRAM_ID,
    accounts: [rw(p.pool), ro(p.vault0), ro(p.vault1)],
    data: concatBytes(
      INIT_POOL_DISC,
      new Uint8Array([p.mode ?? MOCK_AMM_MODE_NORMAL]),
      p.auxKey ? addressBytes(p.auxKey) : new Uint8Array(32),
    ),
  }
}

// ---------------------------------------------------------------------------------------------
// gated-example (programs/gated-example; the second integrator of verify)
// ---------------------------------------------------------------------------------------------

/** The config PDA `["config"]` under gated-example: holds the one owner the deployment honours. */
export async function gatedConfigPda(programId: Address = GATED_EXAMPLE_PROGRAM_ID): Promise<{
  address: Address
  bump: number
}> {
  const [address, bump] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode('config')],
  })
  return { address, bump }
}

/**
 * gated-example `init` (tag 0): `[authority S+W, config W, system R]`. The signing authority becomes
 * the only owner whose mandates the deployment honours. Callable once.
 */
export async function gatedInitIx(p: {
  readonly authority: TransactionSigner
  readonly programId?: Address
}): Promise<Instruction> {
  const programId = p.programId ?? GATED_EXAMPLE_PROGRAM_ID
  const config = await gatedConfigPda(programId)
  return {
    programAddress: programId,
    accounts: [signer(p.authority, true), rw(config.address), ro(SYSTEM_PROGRAM_ID)],
    data: new Uint8Array([0]),
  }
}

/**
 * gated-example `gated_action` (tag 1): `[agent S, mandate W, owner R, agentauth R, config R]`,
 * data `[1] + amount u64`. The program CPIs `verify` for `(itself, GATED_ACTION_DISC, amount)`.
 */
export async function gatedActionIx(p: {
  readonly agent: TransactionSigner
  readonly mandate: Address
  readonly owner: Address
  readonly amount: bigint
  readonly programId?: Address
  readonly agentAuthProgram?: Address
}): Promise<Instruction> {
  const programId = p.programId ?? GATED_EXAMPLE_PROGRAM_ID
  const config = await gatedConfigPda(programId)
  return {
    programAddress: programId,
    accounts: [
      signer(p.agent, false),
      rw(p.mandate),
      ro(p.owner),
      ro(p.agentAuthProgram ?? AGENT_AUTH_PROGRAM_ID),
      ro(config.address),
    ],
    data: concatBytes(new Uint8Array([1]), u64ToLe(p.amount)),
  }
}

/** Re-exported for callers that build their own gated permission. */
export { GATED_ACTION_DISC }
