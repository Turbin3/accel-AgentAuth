import { address as toAddress, createSolanaRpc, getBase64Encoder, type Address } from '@solana/kit'
import {
  getActivity,
  getActivityPage,
  type ActivityItem,
  type ActivityPage,
  type GetActivityOptions,
} from './activity'
import {
  decodeMandateAccount,
  decodeRelayPolicyAccount,
  fetchMandate,
  fetchMandatesByAgent,
  fetchMandatesByOwner,
  fetchRawAccount,
  fetchRawAccounts,
  fetchRelayPolicy,
  isDustedEmpty,
  type ListOptions,
  type RawAccount,
} from './accounts'
import { readI64 } from './bytes'
import {
  CLUSTER_RPC_URLS,
  isDeployedOn,
  programIds as buildProgramIds,
  type Cluster,
  type ProgramIds,
} from './constants'
import { capacity, type Capacity } from './capacity'
import { explainMandate, type ExplainOptions, type Explanation } from './explain'
import { mandatePda, relayAuthorityPda, relayPolicyPda } from './pda'
import {
  checkRelaySwap,
  checkRelayTransfer,
  type RelaySwapResult,
  type RelayTransferResult,
} from './preflight'
import {
  planClosePolicy,
  planOnboarding,
  planPause,
  planReinitPolicy,
  planResume,
  planRevokeDiscriminator,
  planRevokePermission,
  planUnwind,
  planUpdateLimits,
  type ChainState,
  type ClosePolicyInput,
  type OnboardingInput,
  type PauseInput,
  type Plan,
  type ReinitPolicyInput,
  type RevokeDiscriminatorInput,
  type RevokePermissionInput,
  type UnwindInput,
  type UpdateLimitsInput,
} from './plans'
import { builtinRegistry, type RegistryLike } from './registry'
import { DecodeError, SdkError } from './sdk-errors'
import { decodeMint, decodeTokenAccount, type MintView, type TokenAccountView } from './token-state'
import {
  simulateStep,
  sendAndConfirmStep,
  type SendOptions,
  type SendResult,
  type SimulateOptions,
  type SimulationResult,
  type StepLike,
} from './tx'
import type { AgentAuthRpc, Mandate, RelayPolicy } from './types'
import type { Commitment } from '@solana/kit'
import { addressOf, type AddressOrSigner } from './ix'

/** Options of {@link createClient}. */
export interface CreateClientOptions {
  /** Cluster preset. Default `"devnet"`. Ignored for the RPC when `rpc` or `rpcUrl` is given. */
  readonly cluster?: Cluster
  /** Your own RPC (for example `createSolanaRpc(url)`). */
  readonly rpc?: AgentAuthRpc
  /** RPC URL to build a Kit RPC from. */
  readonly rpcUrl?: string
  /** Program id overrides (localnet / tests). */
  readonly programIds?: Partial<ProgramIds>
  /** Registry for names and risk classes (the built-in table is the fallback). */
  readonly registry?: RegistryLike | null
  /** Accept version-0 (pre-hardening) mandates. Default false. */
  readonly acceptLegacyMandates?: boolean
  /**
   * Commitment for every read. Default `"confirmed"` (a dashboard that just confirmed a transaction
   * sees its effect; `finalized` lags about 13 seconds).
   */
  readonly commitment?: Exclude<Commitment, 'processed'>
  /**
   * AgentAuth and the relay are deployed on devnet only. `cluster: 'mainnet-beta'` throws
   * `NOT_DEPLOYED` unless both program ids are overridden or this is set to true.
   */
  readonly acknowledgeNoMainnet?: boolean
}

/** A delegation found by {@link Client.findDelegationsTo}. */
export interface FoundDelegation {
  readonly address: Address
  readonly tokenProgram: Address
  readonly delegate: Address
  readonly delegatedAmount: bigint
  readonly mint: Address
}

