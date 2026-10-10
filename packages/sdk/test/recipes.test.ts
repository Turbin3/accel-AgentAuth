import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  createClient,
  parseProgramError,
} from '../src/index'
import {
  createActivityFeed,
  dashboardMandateView,
  explainDenial,
  mcpAgentStatus,
  mcpOwnerPlan,
  sellerCheck,
} from './recipes'
import { W, stubChain } from './world'

const here = dirname(fileURLToPath(import.meta.url))
const recipes = readFileSync(join(here, 'recipes.ts'), 'utf8')
const apiDoc = readFileSync(join(here, '..', 'API.md'), 'utf8')

describe('API.md recipes are the verified recipes', () => {
  const regions = [...recipes.matchAll(/\/\/ #region (recipe-\d+)\n([\s\S]*?)\/\/ #endregion \1/g)]
  it('there are ten, and API.md contains each verbatim (imports from the package name)', () => {
    expect(regions.map((r) => r[1])).toEqual(
      Array.from({ length: 10 }, (_, i) => `recipe-${i + 1}`),
    )
    for (const r of regions) {
      expect(apiDoc, r[1]).toContain((r[2] as string).trim())
    }
  })
})

describe('recipes run against a stub chain', () => {
  it('3/5. dashboard view: honest can/cannot, enforcement and capacity', async () => {
    const w = await stubChain()
    const client = createClient({ rpc: w.rpc })
    const view = await dashboardMandateView(client, w.mandate)
    expect(view?.can.join(' ')).toContain('hard-enforced')
    expect(view?.capacity).toMatchObject({ maxSpendNow: 1_000_000n, blockedBy: null })
  })
  it('2. MCP owner plan is plain JSON with unsigned base64 transactions', async () => {
    const w = await stubChain()
    const client = createClient({ rpc: w.rpc })
    const out = JSON.parse(JSON.stringify(await mcpOwnerPlan(client, W.owner, W.agent)))
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0].base64.length).toBeGreaterThan(100)
    expect(out.transactions[0].requiredSigners[0]).toBe(W.owner)
  })
  it('4. agent status filters by trusted owners; explainDenial maps a code to a hint', async () => {
    const w = await stubChain()
    const client = createClient({ rpc: w.rpc })
    const trusted = JSON.parse(JSON.stringify(await mcpAgentStatus(client, W.agent, [W.owner])))
    expect(trusted).toHaveLength(1)
    expect(trusted[0].maxSpendNow).toBe('1000000')
    expect(await mcpAgentStatus(client, W.agent, [W.dest])).toEqual([])
    const d = explainDenial({ InstructionError: [0, 'NotEnoughAccountKeys'] })
    expect(d.what).toBe('runtime:NotEnoughAccountKeys')
    expect(parseProgramError(null)).toBeNull()
  })
  it('6. the activity feed polls without refetching', async () => {
    const w = await stubChain()
    const client = createClient({ rpc: w.rpc })
    const feed = createActivityFeed(client, w.mandate, w.policy)
    expect(await feed.poll()).toEqual([])
  })
  it('9. seller check uses the cluster clock and the trusted owner', async () => {
    const w = await stubChain()
    const client = createClient({ rpc: w.rpc })
    const base = [W.agent, TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC] as const
    expect(await sellerCheck(client, W.owner, ...base, 1_000_000n)).toEqual({ allow: true })
    expect(await sellerCheck(client, W.owner, ...base, 1_000_001n)).toMatchObject({
      allow: false,
      name: 'PerTxExceeded',
    })
  })
})
