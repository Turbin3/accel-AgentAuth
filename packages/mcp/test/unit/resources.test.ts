import { describe, expect, it } from 'vitest'
import { offlineServer } from '../support/offline'

async function read(client: Awaited<ReturnType<typeof offlineServer>>['client'], uri: string) {
  const res = await client.readResource({ uri })
  const first = res.contents[0] as { text: string; mimeType?: string }
  return {
    body: JSON.parse(first.text) as Record<string, unknown>,
    mime: first.mimeType,
    bytes: first.text.length,
  }
}

describe('resources and prompts', () => {
  it('lists the registry resources and the mandate template in every profile', async () => {
    for (const profile of ['agent', 'owner', 'observer'] as const) {
      const { client } = await offlineServer({
        profile,
        ...(profile === 'observer' ? { owner: undefined } : {}),
      })
      const uris = (await client.listResources()).resources.map((r) => r.uri).sort()
      expect(uris).toEqual(['agentauth://presets', 'agentauth://registry/programs'])
      const templates = (await client.listResourceTemplates()).resourceTemplates.map(
        (t) => t.uriTemplate,
      )
      expect(templates).toEqual(['agentauth://mandate/{address}'])
    }
  })

  it('serves the program registry with risk classes and a bounded size', async () => {
    const { client } = await offlineServer()
    const { body, mime, bytes } = await read(client, 'agentauth://registry/programs')
    expect(mime).toBe('application/json')
    expect(bytes).toBeLessThan(120_000)
    const programs = body['programs'] as Array<{
      slug: string
      instructions: Array<{ name: string; risk: string; defaultDeny: boolean }>
    }>
    const token = programs.find((p) => p.slug === 'spl-token')
    expect(token).toBeDefined()
    const setAuthority = token?.instructions.find((i) => i.name === 'set_authority')
    expect(setAuthority).toMatchObject({ risk: 'authority_change', defaultDeny: true })
  })

  it('serves presets', async () => {
    const { client } = await offlineServer()
    const { body } = await read(client, 'agentauth://presets')
    const names = (body['presets'] as Array<{ name: string }>).map((p) => p.name)
    expect(names).toContain('payments-usdc')
    expect(names.length).toBeGreaterThanOrEqual(3)
  })

  it('a mandate URI with a bad address is a deterministic error, a missing mandate is not_found', async () => {
    const { client } = await offlineServer(
      {},
      { inspect: async () => ({ mandate: null, policy: null, explanation: null }) },
    )
    const bad = await read(client, 'agentauth://mandate/not-an-address')
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    const missing = await read(
      client,
      'agentauth://mandate/4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z',
    )
    expect(missing.body).toMatchObject({ ok: true, status: 'not_found' })
  })

  it('a failing or non-mandate account and the rate limit give deterministic errors', async () => {
    const uri = 'agentauth://mandate/4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z'
    const down = await offlineServer(
      {},
      { inspect: async () => Promise.reject(new Error('fetch failed')) },
    )
    expect((await read(down.client, uri)).body).toMatchObject({
      ok: false,
      error: { code: 'RPC_ERROR' },
    })
    const limited = await offlineServer(
      { maxCallsPerMinute: 1 },
      { inspect: async () => ({ mandate: null, policy: null, explanation: null }) },
    )
    expect((await read(limited.client, uri)).body).toMatchObject({ ok: true })
    expect((await read(limited.client, uri)).body).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    })
  })

  it('owner prompts exist; the agent profile has none', async () => {
    const owner = await offlineServer({ profile: 'owner' })
    expect((await owner.client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual([
      'review-agent-activity',
      'set-up-a-mandate',
    ])
    const prompt = await owner.client.getPrompt({
      name: 'set-up-a-mandate',
      arguments: {
        agent: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLaPSpXJ3b6Ax',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        budget: '25',
        per_payment: '5',
        duration: '7d',
      },
    })
    const text = (prompt.messages[0]?.content as { text: string }).text
    expect(text).toMatch(/in my own wallet/)
    expect(text).toMatch(/never need my private key/)
    expect(text).toMatch(/unaudited devnet prototype/)
    const observer = await offlineServer({ profile: 'observer', owner: undefined })
    expect((await observer.client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      'review-agent-activity',
    ])
    const agent = await offlineServer({ profile: 'agent' })
    await expect(agent.client.listPrompts()).rejects.toThrow()
  })

  it('prompt arguments are validated', async () => {
    const owner = await offlineServer({ profile: 'owner' })
    await expect(
      owner.client.getPrompt({
        name: 'set-up-a-mandate',
        arguments: { agent: 'x', mint: 'y', budget: 'lots', per_payment: '1', duration: 'soon' },
      }),
    ).rejects.toThrow()
  })
})