/** Plan builders with the chain state pre-filled from the RPC. */
export interface ClientPlans {
  onboarding(input: Omit<OnboardingInput, 'chainState' | 'programIds' | 'registry'>): Promise<Plan>
  unwind(input: Omit<UnwindInput, 'chainState' | 'programIds'>): Promise<Plan>
  pause(input: Omit<PauseInput, 'chainState' | 'programIds'>): Promise<Plan>
  resume(input: Omit<PauseInput, 'chainState' | 'programIds'>): Promise<Plan>
  revokePermission(input: Omit<RevokePermissionInput, 'chainState' | 'programIds'>): Promise<Plan>
  /** Take one (or a few) discriminators away from a permission, keeping the rest and the budget. */
  revokeDiscriminator(
    input: Omit<RevokeDiscriminatorInput, 'chainState' | 'programIds'>,
  ): Promise<Plan>
  updateLimits(input: Omit<UpdateLimitsInput, 'chainState' | 'programIds'>): Promise<Plan>
  closePolicy(input: Omit<ClosePolicyInput, 'chainState' | 'programIds'>): Promise<Plan>
  reinitPolicy(input: Omit<ReinitPolicyInput, 'chainState' | 'programIds'>): Promise<Plan>
}

/** A mandate with its related accounts, as `inspect` returns it. */
export interface MandateView {
  readonly address: Address
  readonly mandate: Mandate | null
  readonly policy: RelayPolicy | null
  readonly explanation: Explanation | null
  /** Live SPL delegation on the policy source account, when a policy exists. */
  readonly delegation: { delegate: Address | null; delegatedAmount: bigint } | null
  /** Source account balance (raw units) when it could be read. */
  readonly balance: bigint | null
  /** Structured relay capacity, when a policy exists. */
  readonly capacity: Capacity | null
}

/** Options of {@link Client.inspect}. */
export interface InspectOptions extends Pick<
  ExplainOptions,
  'budgetDecimals' | 'budgetSymbol' | 'mintLabels' | 'now'
> {
  /** An already-fetched mandate (skips refetching it). */
  readonly mandate?: Mandate
}

/** Inputs shared by the two preflights. */
interface PreflightBase {
  owner: Address
  agent: Address
  /** Unix seconds; defaults to the CLUSTER clock (Clock sysvar), not the local wall clock. */
  now?: bigint | number
}

/** The bundled convenience client. It holds only configuration and the RPC; no global state. */
export interface Client {
  readonly cluster: Cluster
  readonly rpc: AgentAuthRpc
  readonly programIds: ProgramIds
  readonly registry: RegistryLike
  /** Fetch a mandate by address; `null` when it does not exist (also for a dusted, system-owned PDA). */
  fetchMandate(address: Address): Promise<Mandate | null>
  /** Fetch the mandate of an (owner, agent) pair. */
  fetchMandateFor(
    owner: Address,
    agent: Address,
  ): Promise<{ address: Address; mandate: Mandate | null }>
  /** Fetch the relay policy of a mandate; `null` when it does not exist. */
  fetchPolicy(mandate: Address): Promise<RelayPolicy | null>
  /** Fetch and decode an SPL mint (decimals, supply, authorities); `null` when it does not exist. */
  fetchMint(mint: Address): Promise<MintView | null>
  /** Current cluster unix time in seconds, from the Clock sysvar. */
  getClusterTime(): Promise<bigint>
  mandatesByOwner(owner: Address, opts?: Pick<ListOptions, 'onSkip' | 'limit'>): Promise<Mandate[]>
  /**
   * Mandates naming `agent`. WARNING: anybody can create a mandate that names any agent; pass
   * `owners` (the owners you trust) before presenting these as authorisations.
   */
  mandatesByAgent(
    agent: Address,
    opts?: Pick<ListOptions, 'onSkip' | 'owners' | 'limit'>,
  ): Promise<Mandate[]>
  /** Explain a mandate you already hold (uses the client's registry). */
  explain(mandate: Mandate, opts?: ExplainOptions): Explanation
  /**
   * Fetch mandate + policy + delegation + mint decimals (3 round trips at most, batched with
   * `getMultipleAccounts`) and explain it. Accepts an address or `{ mandate }` for one you hold.
   */
  inspect(address: Address, opts?: InspectOptions): Promise<MandateView>
  /** Unsigned plans with chain state filled in. */
  readonly plan: ClientPlans
  /** Pre-flight a relay transfer against live chain data. */
  preflightTransfer(
    input: PreflightBase & { destination: Address; amount: bigint },
  ): Promise<RelayTransferResult>
  /** Pre-flight a relay swap against live chain data. */
  preflightSwap(
    input: PreflightBase & { amountIn: bigint; minOut: bigint; deadlineSlot: bigint },
  ): Promise<RelaySwapResult>
  /** Structured "how much can the agent move right now" for an (owner, agent) pair. */
  capacityFor(
    owner: Address,
    agent: Address,
  ): Promise<Capacity & { readonly mandateFound: boolean }>
  /** Activity feed of a mandate (and optionally its policy). */
  activity(opts: Omit<GetActivityOptions, 'registry' | 'programIds'>): Promise<ActivityItem[]>
  /** Like `activity` but with the `nextBefore` cursor for paging. */
  activityPage(opts: Omit<GetActivityOptions, 'registry' | 'programIds'>): Promise<ActivityPage>
  /** Simulate a step or instruction list without signing: logs, units, decoded error. */
  simulate(source: StepLike, opts: SimulateOptions): Promise<SimulationResult>
  /** Sign, send and wait for confirmation; a landed failure returns `ok: false` with the decoded error. */
  sendAndConfirm(source: StepLike, opts: SendOptions): Promise<SendResult>
  /**
   * Find token accounts of `owner` whose SPL delegate is one of `delegates` (for example the relay
   * authority of a mandate whose policy is already closed). Uses `getTokenAccountsByOwner`.
   */
  findDelegationsTo(owner: Address, delegates: readonly Address[]): Promise<FoundDelegation[]>
}

