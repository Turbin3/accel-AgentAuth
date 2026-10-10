/**
 * One-line examples for API.md, for exports whose TSDoc has no @example. Real code: tsc checks it,
 * and test/recipes.test.ts proves every `#example` block is present in API.md. The shared context
 * (`owner`, `agent`, `client`, ...) is declared in the `#context` block, also printed in API.md.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  addPermissionIx,
  approveIx,
  associatedTokenAddress,
  bytesEqual,
  checkExpiry,
  checkMint,
  checkRelaySwap,
  checkRelayTransfer,
  checkTokenAccountShape,
  checkVerify,
  closePolicyIx,
  compileUnsigned,
  concatBytes,
  createAtaIdempotentIx,
  createClient,
  createMandateIx,
  decodeMandate,
  decodeMandateAccount,
  decodeMint,
  decodeRelayEvents,
  decodeRelayPolicy,
  decodeRelayPolicyAccount,
  decodeTokenAccount,
  decodeTransaction,
  defaultAmmAllowlist,
  describeInstruction,
  encodeInitPolicyData,
  encodePolicyFlags,
  encodeRelayPolicyConfig,
  errorFromCode,
  estimateTransactionSize,
  fetchMandate,
  fetchMandatesByAgent,
  fetchMandatesByOwner,
  fetchRawAccount,
  fetchRawAccounts,
  fetchRelayPolicy,
  fitsInOneTransaction,
  fromHex,
  getActivity,
  getActivityPage,
  i64ToLe,
  initPolicyIx,
  isDeployedOn,
  isDustedEmpty,
  isoOfSeconds,
  loadRegistry,
  lookupError,
  mandatePda,
  mandatesEqual,
  parseAddress,
  parseDisc,
  parseDiscList,
  parseDuration,
  parseExpiry,
  parseLimit,
  planClosePolicy,
  planPause,
  planReinitPolicy,
  planResume,
  planRevokeDiscriminator,
  planRevokePermission,
  planToJson,
  planToUnsignedTransactions,
  planUnwind,
  planUpdateLimits,
  policyToJson,
  mandateToJson,
  explanationToJson,
  activityToJson,
  preflightFailureToError,
  readI64,
  readU64,
  relayAuthorityPda,
  relayPolicyPda,
  relaySwapIx,
  relayTransferIx,
  removePermissionIx,
  revokeDelegateIx,
  revokeMandateIx,
  sendAndConfirmStep,
  setActiveIx,
  setPausedIx,
  simulateStep,
  stripSigners,
  systemTransferIx,
  toDecodableTransaction,
  toHex,
  transferCheckedIx,
  u64ToLe,
  updatePermissionIx,
  validateRelayPolicyConfig,
  assertValidRelayPolicyConfig,
  verifyIx,
  type Address,
  type AgentAuthRpc,
  type Mandate,
  type Plan,
  type RawInstruction,
  type RelayPolicy,
  type RpcTransactionLike,
  type TransactionSigner,
} from '../src/index'

// #context
declare const owner: TransactionSigner // the human's wallet
declare const agent: TransactionSigner // the agent's key
declare const rpc: AgentAuthRpc
declare const mandateAddress: Address
declare const mandate: Mandate
declare const policy: RelayPolicy
declare const plan: Plan
declare const mint: Address
declare const source: Address
declare const destination: Address
declare const blockhash: { blockhash: string; lastValidBlockHeight: bigint }
declare const accountBytes: Uint8Array
declare const tx: RpcTransactionLike
declare const signature: string
declare const logs: string[]
declare const ixData: RawInstruction
const client = createClient({ cluster: 'devnet' })
// #endcontext

export async function examples() {
  // #example isDeployedOn
  isDeployedOn('mainnet-beta') // false: devnet prototype
  // #endexample isDeployedOn
  // #example bytesEqual
  bytesEqual(new Uint8Array([1]), new Uint8Array([1])) // true
  // #endexample bytesEqual
  // #example concatBytes
  concatBytes(new Uint8Array([3]), u64ToLe(5n))
  // #endexample concatBytes
  // #example fromHex
  fromHex('0c00000000000000', 8)
  // #endexample fromHex
  // #example toHex
  toHex(new Uint8Array([12, 0])) // "0c00"
  // #endexample toHex
  // #example u64ToLe
  u64ToLe(1_000_000n) // 8 bytes, little endian
  // #endexample u64ToLe
  // #example i64ToLe
  i64ToLe(1_800_000_000n)
  // #endexample i64ToLe
  // #example readU64
  readU64(accountBytes, 64)
  // #endexample readU64
  // #example readI64
  readI64(accountBytes, 65)
  // #endexample readI64
  // #example associatedTokenAddress
  const ata = await associatedTokenAddress(owner.address, mint, TOKEN_PROGRAM_ID)
  void [ata.address, ASSOCIATED_TOKEN_PROGRAM_ID]
  // #endexample associatedTokenAddress
  // #example mandatePda
  const { address: mandateAddr, bump } = await mandatePda(owner.address, agent.address)
  // #endexample mandatePda
  void [mandateAddr, bump]
  // #example relayAuthorityPda
  const { address: authority } = await relayAuthorityPda(mandateAddress) // the SPL delegate
  // #endexample relayAuthorityPda
  void authority
  // #example relayPolicyPda
  const { address: policyAddress } = await relayPolicyPda(mandateAddress)
  // #endexample relayPolicyPda
  void policyAddress
  // #example decodeMandate
  const decoded = decodeMandate(accountBytes, mandateAddress) // throws DecodeError on bad bytes
  // #endexample decodeMandate
  void decoded
  // #example decodeMandateAccount
  const raw = await fetchRawAccount(rpc, mandateAddress)
  const m = raw && (await decodeMandateAccount(raw)) // also checks owner program and PDA address
  // #endexample decodeMandateAccount
  void m
  // #example decodeRelayPolicy
  const p = decodeRelayPolicy(accountBytes, policyAddress)
  // #endexample decodeRelayPolicy
  void p
  // #example decodeRelayPolicyAccount
  const rawPolicy = await fetchRawAccount(rpc, policyAddress)
  const pol = rawPolicy && (await decodeRelayPolicyAccount(rawPolicy))
  // #endexample decodeRelayPolicyAccount
  void pol
  // #example fetchMandate
  const found = await fetchMandate(rpc, mandateAddress, { commitment: 'confirmed' }) // null if missing
  // #endexample fetchMandate
  void found
  // #example fetchRelayPolicy
  const foundPolicy = await fetchRelayPolicy(rpc, policyAddress)
  // #endexample fetchRelayPolicy
  void foundPolicy
  // #example fetchMandatesByOwner
  const mine = await fetchMandatesByOwner(rpc, owner.address, { limit: 50 })
  // #endexample fetchMandatesByOwner
  void mine
  // #example fetchMandatesByAgent
  const naming = await fetchMandatesByAgent(rpc, agent.address, { owners: [owner.address] })
  // #endexample fetchMandatesByAgent
  void naming
  // #example fetchRawAccount
  const account = await fetchRawAccount(rpc, source) // { ownerProgram, data, lamports, ... } | null
  // #endexample fetchRawAccount
  void account
  // #example fetchRawAccounts
  const [a, b] = await fetchRawAccounts(rpc, [source, destination]) // one RPC
  // #endexample fetchRawAccounts
  void [a, b]
  // #example isDustedEmpty
  const dusted = account !== null && isDustedEmpty(account) // pre-funded, never created
  // #endexample isDustedEmpty
  void dusted
  // #example mandatesEqual
  mandatesEqual(mandate, mandate) // true
  // #endexample mandatesEqual
  // #example defaultAmmAllowlist
  const validation = { ammAllowlist: defaultAmmAllowlist('devnet') }
  // #endexample defaultAmmAllowlist
  void validation
  // #example validateRelayPolicyConfig
  const problems = validateRelayPolicyConfig(policy) // string[] of every problem, [] when valid
  // #endexample validateRelayPolicyConfig
  void problems
  // #example assertValidRelayPolicyConfig
  assertValidRelayPolicyConfig(policy) // throws ValidationError listing the problems
  // #endexample assertValidRelayPolicyConfig
  // #example encodeRelayPolicyConfig
  const config800 = encodeRelayPolicyConfig(policy) // the 800-byte config region
  // #endexample encodeRelayPolicyConfig
  void config800
  // #example encodePolicyFlags
  encodePolicyFlags({ paused: false, strictTopLevel: true }) // 2
  // #endexample encodePolicyFlags
  // #example encodeInitPolicyData
  const initData = encodeInitPolicyData({ strictTopLevel: true }, policy) // 802 bytes
  // #endexample encodeInitPolicyData
  void initData
  // #example checkMint
  checkMint(await fetchRawAccount(rpc, mint), TOKEN_PROGRAM_ID) // { ok: true } | { ok: false, code: 103 }
  // #endexample checkMint
  // #example checkTokenAccountShape
  checkTokenAccountShape(account, TOKEN_PROGRAM_ID) // { ok: false, code: 103 | 105 } on a bad account
  // #endexample checkTokenAccountShape
  // #example decodeMint
  const { decimals } = decodeMint(accountBytes)
  // #endexample decodeMint
  void decimals
  // #example decodeTokenAccount
  const { delegate, delegatedAmount, amount } = decodeTokenAccount(accountBytes)
  // #endexample decodeTokenAccount
  void [delegate, delegatedAmount, amount]
  // #example createMandateIx
  const create = await createMandateIx({ owner, agent: agent.address, expiry: 1_900_000_000n })
  // #endexample createMandateIx
  void create
  // #example addPermissionIx
  const add = await addPermissionIx({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
    spendLimit: 250_000_000n,
    perTxLimit: 25_000_000n,
    discriminators: [TRANSFER_CHECKED_DISC],
  })
  // #endexample addPermissionIx
  void add
  // #example removePermissionIx
  const remove = await removePermissionIx({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
  })
  // #endexample removePermissionIx
  void remove
  // #example updatePermissionIx
  const update = await updatePermissionIx({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
    spendLimit: 'unlimited', // 0n is rejected: say "unlimited" when you mean it
    perTxLimit: 10_000_000n,
  })
  // #endexample updatePermissionIx
  void update
  // #example setActiveIx
  const pause = await setActiveIx({ owner, agent: agent.address, active: false })
  // #endexample setActiveIx
  void pause
  // #example revokeMandateIx
  const kill = await revokeMandateIx({ owner, agent: agent.address }) // destroys the mandate
  // #endexample revokeMandateIx
  void kill
  // #example verifyIx
  const verify = verifyIx({
    mandate: mandateAddress,
    owner: owner.address,
    agent,
    targetProgram: TOKEN_PROGRAM_ID,
    discriminator: TRANSFER_CHECKED_DISC,
    amount: 5_000_000n,
  })
  // #endexample verifyIx
  void verify
  // #example parseDisc
  parseDisc('0c00000000000000') // Uint8Array(8); also accepts 8 bytes
  // #endexample parseDisc
  // #example parseDiscList
  parseDiscList([TRANSFER_CHECKED_DISC, SWAP_BASE_INPUT_DISC]) // 1..8, no duplicates
  // #endexample parseDiscList
  // #example parseLimit
  parseLimit('unlimited', 'spendLimit') // 0n on chain; bare 0n is refused (ZERO_LIMIT_AMBIGUOUS)
  // #endexample parseLimit
  // #example initPolicyIx
  const init = await initPolicyIx({ owner, agent: agent.address, config: policy })
  // #endexample initPolicyIx
  void init
  // #example setPausedIx
  const pauseRelay = await setPausedIx({ owner, agent: agent.address, paused: true })
  // #endexample setPausedIx
  void pauseRelay
  // #example closePolicyIx
  const close = await closePolicyIx({ owner, agent: agent.address })
  // #endexample closePolicyIx
  void close
  // #example relayTransferIx
  const pay = await relayTransferIx({ agent, policy, destination, amount: 5_000_000n })
  // #endexample relayTransferIx
  void pay
  // #example relaySwapIx
  const swap = await relaySwapIx({
    agent,
    policy,
    amountIn: 1_000_000n,
    minOut: 900_000n,
    deadlineSlot: 123_456_789n,
  })
  // #endexample relaySwapIx
  void swap
  // #example approveIx
  const approve = await approveIx({ source, owner, mandate: mandateAddress, amount: 250_000_000n })
  // #endexample approveIx
  void approve
  // #example revokeDelegateIx
  const revoke = revokeDelegateIx({ source, owner })
  // #endexample revokeDelegateIx
  void revoke
  // #example transferCheckedIx
  const raw1 = transferCheckedIx({
    source,
    mint,
    destination,
    authority: owner,
    amount: 1n,
    decimals: 6,
  })
  // #endexample transferCheckedIx
  void raw1
  // #example createAtaIdempotentIx
  const makeAta = await createAtaIdempotentIx({ payer: owner, owner: agent.address, mint })
  // #endexample createAtaIdempotentIx
  void makeAta
  // #example systemTransferIx
  const fund = systemTransferIx({ from: owner, to: agent.address, lamports: 5_000_000n })
  // #endexample systemTransferIx
  void fund
  // #example errorFromCode
  errorFromCode('relay', 104).hint // build the same error object an on-chain failure gives
  // #endexample errorFromCode
  // #example lookupError
  lookupError('agent_auth', 9)?.name // "SpendLimitExceeded"
  // #endexample lookupError
  // #example checkVerify
  const v = checkVerify(
    mandate,
    {
      owner: owner.address,
      agent: agent.address,
      targetProgram: TOKEN_PROGRAM_ID,
      discriminator: TRANSFER_CHECKED_DISC,
      amount: 1n,
    },
    { now: 1_800_000_000n },
  )
  // #endexample checkVerify
  void v
  // #example checkRelayTransfer
  const t = checkRelayTransfer(
    policy,
    mandate,
    { source: account, destination: account, mint: account },
    { agent: agent.address, amount: 1n, destination, now: 1_800_000_000n },
  )
  // #endexample checkRelayTransfer
  void t
  // #example checkRelaySwap
  const s = checkRelaySwap(
    policy,
    mandate,
    {},
    {
      agent: agent.address,
      amountIn: 1n,
      minOut: 1n,
      deadlineSlot: 10n,
      currentSlot: 5n,
      now: 1_800_000_000n,
    },
  )
  // #endexample checkRelaySwap
  void s
  // #example preflightFailureToError
  if (!v.ok) throw preflightFailureToError(v)
  // #endexample preflightFailureToError
  // #example checkExpiry
  checkExpiry(1_800_000_000n * 1000n) // ["... looks like MILLISECONDS ..."]
  // #endexample checkExpiry
  // #example isoOfSeconds
  isoOfSeconds(1_800_000_000n) // "2027-01-15T08:00:00.000Z"
  // #endexample isoOfSeconds
  // #example parseDuration
  parseDuration('90m') // 5400n
  // #endexample parseDuration
  // #example parseExpiry
  parseExpiry('2030-01-01T00:00:00Z') // 1893456000n
  // #endexample parseExpiry
  // #example describeInstruction
  describeInstruction(TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC).title // "Transfer (checked)"
  // #endexample describeInstruction
  // #example loadRegistry
  const registry = await loadRegistry() // the registry package if installed, else null
  const c2 = createClient({ registry })
  // #endexample loadRegistry
  void c2
  // #example planPause
  const paused = await planPause({ owner, agent: agent.address, scope: 'both' }) // unsigned
  // #endexample planPause
  void paused
  // #example planResume
  const resumed = await planResume({ owner, agent: agent.address })
  // #endexample planResume
  void resumed
  // #example planUnwind
  const unwind = await planUnwind({
    owner,
    agent: agent.address,
    tokenAccounts: [{ address: source }],
  })
  // #endexample planUnwind
  void unwind
  // #example planRevokePermission
  const revokeSlot = await planRevokePermission({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
  })
  // #endexample planRevokePermission
  void revokeSlot
  // #example planRevokeDiscriminator
  const narrow = await planRevokeDiscriminator({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
    discriminators: [TRANSFER_CHECKED_DISC],
    chainState: { mandate, policy: null },
  })
  // #endexample planRevokeDiscriminator
  void narrow
  // #example planUpdateLimits
  const lower = await planUpdateLimits({
    owner,
    agent: agent.address,
    program: TOKEN_PROGRAM_ID,
    spendLimit: 50_000_000n,
    perTxLimit: 5_000_000n,
  })
  // #endexample planUpdateLimits
  void lower
  // #example planClosePolicy
  const closePlan = await planClosePolicy({ owner, agent: agent.address })
  // #endexample planClosePolicy
  void closePlan
  // #example planReinitPolicy
  const reinit = await planReinitPolicy({ owner, agent: agent.address, config: policy })
  // #endexample planReinitPolicy
  void reinit
  // #example fitsInOneTransaction
  fitsInOneTransaction(plan.steps[0]!.instructions, owner.address, {
    version: 0,
    computeBudget: true,
  })
  // #endexample fitsInOneTransaction
  // #example estimateTransactionSize
  estimateTransactionSize(plan.steps[0]!.instructions, owner.address, { version: 0 })
  // #endexample estimateTransactionSize
  // #example compileUnsigned
  const { base64 } = compileUnsigned(plan.steps[0]!, { feePayer: owner.address, blockhash })
  // #endexample compileUnsigned
  void base64
  // #example planToUnsignedTransactions
  const unsigned = planToUnsignedTransactions(plan, {
    feePayer: owner.address,
    blockhash,
    microLamportsPerCu: 10_000n,
  })
  // #endexample planToUnsignedTransactions
  void unsigned
  // #example simulateStep
  const sim = await simulateStep(rpc, plan.steps[0]!, { feePayer: owner.address })
  if (!sim.ok) console.log(sim.error?.name, sim.logs)
  // #endexample simulateStep
  // #example sendAndConfirmStep
  const sent = await sendAndConfirmStep(rpc, plan.steps[0]!, {
    signers: [owner],
    commitment: 'confirmed',
  })
  // #endexample sendAndConfirmStep
  void sent
  // #example stripSigners
  console.log(JSON.stringify(stripSigners(plan))) // safe to log: no signer objects
  // #endexample stripSigners
  // #example mandateToJson
  JSON.stringify(mandateToJson(mandate))
  // #endexample mandateToJson
  // #example policyToJson
  JSON.stringify(policyToJson(policy))
  // #endexample policyToJson
  // #example explanationToJson
  JSON.stringify(explanationToJson(client.explain(mandate)))
  // #endexample explanationToJson
  // #example planToJson
  JSON.stringify(planToJson(plan))
  // #endexample planToJson
  // #example activityToJson
  JSON.stringify(activityToJson(await client.activity({ mandate: mandateAddress, limit: 20 })))
  // #endexample activityToJson
  // #example decodeRelayEvents
  const events = decodeRelayEvents(logs, client.programIds.relay) // forgery-proof: stack-aware
  // #endexample decodeRelayEvents
  void events
  // #example decodeTransaction
  const rows = decodeTransaction(toDecodableTransaction(signature, tx), { mandate: mandateAddress })
  // #endexample decodeTransaction
  void rows
  // #example toDecodableTransaction
  const decodable = toDecodableTransaction(signature, tx) // from getTransaction(..., {encoding:'json'})
  // #endexample toDecodableTransaction
  void [decodable, ixData]
  // #example getActivity
  const feed = await getActivity(rpc, { mandate: mandateAddress, limit: 25 })
  // #endexample getActivity
  void feed
  // #example getActivityPage
  const page = await getActivityPage(rpc, { mandate: mandateAddress, limit: 25 })
  const older =
    page.nextBefore &&
    (await getActivityPage(rpc, { mandate: mandateAddress, limit: 25, before: page.nextBefore }))
  // #endexample getActivityPage
  void older
  // #example parseAddress
  parseAddress('11111111111111111111111111111111') // throws SdkError BAD_ADDRESS otherwise
  // #endexample parseAddress
}
