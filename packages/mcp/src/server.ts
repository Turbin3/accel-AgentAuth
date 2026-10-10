import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mandatePda } from '@agentauth-sol/sdk'
import type { Config } from './config'
import { createContext, type Context, type ContextParts } from './context'
import { instructionsFor } from './instructions'
import { registerPrompts } from './prompts'
import { registerResources } from './resources'
import { AGENT_TOOLS } from './tools/agent'
import type { ToolDef } from './tools/define'
import { DEV_SIGN_TOOL, OBSERVER_TOOLS, OWNER_TOOLS } from './tools/owner'

export const SERVER_NAME = 'agentauth-mcp'
export const SERVER_VERSION = '0.1.0'

/** The tools of a profile, in registration order. */
export function toolsFor(config: Pick<Config, 'profile' | 'unsafeDevSign'>): readonly ToolDef[] {
  const explain = AGENT_TOOLS.find((t) => t.name === 'agentauth_explain_denial')
  switch (config.profile) {
    case 'agent':
      return AGENT_TOOLS
    case 'owner':
      return [
        ...OWNER_TOOLS,
        ...(explain ? [explain] : []),
        ...(config.unsafeDevSign ? [DEV_SIGN_TOOL] : []),
      ]
    case 'observer':
      return [...OBSERVER_TOOLS, ...(explain ? [explain] : [])]
  }
}

export interface ServerHandle {
  readonly server: McpServer
  readonly ctx: Context
  readonly tools: readonly ToolDef[]
  /** Show or hide `agentauth_swap` according to the live policy. Never throws. */
  refreshSwap(): Promise<void>
}

/** Build the MCP server for one profile. No network call happens here. */
export function createServer(parts: ContextParts): ServerHandle {
  const ctx = createContext(parts)
  const tools = toolsFor(parts.config)
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructionsFor(parts.config.profile) },
  )
  const registered = new Map<string, RegisteredTool>()
  const handle: ServerHandle = {
    server,
    ctx,
    tools,
    async refreshSwap() {
      const swap = registered.get('agentauth_swap')
      if (!swap || !ctx.config.owner || !ctx.agentSigner) return
      try {
        const mandate = (
          await mandatePda(
            ctx.config.owner,
            ctx.agentSigner.address,
            ctx.client.programIds.agentAuth,
          )
        ).address
        const policy = await ctx.withTimeout(ctx.client.fetchPolicy(mandate), 'reading the policy')
        const enabled = policy?.swap != null
        if (enabled && !swap.enabled) swap.enable()
        if (!enabled && swap.enabled) swap.disable()
      } catch {
        ctx.log.warn('swap_refresh_failed')
      }
    },
  }
  for (const def of tools) {
    const tool = server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: def.annotations,
      },
      async (args: unknown) => {
        const result = await def.run(args, ctx)
        if (def.name === 'agentauth_status') await handle.refreshSwap()
        return result
      },
    )
    registered.set(def.name, tool)
  }
  // `agentauth_swap` exists only while the live policy enables it (see refreshSwap).
  registered.get('agentauth_swap')?.disable()
  registerResources(server, ctx)
  registerPrompts(server, parts.config.profile)
  return handle
}
