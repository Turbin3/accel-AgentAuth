import type { Address } from '@solana/kit'
import type { Guard } from './guard'
import type { GuardInstruction, GuardReport } from './types'

/**
 * Structural twin of the AI SDK `ToolApprovalStatus` objects this module returns, so the package
 * does not import `ai` at runtime or in its public types.
 */
export type GuardToolApprovalStatus =
  { readonly type: 'not-applicable' } | { readonly type: 'denied'; readonly reason: string }

/**
 * What a tool call would do on chain, as real instructions (build them with the SDK builders, for
 * example `systemTransferIx` / `transferCheckedIx`). Return `null` when the call has no on-chain
 * effect.
 */
export type ToolCallToInstructions<INPUT> = (
  input: INPUT,
) => readonly GuardInstruction[] | null | Promise<readonly GuardInstruction[] | null>

export interface AgentAuthToolApprovalOptions<INPUTS extends Record<string, unknown>> {
  readonly guard: Guard
  /** Agent address that will sign. Defaults to the mandate's agent. */
  readonly signer?: Address
  /** For each tool name, how to turn the tool input into the instructions it would send. */
  readonly tools: { readonly [K in keyof INPUTS]: ToolCallToInstructions<INPUTS[K]> }
  /** Called with every report (also in dry-run). */
  readonly onReport?: (tool: string, report: GuardReport) => void
}

/**
 * Per-tool `toolApproval` map for the Vercel AI SDK (`generateText` / `streamText` /
 * `ToolLoopAgent`, verified against `ai@7.0.137`). A tool call the mandate (or a guard default)
 * would deny returns `{ type: 'denied', reason }` BEFORE `execute()` runs; everything else returns
 * `not-applicable`, so other approval rules still apply. Fails closed: if the mandate cannot be
 * read, the call is denied.
 *
 * COOPERATIVE CLIENT-SIDE GUARD, NOT ENFORCEMENT: it stops the model's tool call, not a process
 * that holds the raw key. In a guard in `dry-run` mode nothing is denied. The relay is the
 * enforcement tier.
 */
export function agentAuthToolApproval<INPUTS extends Record<string, unknown>>(
  opts: AgentAuthToolApprovalOptions<INPUTS>,
): { [K in keyof INPUTS]: (input: INPUTS[K]) => Promise<GuardToolApprovalStatus> } {
  const out: Record<string, (input: unknown) => Promise<GuardToolApprovalStatus>> = {}
  for (const name of Object.keys(opts.tools)) {
    const toInstructions = opts.tools[name] as ToolCallToInstructions<unknown>
    out[name] = async (input) => {
      try {
        const instructions = await toInstructions(input)
        if (instructions === null || instructions.length === 0) return { type: 'not-applicable' }
        const report = await opts.guard.evaluateInstructions(
          instructions,
          opts.signer === undefined ? {} : { signer: opts.signer },
        )
        opts.onReport?.(name, report)
        if (report.ok || opts.guard.mode === 'dry-run') return { type: 'not-applicable' }
        const first = report.refusals[0]
        return {
          type: 'denied',
          reason: `AgentAuth guard (cooperative client-side check) denied ${name}: ${first?.reason ?? report.notes.join(' ')}`,
        }
      } catch (error) {
        return {
          type: 'denied',
          reason: `AgentAuth guard could not check ${name} and fails closed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return out as { [K in keyof INPUTS]: (input: INPUTS[K]) => Promise<GuardToolApprovalStatus> }
}