/**
 * Create the convenience client. Three lines to read a mandate:
 *
 * @example
 * const client = createClient({ cluster: 'devnet' })
 * const mandate = await client.fetchMandate(address)
 * console.log(mandate && client.explain(mandate).headline)
 *
 * @throws SdkError `NOT_DEPLOYED` for `mainnet-beta` without program id overrides
 */
export function createClient(opts: CreateClientOptions = {}): Client {
  const cluster = opts.cluster ?? 'devnet'
  if (
    !isDeployedOn(cluster) &&
    opts.acknowledgeNoMainnet !== true &&
    !(opts.programIds?.agentAuth && opts.programIds?.relay)
  ) {
    throw new SdkError(
      'NOT_DEPLOYED',
      `AgentAuth and the relay are not deployed on ${cluster} (devnet prototype). Override programIds, or pass acknowledgeNoMainnet: true to build transactions anyway.`,
    )
  }
  const ids = buildProgramIds(cluster, opts.programIds)
  const rpc: AgentAuthRpc =
    opts.rpc ??
    (createSolanaRpc(opts.rpcUrl ?? CLUSTER_RPC_URLS[cluster]) as unknown as AgentAuthRpc)
  const registry = opts.registry ?? builtinRegistry
  const commitment = opts.commitment ?? 'confirmed'
  const fetchOpts = {
    programIds: ids,
    commitment,
    acceptLegacyVersion: opts.acceptLegacyMandates === true,
  }

  /** Raw account that exists for AgentAuth purposes (null for missing or dusted system accounts). */
  const present = (raw: RawAccount | null): RawAccount | null =>
    raw && !isDustedEmpty(raw) ? raw : null

  const tokenAccountView = (raw: RawAccount | null): TokenAccountView | null => {
    if (!raw) return null
    try {
      return decodeTokenAccount(raw.data)
    } catch {
      return null
    }
  }

  const locate = async (
    owner: Address,
    agent: Address | undefined,
    mandate?: Address,
  ): Promise<Address> => {
    const mandateAddress =
      mandate ?? (agent ? (await mandatePda(owner, agent, ids.agentAuth)).address : undefined)
    if (!mandateAddress) {
      throw new SdkError(
        'MISSING_ADDRESS',
        'client.plan.* needs `agent` or `mandate` to locate the mandate (owner alone is not enough)',
      )
    }
    return mandateAddress
  }

  const stateFor = async (
    owner: Address,
    agent: Address | undefined,
    mandate?: Address,
    extraAccounts: readonly Address[] = [],
  ): Promise<ChainState> => {
    const mandateAddress = await locate(owner, agent, mandate)
    const policyAddress = (await relayPolicyPda(mandateAddress, ids.relay)).address
    const [m, p] = await Promise.all([
      fetchMandate(rpc, mandateAddress, fetchOpts),
      fetchRelayPolicy(rpc, policyAddress, fetchOpts),
    ])
    const wanted = new Set<Address>(extraAccounts)
    if (p) {
      wanted.add(p.sourceAccount)
      if (p.swap) wanted.add(p.swap.inAccount)
    }
    let tokenAccounts: Record<string, TokenAccountView | null> | undefined
    if (wanted.size > 0) {
      const list = [...wanted]
      const raws = await fetchRawAccounts(rpc, list, { commitment })
      tokenAccounts = {}
      list.forEach((a, i) => {
        tokenAccounts![a] = tokenAccountView(raws[i] ?? null)
      })
    }
    return { mandate: m, policy: p, ...(tokenAccounts ? { tokenAccounts } : {}) }
  }

  const withState = async <
    T extends { owner: AddressOrSigner; agent?: Address; mandate?: Address },
  >(
    input: T,
    extraAccounts: readonly Address[] = [],
  ): Promise<T & { chainState: ChainState; programIds: ProgramIds }> => ({
    ...input,
    chainState: await stateFor(addressOf(input.owner), input.agent, input.mandate, extraAccounts),
    programIds: ids,
  })

  const getClusterTime = async (): Promise<bigint> => {
    const clock = await fetchRawAccount(rpc, CLOCK_SYSVAR, { commitment })
    if (!clock || clock.data.length < 40) {
      throw new DecodeError('BAD_ACCOUNT_DATA', 'Clock sysvar could not be read')
    }
    return readI64(clock.data, 32)
  }

  const loadFlow = async (owner: Address, agent: Address) => {
    const mandateAddress = (await mandatePda(owner, agent, ids.agentAuth)).address
    const policyAddress = (await relayPolicyPda(mandateAddress, ids.relay)).address
    const [mandate, policy] = await Promise.all([
      fetchMandate(rpc, mandateAddress, fetchOpts),
      fetchRelayPolicy(rpc, policyAddress, fetchOpts),
    ])
    return { mandate, policy, mandateAddress }
  }

  const clock = async (now: bigint | number | undefined): Promise<bigint | number> =>
    now ?? (await getClusterTime())

  const client: Client = {
    cluster,
    rpc,
    programIds: ids,
    registry,
    fetchMandate: (address) => fetchMandate(rpc, address, fetchOpts),
    async fetchMandateFor(owner, agent) {
      const { address } = await mandatePda(owner, agent, ids.agentAuth)
      return { address, mandate: await fetchMandate(rpc, address, fetchOpts) }
    },
    fetchPolicy: async (mandate) => {
      const { address } = await relayPolicyPda(mandate, ids.relay)
      return fetchRelayPolicy(rpc, address, fetchOpts)
    },
    async fetchMint(mint) {
      const raw = await fetchRawAccount(rpc, mint, { commitment })
      return raw ? decodeMint(raw.data) : null
    },
    getClusterTime,
    mandatesByOwner: (owner, o) => fetchMandatesByOwner(rpc, owner, { ...fetchOpts, ...o }),
    mandatesByAgent: (agent, o) => fetchMandatesByAgent(rpc, agent, { ...fetchOpts, ...o }),
    explain: (mandate, o) => explainMandate(mandate, { registry, ...o }),
    async inspect(address, o = {}) {
      const policyAddress = (await relayPolicyPda(address, ids.relay)).address
      let mandate: Mandate | null
      let policyRaw: RawAccount | null
      if (o.mandate) {
        mandate = o.mandate
        policyRaw = present(await fetchRawAccount(rpc, policyAddress, { commitment }))
      } else {
        const [mRaw, pRaw] = await fetchRawAccounts(rpc, [address, policyAddress], { commitment })
        const mp = present(mRaw ?? null)
        mandate = mp ? await decodeMandateAccount(mp, fetchOpts) : null
        policyRaw = present(pRaw ?? null)
      }
      if (!mandate) {
        return {
          address,
          mandate: null,
          policy: null,
          explanation: null,
          delegation: null,
          balance: null,
          capacity: null,
        }
      }
      const policy = policyRaw ? await decodeRelayPolicyAccount(policyRaw, fetchOpts) : null
      let delegation: MandateView['delegation'] = null
      let balance: bigint | null = null
      let decimals = o.budgetDecimals
      if (policy) {
        const [src, mintRaw] = await fetchRawAccounts(
          rpc,
          [policy.sourceAccount, policy.budgetMint],
          {
            commitment,
          },
        )
        const t = tokenAccountView(src ?? null)
        if (t) {
          delegation = { delegate: t.delegate, delegatedAmount: t.delegatedAmount }
          balance = t.amount
        }
        if (decimals === undefined && mintRaw && mintRaw.data.length >= 82) {
          decimals = decodeMint(mintRaw.data).decimals
        }
      }
      const now =
        o.now === undefined
          ? await getClusterTime()
          : o.now instanceof Date
            ? BigInt(Math.floor(o.now.getTime() / 1000))
            : o.now
      const explanation = explainMandate(mandate, {
        registry,
        policy,
        delegation,
        mandateAddress: address,
        now,
        ...(o.budgetSymbol !== undefined ? { budgetSymbol: o.budgetSymbol } : {}),
        ...(o.mintLabels !== undefined ? { mintLabels: o.mintLabels } : {}),
        ...(decimals !== undefined ? { budgetDecimals: decimals } : {}),
      })
      const cap = policy ? capacity(mandate, policy, { delegation, balance, now }) : null
      return { address, mandate, policy, explanation, delegation, balance, capacity: cap }
    },
    plan: {
      onboarding: async (input) =>
        planOnboarding({
          ...(await withState(input, [
            input.token.source,
            ...(input.swap ? [input.swap.inAccount] : []),
          ])),
          registry,
        }),
      unwind: async (input) => {
        const base = await withState(input)
        let supplement: string | undefined
        if (base.chainState.policy === null && input.tokenAccounts === undefined) {
          // The policy is gone, so no token account is derivable: look for delegations to the authority.
          try {
            const mandateAddress = await locate(addressOf(input.owner), input.agent, input.mandate)
            const authority = (await relayAuthorityPda(mandateAddress, ids.relay)).address
            const found = await client.findDelegationsTo(addressOf(input.owner), [authority])
            const plan = await planUnwind({
              ...base,
              tokenAccounts: found.map((f) => ({
                address: f.address,
                tokenProgram: f.tokenProgram,
              })),
            })
            return plan
          } catch (error) {
            supplement = `Could not search for delegations to the relay authority (${error instanceof Error ? error.message : String(error)}); pass tokenAccounts to revoke them.`
          }
        }
        const plan = await planUnwind(base)
        return supplement ? { ...plan, warnings: [...plan.warnings, supplement] } : plan
      },
      pause: async (input) => planPause(await withState(input)),
      resume: async (input) => planResume(await withState(input)),
      revokePermission: async (input) => planRevokePermission(await withState(input)),
      revokeDiscriminator: async (input) => planRevokeDiscriminator(await withState(input)),
      updateLimits: async (input) => planUpdateLimits(await withState(input)),
      closePolicy: async (input) => planClosePolicy(await withState(input)),
      reinitPolicy: async (input) => planReinitPolicy(await withState(input)),
    },
    async preflightTransfer(input) {
      const [{ mandate, policy }, now] = await Promise.all([
        loadFlow(input.owner, input.agent),
        clock(input.now),
      ])
      const [source, destination, mint] = await Promise.all([
        policy ? fetchRawAccount(rpc, policy.sourceAccount, { commitment }) : null,
        fetchRawAccount(rpc, input.destination, { commitment }),
        policy ? fetchRawAccount(rpc, policy.budgetMint, { commitment }) : null,
      ])
      return checkRelayTransfer(
        policy,
        mandate,
        { source, destination, mint },
        {
          agent: input.agent,
          amount: input.amount,
          destination: input.destination,
          now,
          programIds: ids,
        },
      )
    },
    async preflightSwap(input) {
      const [{ mandate, policy }, now] = await Promise.all([
        loadFlow(input.owner, input.agent),
        clock(input.now),
      ])
      const swap = policy?.swap ?? null
      const [inAccount, outAccount, inMint, outMint] = await Promise.all([
        swap ? fetchRawAccount(rpc, swap.inAccount, { commitment }) : null,
        swap ? fetchRawAccount(rpc, swap.outAccount, { commitment }) : null,
        swap ? fetchRawAccount(rpc, swap.inMint, { commitment }) : null,
        swap ? fetchRawAccount(rpc, swap.outMint, { commitment }) : null,
      ])
      const slot = await rpc.getSlot({ commitment }).send()
      return checkRelaySwap(
        policy,
        mandate,
        { inAccount, outAccount, inMint, outMint },
        {
          agent: input.agent,
          amountIn: input.amountIn,
          minOut: input.minOut,
          deadlineSlot: input.deadlineSlot,
          currentSlot: BigInt(slot),
          now,
          programIds: ids,
        },
      )
    },
    async capacityFor(owner, agent) {
      const { mandate, policy, mandateAddress } = await loadFlow(owner, agent)
      if (!mandate) {
        return {
          maxSpendNow: 0n,
          limitedBy: [],
          blockedBy: {
            program: 'agent_auth',
            code: 14,
            name: 'InvalidMandate',
            why: `no mandate exists at ${mandateAddress}`,
          },
          bounds: { perCall: null, mandateBudget: null, delegation: null, balance: null },
          partial: false,
          mandateFound: false,
        }
      }
      let delegation: MandateView['delegation'] = null
      let balance: bigint | null = null
      if (policy) {
        const t = tokenAccountView(await fetchRawAccount(rpc, policy.sourceAccount, { commitment }))
        if (t) {
          delegation = { delegate: t.delegate, delegatedAmount: t.delegatedAmount }
          balance = t.amount
        }
      }
      const now = await getClusterTime()
      return {
        ...capacity(mandate, policy, { delegation, balance, now }),
        mandateFound: true,
      }
    },
    activity: (o) => getActivity(rpc, { commitment, ...o, registry, programIds: ids }),
    activityPage: (o) => getActivityPage(rpc, { commitment, ...o, registry, programIds: ids }),
    simulate: (source, o) => simulateStep(rpc, source, { programIds: ids, ...o }),
    sendAndConfirm: (source, o) => sendAndConfirmStep(rpc, source, { programIds: ids, ...o }),
    async findDelegationsTo(owner, delegates) {
      const wanted = new Set<string>(delegates)
      const out: FoundDelegation[] = []
      for (const programId of [ids.token, ids.token2022]) {
        const res = await rpc
          .getTokenAccountsByOwner(owner, { programId }, { encoding: 'base64', commitment })
          .send()
        for (const { pubkey, account } of res.value) {
          try {
            const raw = new Uint8Array(getBase64Encoder().encode(account.data[0]))
            const t = decodeTokenAccount(raw)
            if (t.delegate !== null && wanted.has(t.delegate)) {
              out.push({
                address: pubkey,
                tokenProgram: programId,
                delegate: t.delegate,
                delegatedAmount: t.delegatedAmount,
                mint: t.mint,
              })
            }
          } catch {
            continue
          }
        }
      }
      return out
    },
  }
  return client
}

const CLOCK_SYSVAR = toAddress('SysvarC1ock11111111111111111111111111111111')

/** Parse a base58 string into an `Address`, throwing a typed error on failure. */
export function parseAddress(value: string): Address {
  try {
    return toAddress(value)
  } catch (cause) {
    throw new SdkError(
      'BAD_ADDRESS',
      `not a valid Solana address: ${JSON.stringify(value.slice(0, 50))}`,
      { cause },
    )
  }
}
