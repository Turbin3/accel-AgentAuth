import { generateText, isStepCount, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { systemTransferIx } from '@agentauth-sol/sdk'
import { agentAuthToolApproval, createGuard } from '../src'
import { NOW, SOL, cast, noRpc } from './helpers'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function modelCalling(lamports: number) {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'transferSol',
            input: JSON.stringify({ lamports }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
    ],
  })
}

async function run(lamports: number) {
  const { agent, recipient, mandate } = await cast()
  const guard = createGuard({ rpc: noRpc, mandate, now: () => NOW })
  const executed: number[] = []
  const transferSol = tool({
    description: 'Transfer SOL from the agent wallet',
    inputSchema: z.object({ lamports: z.number().int().positive() }),
    execute: async ({ lamports: n }) => {
      executed.push(n)
      return { signature: 'simulated' }
    },
  })
  const result = await generateText({
    model: modelCalling(lamports),
    tools: { transferSol },
    toolApproval: agentAuthToolApproval({
      guard,
      tools: {
        transferSol: ({ lamports: n }: { lamports: number }) => [
          systemTransferIx({ from: agent.address, to: recipient.address, lamports: BigInt(n) }),
        ],
      },
    }),
    stopWhen: isStepCount(3),
    prompt: 'pay',
  })
  return { executed, result }
}

describe('agentAuthToolApproval with the Vercel AI SDK (ai@7, mock model)', () => {
  it('lets a call inside the mandate execute', async () => {
    const { executed } = await run(Number(SOL / 5n))
    expect(executed).toEqual([Number(SOL / 5n)])
  })

  it('denies a call over the per-call cap before execute() runs, with the mandate reason', async () => {
    const { executed, result } = await run(Number((SOL * 6n) / 10n))
    expect(executed).toEqual([])
    const parts = result.steps.flatMap((s) => s.content)
    const denial = JSON.stringify(parts, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    expect(denial).toMatch(/PerTxExceeded/)
    expect(denial).toMatch(/cooperative client-side/)
  })

  it('fails closed when the check itself throws', async () => {
    const guard = createGuard({ rpc: noRpc, owner: 'a' as never, agent: 'b' as never })
    const approval = agentAuthToolApproval({
      guard,
      tools: { t: (_: { n: number }) => [{ programAddress: 'c' as never }] },
    })
    const status = await approval.t({ n: 1 })
    expect(status.type).toBe('denied')
  })

  it('returns not-applicable when a tool has no on-chain effect', async () => {
    const { mandate } = await cast()
    const guard = createGuard({ rpc: noRpc, mandate, now: () => NOW })
    const approval = agentAuthToolApproval({ guard, tools: { read: (_: { q: string }) => null } })
    expect(await approval.read({ q: 'x' })).toEqual({ type: 'not-applicable' })
  })
})
