/**
 * Shared setup for the examples: a fresh localnet mandate. Needs a running local validator and
 * `pnpm --filter @agentauth-sol/demo bootstrap` (see README). Throwaway in-memory agent key.
 *
 * Localnet only. The guard used in the examples is a COOPERATIVE client-side check, not enforcement.
 */
import { loadDemoEnv, loadDemoSigners, connect, type DemoChain } from '@agentauth-sol/demo'
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  addPermissionIx,
  createMandateIx,
  mandatePda,
  type ProgramIds,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit'

export const SOL = 1_000_000_000n
export const SYSTEM_TRANSFER_DISC = '0200000000000000'

export interface ExampleEnv {
  readonly chain: DemoChain
  readonly programIds: ProgramIds
  readonly owner: KeyPairSigner
  readonly agent: KeyPairSigner
  readonly recipient: KeyPairSigner
  readonly mandate: Address
}

/**
 * Owner (demo wallet) gives a throwaway agent a mandate: System transfer up to 1 SOL lifetime and
 * 0.5 SOL per call; Token TransferChecked up to 3 units lifetime and 1 per call (6 decimals).
 */
export async function setupMandate(): Promise<ExampleEnv> {
  const env = await loadDemoEnv()
  const chain = connect({ rpcUrl: env.rpcUrl, wsUrl: env.wsUrl })
  const { owner } = await loadDemoSigners(env)
  const agent = await generateKeyPairSigner()
  const recipient = await generateKeyPairSigner()
  await chain.airdrop(agent.address, 2n * SOL)

  const expiry = BigInt(Math.floor(Date.now() / 1000)) + 3600n
  await chain.send(
    [
      await createMandateIx({ owner, agent: agent.address, expiry }),
      await addPermissionIx({
        owner,
        agent: agent.address,
        program: SYSTEM_PROGRAM_ID,
        spendLimit: SOL,
        perTxLimit: SOL / 2n,
        discriminators: [SYSTEM_TRANSFER_DISC],
      }),
      await addPermissionIx({
        owner,
        agent: agent.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: 3_000_000n,
        perTxLimit: 1_000_000n,
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ],
    owner,
  )
  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address
  return { chain, programIds: env.programIds, owner, agent, recipient, mandate }
}

/** Unwrap the demo chain's TxFailedError to show what actually refused or failed. */
export function rootCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error
}
