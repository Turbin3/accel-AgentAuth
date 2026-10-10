import type { Address } from '@solana/kit'
import {
  checkVerify,
  createClient,
  fetchMandate,
  mandatePda,
  programIds as resolveProgramIds,
  SdkError,
  type Client,
  type Mandate,
  type ProgramIds,
} from '@agentauth-sol/sdk'
import { classifyInstruction } from './classify'
import { explainReport } from './explain'
import {
  GUARD_DISCLAIMER,
  type GuardInstruction,
  type GuardMode,
  type GuardOptions,
  type GuardReport,
  type InstructionVerdict,
} from './types'

/** A guard bound to one mandate. See {@link createGuard}. */
export interface Guard {
  readonly mode: GuardMode
  readonly mandateAddress: Promise<Address>
  readonly programIds: ProgramIds
  /** Evaluate instructions as `signer` would sign them. Never throws for a denial; returns a report. */
  evaluateInstructions(
    instructions: readonly GuardInstruction[],
    opts?: { readonly signer?: Address; readonly notes?: readonly string[] },
  ): Promise<GuardReport>
  /** Fetch the live mandate (or the static one passed in). `null` when the account does not exist. */
  loadMandate(): Promise<{
    address: Address
    mandate: Mandate | null
    owner: Address
    agent: Address
  }>
  /** One-call plain-text explanation of a report. */
  explain(report: GuardReport): string
  readonly client: Client
}

function requireAddress(value: Address | undefined, field: string): Address {
  if (value === undefined) {
    throw new SdkError(
      'MISSING_ADDRESS',
      `guard: pass \`mandate\` or both \`owner\` and \`agent\` (${field} missing)`,
    )
  }
  return value
}

/**
 * Create a guard for one mandate. COOPERATIVE CLIENT-SIDE GUARD: it decides what THIS process will
 * sign; it does not stop anyone who holds the raw key. Hard enforcement is the relay.
 *
 * The mandate is read live on every evaluation (unless a decoded `Mandate` was passed) and each
 * instruction is checked with the SDK `checkVerify` mirror, with spend accumulated across the
 * instructions of the same transaction.
 */
export function createGuard(opts: GuardOptions): Guard {
  const ids = resolveProgramIds(opts.cluster ?? 'devnet', opts.programIds)
  const client = createClient({
    rpc: opts.rpc,
    cluster: opts.cluster ?? 'devnet',
    programIds: opts.programIds,
    acknowledgeNoMainnet: true,
  })
  const allow: ReadonlySet<string> = new Set(opts.allowPrograms ?? [])
  const mode: GuardMode = opts.mode ?? 'enforce'

  const staticMandate = typeof opts.mandate === 'object' ? opts.mandate : undefined
  const mandateAddressInput = typeof opts.mandate === 'string' ? opts.mandate : undefined

  async function loadMandate() {
    if (staticMandate !== undefined) {
      const address = (await mandatePda(staticMandate.owner, staticMandate.agent, ids.agentAuth))
        .address
      return {
        address,
        mandate: staticMandate,
        owner: staticMandate.owner,
        agent: staticMandate.agent,
      }
    }
    if (mandateAddressInput !== undefined) {
      const mandate = await fetchMandate(opts.rpc, mandateAddressInput, {
        programIds: opts.programIds,
      })
      if (mandate === null) {
        // The owner is unknown without the account; only owner+agent can name a missing mandate.
        throw new SdkError(
          'NOT_FOUND',
          `guard: mandate ${mandateAddressInput} does not exist (revoked or never created)`,
        )
      }
      return { address: mandateAddressInput, mandate, owner: mandate.owner, agent: mandate.agent }
    }
    const owner = requireAddress(opts.owner, 'owner')
    const agent = requireAddress(opts.agent, 'agent')
    const address = (await mandatePda(owner, agent, ids.agentAuth)).address
    const mandate = await fetchMandate(opts.rpc, address, { programIds: opts.programIds })
    return { address, mandate, owner, agent }
  }

  async function evaluateInstructions(
    instructions: readonly GuardInstruction[],
    evalOpts: { readonly signer?: Address; readonly notes?: readonly string[] } = {},
  ): Promise<GuardReport> {
    const loaded = await loadMandate()
    const now = BigInt(await (opts.now ? opts.now() : client.getClusterTime()))
    const signer = evalOpts.signer ?? loaded.agent
    let state: Mandate | null = loaded.mandate
    const verdicts: InstructionVerdict[] = []

    instructions.forEach((ix, index) => {
      const c = classifyInstruction(ix, { programIds: ids, allowPrograms: allow })
      let verdict: InstructionVerdict = {
        index,
        programId: c.programId,
        programName: c.programName,
        instruction: c.instruction,
        disc8: c.disc8,
        risk: c.risk,
        amount: c.amount,
        kind: c.kind,
        allowed: c.kind !== 'refused' && c.kind !== 'mandate',
        code: c.code,
        reason: c.reason,
        failure: null,
        verify: null,
      }
      if (c.kind === 'mandate' && c.disc8 !== null) {
        const result = checkVerify(
          state,
          {
            owner: loaded.owner,
            agent: signer,
            targetProgram: c.programId,
            discriminator: c.disc8,
            amount: c.amount ?? 0n,
          },
          { now },
        )
        if (result.ok) {
          verdict = {
            ...verdict,
            allowed: true,
            verify: result,
            reason: `${c.programName} ${c.instruction}${c.amount ? ` ${c.amount}` : ''} is covered by mandate permission #${result.permissionIndex}; ${
              result.remainingSpend === null ? 'unlimited' : `${result.remainingSpend} left`
            } after this call (advisory pre-flight; the cluster clock and chain state decide on chain).`,
          }
          // Mirror the sequential effect of the verify calls that signing would add.
          if (state !== null) {
            const permissions = state.permissions.map((p) =>
              p.index === result.permissionIndex
                ? { ...p, spendTotal: result.newSpendTotal, callCount: result.newCallCount }
                : p,
            )
            state = { ...state, permissions }
          }
        } else {
          verdict = {
            ...verdict,
            allowed: false,
            code: 'MANDATE_DENIED',
            failure: result,
            reason: `mandate denies it: ${result.name} (${result.program} ${result.code}): ${result.message}`,
          }
        }
      }
      verdicts.push(verdict)
    })

    const refusals = verdicts.filter((v) => !v.allowed)
    return {
      ok: refusals.length === 0 && (evalOpts.notes?.length ?? 0) === 0,
      mode,
      mandate: loaded.address,
      agent: signer,
      owner: loaded.owner,
      now,
      verdicts,
      refusals,
      notes: evalOpts.notes ?? [],
      disclaimer: GUARD_DISCLAIMER,
    }
  }

  return {
    mode,
    get mandateAddress() {
      return loadAddress()
    },
    programIds: ids,
    evaluateInstructions,
    loadMandate,
    explain: explainReport,
    client,
  }

  async function loadAddress(): Promise<Address> {
    if (mandateAddressInput !== undefined) return mandateAddressInput
    if (staticMandate !== undefined) return (await loadMandate()).address
    return (
      await mandatePda(
        requireAddress(opts.owner, 'owner'),
        requireAddress(opts.agent, 'agent'),
        ids.agentAuth,
      )
    ).address
  }
}
