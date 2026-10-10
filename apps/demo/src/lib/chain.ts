import {
  airdropFactory,
  assertIsTransactionWithBlockhashLifetime,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  createSolanaRpcSubscriptions,
  DEFAULT_RPC_CONFIG,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from '@solana/kit'
import { parseProgramError, type AgentAuthError } from '@agentauth-sol/sdk'
import { endpointsFromEnv, type Endpoints } from './config'

/** JSON-RPC methods whose last parameter is a config object that may carry `commitment`. */
const COMMITMENT_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getBalance',
  'getSlot',
  'getBlockHeight',
  'getLatestBlockhash',
  'getSignaturesForAddress',
  'getTransaction',
  'getTokenAccountBalance',
])

/**
 * A Kit RPC whose reads default to `confirmed`.
 *
 * Needed on the local validator, where `finalized` lags about 13 s behind a confirmed write (so
 * "create a mandate, then read it" would see nothing). `createClient` has no commitment option,
 * and the SDK fetchers pass `commitment: undefined` explicitly, which Kit's own
 * `defaultCommitment` transformer treats as "given" and then drops. The transport below fills in
 * `confirmed` when the config object of a read carries no commitment.
 */
export function createConfirmedRpc(url: string) {
  const inner = createDefaultRpcTransport({ url })
  const transport: typeof inner = (request) => {
    const payload: unknown = request.payload
    if (
      isRecord(payload) &&
      typeof payload['method'] === 'string' &&
      COMMITMENT_METHODS.has(payload['method'])
    ) {
      const params = payload['params']
      const last = Array.isArray(params) ? params[params.length - 1] : undefined
      if (isRecord(last) && last['commitment'] === undefined) last['commitment'] = 'confirmed'
    }
    return inner(request)
  }
  return createRpc({
    api: createSolanaRpcApi({ ...DEFAULT_RPC_CONFIG, defaultCommitment: 'confirmed' }),
    transport,
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A transaction that failed (preflight or on chain). `programError` is the decoded program error, if any. */
export class TxFailedError extends Error {
  readonly programError: AgentAuthError | null
  constructor(cause: unknown) {
    const programError = safeParse(cause)
    const base = cause instanceof Error ? cause.message : String(cause)
    super(
      programError
        ? `${programError.program} ${programError.name} (${programError.code}): ${programError.message}`
        : base,
      { cause },
    )
    this.name = 'TxFailedError'
    this.programError = programError
  }
}

function safeParse(cause: unknown): AgentAuthError | null {
  try {
    return parseProgramError(cause)
  } catch {
    return null
  }
}

export interface SendOptions {
  /** Land the transaction even if preflight would reject it, so the failure is recorded on chain. */
  readonly skipPreflight?: boolean
  /** Default `confirmed`. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized'
}

/** RPC + websocket + the few helpers every demo script needs. Holds no secrets. */
export interface DemoChain {
  readonly endpoints: Endpoints
  readonly rpc: ReturnType<typeof createConfirmedRpc>
  /** Sign with every signer found in the instruction accounts plus `feePayer`, send, confirm. */
  send(
    instructions: readonly Instruction[],
    feePayer: TransactionSigner,
    options?: SendOptions,
  ): Promise<Signature>
  /** Faucet airdrop of `amount` lamports, confirmed. */
  airdrop(to: Address, amount: bigint): Promise<void>
  /** SOL balance in lamports. */
  balance(address: Address): Promise<bigint>
}

/** Connect to the local validator (endpoints default to `AA_RPC_URL` / `AA_WS_URL` or the fixed local ports). */
export function connect(endpoints: Endpoints = endpointsFromEnv()): DemoChain {
  const rpc = createConfirmedRpc(endpoints.rpcUrl)
  const rpcSubscriptions = createSolanaRpcSubscriptions(endpoints.wsUrl)
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })
  const airdropper = airdropFactory({ rpc, rpcSubscriptions })

  return {
    endpoints,
    rpc,
    async send(instructions, feePayer, options = {}) {
      try {
        const { value: blockhash } = await rpc
          .getLatestBlockhash({ commitment: 'confirmed' })
          .send()
        const message = pipe(
          createTransactionMessage({ version: 'legacy' }),
          (m) => setTransactionMessageFeePayerSigner(feePayer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(instructions, m),
        )
        const signed = await signTransactionMessageWithSigners(message)
        assertIsTransactionWithBlockhashLifetime(signed)
        await sendAndConfirm(signed, {
          commitment: options.commitment ?? 'confirmed',
          skipPreflight: options.skipPreflight === true,
        })
        return getSignatureFromTransaction(signed)
      } catch (error) {
        throw new TxFailedError(error)
      }
    },
    async airdrop(to, amount) {
      await airdropper({
        commitment: 'confirmed',
        recipientAddress: to,
        lamports: lamports(amount),
      })
    },
    async balance(address) {
      const { value } = await rpc.getBalance(address, { commitment: 'confirmed' }).send()
      return BigInt(value)
    },
  }
}

/** Wait until the validator answers `getHealth` (it prints nothing until it does). */
export async function waitForHealth(chain: DemoChain, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await chain.rpc.getHealth().send()
      // The first blocks need a moment before fees are stable; a slot above 0 is a cheap proxy.
      const slot = await chain.rpc.getSlot({ commitment: 'confirmed' }).send()
      if (slot > 0n) return
    } catch (error) {
      last = error
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `no healthy validator at ${chain.endpoints.rpcUrl} after ${timeoutMs / 1000}s; ` +
      `run scripts/localnet.sh start${last instanceof Error ? ` (last error: ${last.message})` : ''}`,
  )
}
