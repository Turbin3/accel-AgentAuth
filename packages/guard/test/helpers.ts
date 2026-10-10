import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  blockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit'
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  parseDisc,
  type AgentAuthRpc,
  type Mandate,
  type Permission,
} from '@agentauth-sol/sdk'

export const SOL = 1_000_000_000n
export const SYSTEM_TRANSFER_DISC = '0200000000000000'
export const NOW = 1_800_000_000n

export function permission(
  index: number,
  program: Address,
  disc: string,
  over: Partial<Permission> = {},
): Permission {
  return {
    index,
    program,
    spendLimit: 1n * SOL,
    perTxLimit: SOL / 2n,
    spendUnlimited: false,
    perTxUnlimited: false,
    spendTotal: 0n,
    callCount: 0,
    discriminators: [parseDisc(disc)],
    discriminatorsHex: [disc],
    ...over,
  }
}

export interface Cast {
  readonly owner: KeyPairSigner
  readonly agent: KeyPairSigner
  readonly recipient: KeyPairSigner
  readonly mandate: Mandate
}

/** A mandate: System transfer (1 SOL lifetime, 0.5 SOL per call) and Token TransferChecked (1000 / 400). */
export async function cast(over: Partial<Mandate> = {}): Promise<Cast> {
  const owner = await generateKeyPairSigner()
  const agent = await generateKeyPairSigner()
  const recipient = await generateKeyPairSigner()
  const mandate: Mandate = {
    address: undefined,
    owner: owner.address,
    agent: agent.address,
    expiry: NOW + 3600n,
    active: true,
    version: 1,
    bump: 255,
    permissions: [
      permission(0, SYSTEM_PROGRAM_ID, SYSTEM_TRANSFER_DISC),
      permission(1, TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC, {
        spendLimit: 1000n,
        perTxLimit: 400n,
      }),
    ],
    ...over,
  }
  return { owner, agent, recipient, mandate }
}

/** An RPC that must never be called (static mandate + injected clock). */
export const noRpc = new Proxy(
  {},
  {
    get() {
      throw new Error('unexpected RPC call')
    },
  },
) as AgentAuthRpc

const BLOCKHASH = blockhash('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi')

export async function buildSigned(
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
) {
  return signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  )
}
