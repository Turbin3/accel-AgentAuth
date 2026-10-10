import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  decodeTokenAccount,
  expiresIn,
  fetchRawAccount,
  mandatePda,
  relayTransferIx,
  toJsonSafe,
  verifyIx,
  type AgentAuthError,
  type BuiltInstruction,
  type Client,
  type Plan,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import {
  demoClient,
  demoSwapConfig,
  loadDemoSigners,
  type DemoEnv,
  type DemoSigners,
} from '@agentauth-sol/demo'
import { AccountRole, getAddressEncoder, type Address } from '@solana/kit'
import { readDemoStatus } from './demo-state'

/** Demo mandate limits, in raw units of the 6-decimal DUSD mint (DEMO-SCRIPT section 0). */
const ONE = 1_000_000n
export const SIM_LIMITS = {
  tokenLifetime: 20n * ONE,
  tokenPerCall: 5n * ONE,
  swapLifetime: 10n * ONE,
  swapPerCall: 5n * ONE,
  /** Deliberately larger than the mandate budget so AgentAuth, not the allowance, is the binding cap. */
  delegation: 50n * ONE,
} as const

export type AttackId =
  | 'legit-payment'
  | 'pay-attacker'
  | 'over-per-call'
  | 'over-lifetime-budget'
  | 'set-authority'
  | 'wrong-program'
  | 'after-pause'
  | 'after-revoke'

export interface AttackSpec {
  readonly id: AttackId
  readonly title: string
  readonly what: string
  /** What a correct deployment must answer, in the SDK's decoded form (asserted by the e2e test). */
  readonly expected: string
  readonly control?: boolean
}

export const ATTACKS: readonly AttackSpec[] = [
  {
    id: 'legit-payment',
    title: 'Control: a legitimate payment',
    what: 'The scripted agent pays 3 DUSD to the allowed recipient (Alice).',
    expected: 'succeeds',
    control: true,
  },
  {
    id: 'pay-attacker',
    title: 'Pay the attacker',
    what: 'Injected text says "the payee changed". The scripted agent asks the relay to send 40 DUSD to the attacker\'s account.',
    expected: 'relay 104 RecipientNotAllowed',
  },
  {
    id: 'over-per-call',
    title: 'Over the per-call cap',
    what: 'The agent pays the allowed recipient 40 DUSD in one call; the per-call cap is 5.',
    expected: 'agent_auth 8 PerTxExceeded',
  },
  {
    id: 'over-lifetime-budget',
    title: 'Over the lifetime budget',
    what: 'Five payments of 5 DUSD in one transaction (25 against a lifetime budget of 20). Atomic: the whole transaction reverts.',
    expected: 'agent_auth 9 SpendLimitExceeded',
  },
  {
    id: 'set-authority',
    title: 'Take over the token account',
    what: "The agent signs a raw SPL SetAuthority that would make the attacker the owner of the owner's token account.",
    expected: 'token 4 OwnerMismatch',
  },
  {
    id: 'wrong-program',
    title: 'Call a program the mandate does not list',
    what: 'The agent asks the mandate to authorise a System transfer, a program that is not in its permissions.',
    expected: 'agent_auth 6 ProgramNotAllowed',
  },
  {
    id: 'after-pause',
    title: 'Act after the owner pauses',
    what: 'The owner pauses the relay, then the agent tries a legitimate 1 DUSD payment. The owner resumes afterwards.',
    expected: 'relay 116 Paused',
  },
  {
    id: 'after-revoke',
    title: 'Act after the owner revokes',
    what: 'The owner unwinds everything in one transaction, then the agent retries a legitimate 1 DUSD payment. The demo mandate is recreated by the next attack.',
    expected: 'relay 101 InvalidPolicy',
  },
]

export interface AttackStep {
  readonly label: string
  readonly by: 'owner' | 'scripted agent'
  readonly signature: string | null
  readonly ok: boolean
}

