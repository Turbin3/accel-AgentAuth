/**
 * Example 2: Vercel AI SDK 7 agent. `toolApproval` denies a tool call the mandate would refuse
 * BEFORE `execute()` runs; the tool then signs through the guarded Kit signer (second layer).
 *
 * Uses the SDK's mock language model (`ai/test`), so no API key and no LLM is involved: the
 * "model" is a script that asks for two transfers.
 *
 *   pnpm --filter @agentauth-sol/guard exec tsx examples/02-ai-sdk-agent.ts
 *
 * COOPERATIVE CLIENT-SIDE GUARD, NOT ENFORCEMENT: the relay is the enforcement tier.
 */
import { generateText, isStepCount, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { systemTransferIx } from '@agentauth-sol/sdk'
import { agentAuthToolApproval, guardSigner } from '../src'
import { rootCause, setupMandate, SOL } from './_setup'

const { chain, programIds, agent, recipient, mandate } = await setupMandate()
const signer = guardSigner(agent, { rpc: chain.rpc, mandate, cluster: 'localnet', programIds })

const transferSol = tool({
  description: 'Send SOL from the agent wallet to the recipient (mandate-limited).',
  inputSchema: z.object({ lamports: z.number().int().positive() }),
  execute: async ({ lamports }) => {
    const ix = systemTransferIx({ from: signer, to: recipient.address, lamports: BigInt(lamports) })
    try {
      const sig = await chain.send([ix], signer)
      return { sent: lamports, signature: sig }
    } catch (error) {
      return { error: String(rootCause(error)) }
    }
  },
})

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const scriptedModel = (lamports: number) =>
  new MockLanguageModelV4({
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

const toolApproval = agentAuthToolApproval({
  guard: signer.guard,
  tools: {
    transferSol: ({ lamports }: { lamports: number }) => [
      systemTransferIx({ from: agent.address, to: recipient.address, lamports: BigInt(lamports) }),
    ],
  },
})

for (const lamports of [Number(SOL / 5n), Number((SOL * 6n) / 10n)]) {
  const result = await generateText({
    model: scriptedModel(lamports),
    tools: { transferSol },
    toolApproval,
    stopWhen: isStepCount(3),
    prompt: `pay ${lamports} lamports`,
  })
  const parts = result.steps.flatMap((s) => s.content)
  const executed = parts.some((p) => p.type === 'tool-result')
  const denial = parts.find((p) => p.type === 'tool-approval-response') as
    { reason?: string } | undefined
  console.log(
    `${lamports} lamports -> ${executed ? 'EXECUTED (mandate allowed it)' : `DENIED before execute(): ${denial?.reason ?? 'see parts'}`}`,
  )
}
console.log('Reminder: this is a cooperative client-side guard; the relay is the enforcement tier.')
