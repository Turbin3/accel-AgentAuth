import * as registry from '@agentauth-sol/registry'
import {
  GATED_ACTION_DISC,
  SWAP_BASE_INPUT_DISC,
  describeInstruction,
  type Client,
  type Cluster,
} from '@agentauth-sol/sdk'
import { usageError } from './errors'

export type RegistryProgram = registry.Program
export type RegistryInstruction = registry.Instruction

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const HEX16 = /^[0-9a-fA-F]{16}$/

/** The registry knows devnet and mainnet-beta; localnet loads the devnet ids. */
export function registryCluster(cluster: Cluster): registry.Cluster {
  return cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet'
}

export interface ResolvedProgram {
  readonly id: string
  readonly name: string
  readonly slug: string | undefined
  readonly entry: RegistryProgram | null
}

/** A program given as a registry slug, a program id, or one of the AgentAuth program names. */
export function resolveProgram(input: string, client: Client, cluster: Cluster): ResolvedProgram {
  const own: Record<string, [string, string]> = {
    'agent-auth': [client.programIds.agentAuth, 'AgentAuth core'],
    relay: [client.programIds.relay, 'AgentAuth relay'],
    'mock-amm': [client.programIds.mockAmm, 'Mock AMM (Raydium CP-Swap ABI, test only)'],
    'gated-example': [client.programIds.gatedExample, 'gated-example'],
  }
  const ownEntry = own[input]
  if (ownEntry) return { id: ownEntry[0], name: ownEntry[1], slug: input, entry: null }
  if (ADDRESS.test(input)) {
    const entry = registry.getProgramById(input, registryCluster(cluster))
    const known = [...Object.values(own)].find(([id]) => id === input)
    return { id: input, name: entry?.name ?? known?.[1] ?? input, slug: entry?.slug, entry }
  }
  const entry = registry.getProgramBySlug(input)
  if (!entry) {
    throw usageError(
      `unknown program "${input}"`,
      `Use a program id, or one of: ${[...registry.programs.map((p) => p.slug), ...Object.keys(own)].join(', ')} (see \`agentauth registry list\`).`,
    )
  }
  const id = entry.programIds[registryCluster(cluster)] ?? entry.programIds.devnet
  if (id === undefined) throw usageError(`program "${input}" has no id on ${cluster}`)
  return { id, name: entry.name, slug: entry.slug, entry }
}

export interface ResolvedInstruction {
  readonly disc8: string
  readonly name: string | undefined
  readonly risk: string | undefined
  readonly defaultDeny: boolean
}

const BUILTIN_NAMES: Record<string, Record<string, string>> = {
  'mock-amm': { swap_base_input: SWAP_BASE_INPUT_DISC },
  'gated-example': { gated_action: GATED_ACTION_DISC },
}

/** An instruction given as a registry name (`transfer_checked`) or a 16-hex-char disc8. */
export function resolveInstruction(
  program: ResolvedProgram,
  input: string,
  client: Client,
): ResolvedInstruction {
  let disc8: string | undefined
  if (HEX16.test(input)) disc8 = input.toLowerCase()
  else {
    const builtin = program.slug === undefined ? undefined : BUILTIN_NAMES[program.slug]?.[input]
    disc8 = builtin ?? registry.instructionByName(program.id, input)?.disc8
  }
  if (disc8 === undefined) {
    const known =
      program.entry?.instructions.map((i) => i.name) ??
      Object.keys(BUILTIN_NAMES[program.slug ?? ''] ?? {})
    throw usageError(
      `unknown instruction "${input}" for ${program.name}`,
      known.length > 0
        ? `Known: ${known.join(', ')}. You can also pass a 16-hex-character disc8.`
        : 'This program is not in the registry: pass the instruction as a 16-hex-character disc8.',
    )
  }
  const info = describeInstruction(program.id, disc8, client.registry)
  return {
    disc8,
    name: info.name ?? undefined,
    risk: info.risk ?? undefined,
    defaultDeny: info.defaultDeny,
  }
}

export { registry }