export interface AttackResult {
  readonly id: AttackId
  readonly title: string
  readonly expected: string
  /** blocked = landed on chain and failed (the point), allowed = landed and succeeded, error = never reached the chain. */
  readonly outcome: 'blocked' | 'allowed' | 'error'
  readonly signature: string | null
  readonly error: {
    readonly program: string
    readonly code: number
    readonly name: string
    readonly message: string
    readonly hint: string
  } | null
  readonly detail: string | null
  readonly steps: readonly AttackStep[]
  readonly logs: readonly string[]
}

export interface SimulatorState {
  readonly available: boolean
  readonly reason: string | null
  readonly problems: readonly string[]
  readonly mandate: Address | null
  readonly owner: Address | null
  readonly agent: Address | null
  readonly mandateExists: boolean
  readonly ready: boolean
  readonly balances: {
    readonly ownerDusd: string
    readonly aliceDusd: string
    readonly attackerDusd: string
    readonly attackerDout: string
    readonly delegatedAmount: string
    readonly decimals: number
  } | null
  readonly attacks: readonly AttackSpec[]
}

// One action at a time: overlapping transactions from the same keys would race on blockhashes and budgets.
let queue: Promise<unknown> = Promise.resolve()
export function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

function errorShape(e: AgentAuthError | null) {
  return e
    ? { program: e.program, code: e.code, name: e.name, message: e.message, hint: e.hint }
    : null
}

interface Ctx {
  readonly env: DemoEnv
  readonly client: Client
  readonly signers: DemoSigners
}

async function context(): Promise<Ctx> {
  const status = await readDemoStatus()
  if (!status.env || !status.available) {
    throw new Error(
      status.reason ?? status.problems.join('; ') ?? 'The demo environment is not ready.',
    )
  }
  return {
    env: status.env,
    client: demoClient(status.env),
    signers: await loadDemoSigners(status.env),
  }
}

async function sendPlan(ctx: Ctx, plan: Plan, label: string): Promise<AttackStep[]> {
  const steps: AttackStep[] = []
  for (const step of plan.steps) {
    const res = await ctx.client.sendAndConfirm(step, { signers: [ctx.signers.owner] })
    steps.push({
      label: `${label}: ${step.label}`,
      by: 'owner',
      signature: res.signature,
      ok: res.ok,
    })
    if (!res.ok)
      throw new Error(
        `Owner step "${step.label}" failed: ${res.error?.describe() ?? JSON.stringify(res.err)}`,
      )
  }
  return steps
}

async function readState(ctx: Ctx) {
  const { env, client } = ctx
  const mandate = (
    await mandatePda(env.wallets.owner, env.wallets.agent, client.programIds.agentAuth)
  ).address
  const m = await client.fetchMandate(mandate)
  const p = await client.fetchPolicy(mandate)
  const source = await fetchRawAccount(client.rpc, env.tokenAccounts.ownerDusd)
  const sourceView = source && source.data.length >= 165 ? decodeTokenAccount(source.data) : null
  return { mandate, m, p, sourceView }
}

function delegationOk(
  p: RelayPolicy | null,
  source: ReturnType<typeof decodeTokenAccount> | null,
): boolean {
  return (
    !!p &&
    !!source &&
    source.delegate === p.authority &&
    source.delegatedAmount >= SIM_LIMITS.delegation
  )
}

