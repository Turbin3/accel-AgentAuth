import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isAddress } from '@solana/kit'
import { preset, presets, programs } from '@agentauth-sol/registry'
import { SdkError, toJsonSafe, explainMandate, isoOfSeconds } from '@agentauth-sol/sdk'
import type { Context } from './context'
import { HONESTY } from './reply'
import { safeString, tidy } from './sanitize'

const MAX_RESOURCE_CHARS = 120_000

function json(uri: string, value: unknown) {
  let text = JSON.stringify(toJsonSafe(value))
  if (text.length > MAX_RESOURCE_CHARS) text = JSON.stringify({ error: 'resource too large' })
  return { contents: [{ uri, mimeType: 'application/json', text }] }
}

/** Registry programs: names, ids and instructions with their risk class (static data shipped with the registry package). */
export function programsResource() {
  return {
    note: 'Instruction discriminators (disc8) as used in mandates. defaultDeny marks instructions the registry flags as dangerous. Data only.',
    programs: programs.map((p) => ({
      slug: p.slug,
      name: p.name,
      programIds: p.programIds,
      instructions: p.instructions.map((i) => ({
        name: i.name,
        disc8: i.disc8,
        risk: i.risk,
        defaultDeny: i.defaultDeny,
      })),
    })),
  }
}

export function presetsResource() {
  return {
    note: 'Starting points for mandates. A preset is a suggestion, not a policy: the owner reviews limits.',
    presets: presets().map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      audience: p.audience ?? null,
      risk_summary: p.risk_summary ?? null,
      permissions: p.permissions.map((perm) => ({
        slug: perm.slug,
        instructions: perm.instructions.map((i) => ({
          name: i.name,
          disc8: i.disc8,
          risk: i.risk,
        })),
      })),
      honest_limits: p.honest_limits ?? [],
    })),
    lookup: (name: string) => preset(name)?.name ?? null,
  }
}

/** Register the three resources. All are read-only and available in every profile. */
export function registerResources(server: McpServer, ctx: Context): void {
  server.registerResource(
    'registry-programs',
    'agentauth://registry/programs',
    {
      title: 'Known programs and instructions',
      description:
        'Verified registry of Solana programs, instruction discriminators and risk classes. Data only.',
      mimeType: 'application/json',
    },
    (uri) => json(uri.href, programsResource()),
  )
  server.registerResource(
    'presets',
    'agentauth://presets',
    {
      title: 'Mandate presets',
      description: 'Suggested permission sets. Data only.',
      mimeType: 'application/json',
    },
    (uri) => {
      const { lookup: _lookup, ...rest } = presetsResource()
      return json(uri.href, rest)
    },
  )
  server.registerResource(
    'mandate',
    new ResourceTemplate('agentauth://mandate/{address}', { list: undefined }),
    {
      title: 'Mandate by address',
      description: 'A mandate account explained in plain language. Read-only chain data.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables['address']
      const address = Array.isArray(raw) ? raw[0] : raw
      if (typeof address !== 'string' || !isAddress(address)) {
        return json(uri.href, {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'not a valid mandate address' },
        })
      }
      if (!ctx.callLimiter.tryAcquire(ctx.now())) {
        return json(uri.href, {
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many calls in the last minute.' },
        })
      }
      let view
      try {
        view = await ctx.withTimeout(ctx.client.inspect(address), 'reading the mandate')
      } catch (e) {
        return json(uri.href, {
          ok: false,
          error:
            e instanceof SdkError
              ? { code: 'NOT_A_MANDATE', message: safeString(e.message, 200) }
              : { code: 'RPC_ERROR', message: 'The RPC endpoint did not answer.' },
        })
      }
      if (!view.mandate || !view.explanation) {
        return json(uri.href, {
          ok: true,
          status: 'not_found',
          note: 'No mandate account at this address.',
        })
      }
      const e = explainMandate(view.mandate, { policy: view.policy })
      return json(uri.href, {
        ok: true,
        address,
        owner: view.mandate.owner,
        agent: view.mandate.agent,
        status: view.explanation.status,
        expires_at: isoOfSeconds(view.mandate.expiry),
        headline: tidy(e.headline, 300),
        enforcement: view.explanation.enforcement,
        warnings: view.explanation.warnings.slice(0, 12).map((w) => tidy(w, 300)),
        honesty: HONESTY,
      })
    },
  )
}
