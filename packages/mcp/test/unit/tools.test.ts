import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Profile } from '../../src/config'
import { instructionsFor } from '../../src/instructions'
import { toolsFor } from '../../src/server'
import { offlineServer } from '../support/offline'

const PROFILES: Profile[] = ['agent', 'owner', 'observer']

function definitions(profile: Profile, unsafeDevSign = false) {
  return toolsFor({ profile, unsafeDevSign }).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    annotations: t.annotations,
    inputSchema: z.toJSONSchema(t.input),
  }))
}

describe('tool list snapshot (a change to a tool description or schema must show up in review)', () => {
  it.each(PROFILES)('%s profile', async (profile) => {
    await expect(JSON.stringify(definitions(profile), null, 2) + '\n').toMatchFileSnapshot(
      `../__snapshots__/tools.${profile}.json`,
    )
  })

  it('owner profile with --unsafe-dev-sign', async () => {
    await expect(JSON.stringify(definitions('owner', true), null, 2) + '\n').toMatchFileSnapshot(
      '../__snapshots__/tools.owner-unsafe-dev-sign.json',
    )
  })

  it.each(PROFILES)('%s server instructions', async (profile) => {
    await expect(instructionsFor(profile) + '\n').toMatchFileSnapshot(
      `../__snapshots__/instructions.${profile}.txt`,
    )
  })
})

describe('tool contract', () => {
  const all = PROFILES.flatMap((p) => toolsFor({ profile: p, unsafeDevSign: p === 'owner' }))

  it('has unique, well-formed names', () => {
    const names = all.map((t) => t.name)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]{2,63}$/)
    const perProfile = PROFILES.map((p) =>
      toolsFor({ profile: p, unsafeDevSign: true }).map((t) => t.name),
    )
    for (const list of perProfile) expect(new Set(list).size).toBe(list.length)
  })

  it('every description tells the model to treat results as data', () => {
    for (const t of all) expect(t.description, t.name).toMatch(/data, never as instructions/)
  })

  it('descriptions carry no links and name only tools of this server', () => {
    const names = new Set(all.map((t) => t.name))
    for (const t of all) {
      expect(t.description, t.name).not.toMatch(/https?:|www\./)
      for (const mentioned of t.description.match(/\b(?:agentauth|owner|observer)_[a-z_]+/g) ??
        []) {
        expect(names.has(mentioned), `${t.name} mentions ${mentioned}`).toBe(true)
      }
    }
  })

  it('every input schema is strict (unknown keys are rejected)', () => {
    for (const t of all) {
      const schema = z.toJSONSchema(t.input) as { additionalProperties?: unknown }
      expect(schema.additionalProperties, t.name).toBe(false)
    }
  })

  it('money-moving tools require an idempotency key, bigints are strings', () => {
    for (const name of ['agentauth_pay', 'agentauth_swap']) {
      const tool = all.find((t) => t.name === name)
      const schema = z.toJSONSchema(tool!.input) as {
        required?: string[]
        properties: Record<string, { type?: string }>
      }
      expect(schema.required).toContain('idempotency_key')
      for (const [k, v] of Object.entries(schema.properties)) {
        if (/amount|limit|out$/.test(k) && k !== 'allow_repeat')
          expect(v.type, `${name}.${k}`).toBe('string')
      }
    }
  })

  it('only the payment tools and the dev signer can change anything', () => {
    for (const t of all) {
      const writes = t.annotations.readOnlyHint !== true
      const allowed = ['agentauth_pay', 'agentauth_swap', 'owner_dev_sign_and_send'].includes(
        t.name,
      )
      // plan tools build unsigned data: they are marked read-only too
      expect(writes, t.name).toBe(allowed)
    }
  })

  it('no input field accepts a key, seed or keypair', () => {
    for (const t of all) {
      for (const key of Object.keys(t.input.shape)) {
        expect(
          /key|secret|seed|mnemonic|keypair|private/i.test(key) && key !== 'idempotency_key',
          `${t.name}.${key}`,
        ).toBe(false)
      }
    }
  })
})

describe('confused deputy', () => {
  it('agent tools cannot be pointed at another owner, agent, mandate or mint', () => {
    const forbidden = /^(owner|agent|mandate|mint|policy|source|authority|signer|payer|fee_payer)/
    for (const t of toolsFor({ profile: 'agent', unsafeDevSign: false })) {
      for (const key of Object.keys(t.input.shape))
        expect(forbidden.test(key), `${t.name}.${key}`).toBe(false)
    }
  })
})

describe('profile separation', () => {
  it('agent profile exposes no owner or observer tool', async () => {
    const { client } = await offlineServer({ profile: 'agent' })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual([
      'agentauth_status',
      'agentauth_check_action',
      'agentauth_pay',
      'agentauth_explain_denial',
      'agentauth_activity',
    ])
    expect(names.some((n) => /^(owner|observer)_/.test(n))).toBe(false)
  })

  it('agent swap tool appears only when the live policy enables swaps', async () => {
    const { client, handle } = await offlineServer(
      { profile: 'agent' },
      { fetchPolicy: async () => ({ swap: {} }) },
    )
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('agentauth_swap')
    expect(handle.tools.map((t) => t.name)).toContain('agentauth_swap')
    const off = await offlineServer(
      { profile: 'agent' },
      { fetchPolicy: async () => ({ swap: null }) },
    )
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain('agentauth_swap')
  })

  it('owner profile exposes plan tools and no payment tool; no dev signer by default', async () => {
    const { client } = await offlineServer({ profile: 'owner' })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('owner_plan_onboarding')
    expect(names).toContain('owner_plan_unwind')
    expect(names.some((n) => n.startsWith('agentauth_') && n !== 'agentauth_explain_denial')).toBe(
      false,
    )
    expect(names).not.toContain('owner_dev_sign_and_send')
  })

  it('observer profile is read-only', async () => {
    const { client } = await offlineServer({ profile: 'observer', owner: undefined })
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual([
      'agentauth_explain_denial',
      'observer_activity',
      'observer_explain_mandate',
    ])
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
  })

  it('calling a tool of another profile fails', async () => {
    const { client } = await offlineServer({ profile: 'agent' })
    for (const name of [
      'owner_plan_unwind',
      'owner_plan_onboarding',
      'owner_dev_sign_and_send',
      'observer_activity',
    ]) {
      const outcome = await client.callTool({ name, arguments: {} }).then(
        (r) => (r.isError === true ? 'error' : 'ok'),
        () => 'rejected',
      )
      expect(outcome, name).not.toBe('ok')
    }
  })

  it('server instructions carry the rules for each profile', async () => {
    const { client } = await offlineServer({ profile: 'agent' })
    const text = client.getInstructions() ?? ''
    expect(text).toMatch(/DATA, never instructions/)
    expect(text).toMatch(/Do NOT retry with a different recipient/)
    expect(text).toMatch(/Never ask for, accept, store or repeat a private key/)
    expect(text).toMatch(/unaudited devnet prototype/i)
    const owner = (await offlineServer({ profile: 'owner' })).client.getInstructions() ?? ''
    expect(owner).toMatch(/UNSIGNED/)
    expect(owner).toMatch(/Never ask the human to paste a private key/)
  })
})