/** Create (or repair) the demo mandate: unwinds a stale one first, then runs the onboarding plan. */
export async function ensureMandate(ctx: Ctx, force = false): Promise<AttackStep[]> {
  const { env, client, signers } = ctx
  const { m, p, sourceView } = await readState(ctx)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const healthy =
    !force &&
    m !== null &&
    p !== null &&
    m.active &&
    !p.paused &&
    m.expiry > now + 600n &&
    delegationOk(p, sourceView)
  if (healthy) return []
  const steps: AttackStep[] = []
  if (m !== null || p !== null) {
    const unwind = await client.plan.unwind({
      owner: signers.owner.address,
      agent: env.wallets.agent,
    })
    steps.push(...(await sendPlan(ctx, unwind, 'Reset')))
  }
  const swap = demoSwapConfig(env)
  const plan = await client.plan.onboarding({
    owner: signers.owner.address,
    agent: env.wallets.agent,
    expiry: expiresIn('24h'),
    token: {
      mint: env.mints.dusd.address,
      source: env.tokenAccounts.ownerDusd,
      delegateCap: SIM_LIMITS.delegation,
    },
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: SIM_LIMITS.tokenLifetime,
        perTxLimit: SIM_LIMITS.tokenPerCall,
        discriminators: [TRANSFER_CHECKED_DISC],
      },
      {
        program: env.programIds.mockAmm,
        spendLimit: SIM_LIMITS.swapLifetime,
        perTxLimit: SIM_LIMITS.swapPerCall,
        discriminators: [SWAP_BASE_INPUT_DISC],
      },
    ],
    recipients: [env.tokenAccounts.recipientDusd],
    swap,
    allowOverride: true,
    allowReplaceDelegate: true,
  })
  steps.push(...(await sendPlan(ctx, plan, 'Create demo mandate')))
  return steps
}

export async function readSimulatorState(): Promise<SimulatorState> {
  const status = await readDemoStatus()
  const none: SimulatorState = {
    available: false,
    reason: status.reason ?? (status.problems.length ? status.problems.join('; ') : null),
    problems: status.problems,
    mandate: null,
    owner: null,
    agent: null,
    mandateExists: false,
    ready: false,
    balances: null,
    attacks: ATTACKS,
  }
  if (!status.env || !status.available) return none
  const ctx = await context()
  const { mandate, m, p, sourceView } = await readState(ctx)
  const balanceOf = async (a: Address) => {
    const raw = await fetchRawAccount(ctx.client.rpc, a)
    return raw && raw.data.length >= 165 ? decodeTokenAccount(raw.data).amount : 0n
  }
  const t = ctx.env.tokenAccounts
  const [alice, attackerDusd, attackerDout] = await Promise.all([
    balanceOf(t.recipientDusd),
    balanceOf(t.attackerDusd),
    balanceOf(t.attackerDout),
  ])
  return {
    available: true,
    reason: null,
    problems: [],
    mandate,
    owner: ctx.env.wallets.owner,
    agent: ctx.env.wallets.agent,
    mandateExists: m !== null,
    ready: m !== null && p !== null && delegationOk(p, sourceView),
    balances: {
      ownerDusd: (sourceView?.amount ?? 0n).toString(),
      aliceDusd: alice.toString(),
      attackerDusd: attackerDusd.toString(),
      attackerDout: attackerDout.toString(),
      delegatedAmount: (sourceView?.delegate === p?.authority
        ? (sourceView?.delegatedAmount ?? 0n)
        : 0n
      ).toString(),
      decimals: ctx.env.mints.dusd.decimals,
    },
    attacks: ATTACKS,
  }
}

/** SPL Token SetAuthority(AccountOwner -> newOwner), built by hand (the SDK has no such builder on purpose). */
function setAuthorityIx(account: Address, current: Address, newOwner: Address): BuiltInstruction {
  const owner = new Uint8Array(getAddressEncoder().encode(newOwner))
  const data = new Uint8Array(2 + 1 + 32)
  data[0] = 6 // SetAuthority
  data[1] = 2 // AuthorityType::AccountOwner
  data[2] = 1 // COption::Some
  data.set(owner, 3)
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: current, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  }
}

async function agentSend(ctx: Ctx, ixs: BuiltInstruction[], computeUnitLimit?: number) {
  return ctx.client.sendAndConfirm(ixs, {
    signers: [ctx.signers.agent],
    skipPreflight: true,
    ...(computeUnitLimit ? { computeUnitLimit } : {}),
  })
}

