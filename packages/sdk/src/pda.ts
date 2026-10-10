import { getProgramDerivedAddress, type Address } from '@solana/kit'
import { addressToBytes } from './bytes'
import {
  AGENT_AUTH_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  RELAY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants'

/** A derived address and its bump seed. */
export interface PdaResult {
  readonly address: Address
  readonly bump: number
}

const enc = new TextEncoder()

async function derive(programAddress: Address, seeds: Uint8Array[]): Promise<PdaResult> {
  const [address, bump] = await getProgramDerivedAddress({ programAddress, seeds })
  return { address, bump }
}

/**
 * The mandate PDA: seeds `["mandate", owner, agent]` under the AgentAuth program.
 * @param programId override for localnet / tests.
 */
export function mandatePda(
  owner: Address,
  agent: Address,
  programId: Address = AGENT_AUTH_PROGRAM_ID,
): Promise<PdaResult> {
  return derive(programId, [enc.encode('mandate'), addressToBytes(owner), addressToBytes(agent)])
}

/**
 * The relay policy PDA: seeds `["policy", mandate]` under the relay program.
 * @param programId override for localnet / tests.
 */
export function relayPolicyPda(
  mandate: Address,
  programId: Address = RELAY_PROGRAM_ID,
): Promise<PdaResult> {
  return derive(programId, [enc.encode('policy'), addressToBytes(mandate)])
}

/**
 * The relay authority PDA: seeds `["authority", mandate]` under the relay program.
 * It is the SPL delegate. No account exists at this address; it only signs inside the relay.
 * @param programId override for localnet / tests.
 */
export function relayAuthorityPda(
  mandate: Address,
  programId: Address = RELAY_PROGRAM_ID,
): Promise<PdaResult> {
  return derive(programId, [enc.encode('authority'), addressToBytes(mandate)])
}

/**
 * Associated token account address: seeds `[owner, tokenProgram, mint]` under the ATA program.
 * Works for Token and Token-2022 (pass the matching `tokenProgram`).
 */
export async function associatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ID,
  associatedTokenProgram: Address = ASSOCIATED_TOKEN_PROGRAM_ID,
): Promise<PdaResult> {
  return derive(associatedTokenProgram, [
    addressToBytes(owner),
    addressToBytes(tokenProgram),
    addressToBytes(mint),
  ])
}