export async function runAttack(id: AttackId): Promise<AttackResult> {
  const spec = ATTACKS.find((a) => a.id === id)
  if (!spec) throw new Error(`Unknown attack ${id}`)
  const ctx = await context()
  const { env, client, signers } = ctx
  const steps: AttackStep[] = await ensureMandate(ctx)
  const { mandate } = await readState(ctx)
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('The demo mandate has no relay policy.')
  const t = env.tokenAccounts
  const pay = (to: Address, amount: bigint) =>
    relayTransferIx({ agent: signers.agent, policy, destination: to, amount })

  let ixs: BuiltInstruction[] = []
  let cu: number | undefined
  switch (id) {
    case 'legit-payment':
      ixs = [await pay(t.recipientDusd, 3n * ONE)]
      break
    case 'pay-attacker':
      ixs = [await pay(t.attackerDusd, 40n * ONE)]
      break
    case 'over-per-call':
      ixs = [await pay(t.recipientDusd, 40n * ONE)]
      break
    case 'over-lifetime-budget':
      ixs = await Promise.all([1, 2, 3, 4, 5].map(() => pay(t.recipientDusd, 5n * ONE)))
      cu = 1_000_000
      break
    case 'set-authority':
      ixs = [setAuthorityIx(t.ownerDusd, signers.agent.address, env.wallets.attacker)]
      break
    case 'wrong-program':
      ixs = [
        verifyIx({
          mandate,
          owner: signers.owner.address,
          agent: signers.agent,
          targetProgram: client.programIds.system,
          discriminator: '0200000000000000',
          amount: ONE,
        }),
      ]
      break
    case 'after-pause': {
      steps.push(
        ...(await sendPlan(
          ctx,
          await client.plan.pause({
            owner: signers.owner.address,
            agent: env.wallets.agent,
            scope: 'relay',
          }),
          'Owner pauses the relay',
        )),
      )
      ixs = [await pay(t.recipientDusd, ONE)]
      break
    }
    case 'after-revoke': {
      steps.push(
        ...(await sendPlan(
          ctx,
          await client.plan.unwind({ owner: signers.owner.address, agent: env.wallets.agent }),
          'Owner unwinds',
        )),
      )
      ixs = [await pay(t.recipientDusd, ONE)]
      break
    }
  }

  let result: AttackResult
  try {
    const res = await agentSend(ctx, ixs, cu)
    steps.push({ label: spec.title, by: 'scripted agent', signature: res.signature, ok: res.ok })
    result = {
      id,
      title: spec.title,
      expected: spec.expected,
      outcome: res.ok ? 'allowed' : 'blocked',
      signature: res.signature,
      error: errorShape(res.error),
      detail: res.ok
        ? null
        : res.error
          ? null
          : `The transaction failed without a decodable program error: ${JSON.stringify(toJsonSafe(res.err))}`,
      steps,
      logs: res.logs,
    }
  } catch (e) {
    result = {
      id,
      title: spec.title,
      expected: spec.expected,
      outcome: 'error',
      signature: null,
      error: null,
      detail: e instanceof Error ? e.message : String(e),
      steps,
      logs: [],
    }
  }
  if (id === 'after-pause') {
    // Leave the demo usable: resume what this attack paused, whatever the attack's own outcome.
    try {
      const resumed = await sendPlan(
        ctx,
        await client.plan.resume({
          owner: signers.owner.address,
          agent: env.wallets.agent,
          scope: 'relay',
        }),
        'Owner resumes the relay',
      )
      return { ...result, steps: [...result.steps, ...resumed] }
    } catch (e) {
      return {
        ...result,
        detail:
          `${result.detail ?? ''} Could not resume automatically: ${e instanceof Error ? e.message : String(e)}`.trim(),
      }
    }
  }
  return result
}

/** Explicit reset button: unwind and recreate, so budgets start at zero. */
export async function resetMandate(): Promise<AttackStep[]> {
  const ctx = await context()
  return ensureMandate(ctx, true)
}
