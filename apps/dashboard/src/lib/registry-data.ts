import type { RegistryLike, RegistryProgramLike } from '@agentauth-sol/sdk'

/** Registry cluster keys as the registry package spells them. */
export type RegistryCluster = 'mainnet-beta' | 'devnet' | 'testnet'

export interface RegistryInstructionData {
  readonly name: string
  readonly title: string
  readonly disc8: string
  readonly risk: string
  readonly defaultDeny: boolean
  /** Only present in the full catalogue used by /registry. */
  readonly rationale?: string
}

export interface RegistryProgramData {
  readonly slug: string
  readonly name: string
  readonly kind: string
  readonly ids: Readonly<Partial<Record<RegistryCluster, string>>>
  readonly instructions: readonly RegistryInstructionData[]
  /** Only present in the full catalogue. */
  readonly checkedAt?: string
  readonly sources?: readonly {
    readonly url: string
    readonly kind: string
    readonly ref: string
  }[]
}

export interface PresetInstructionData {
  readonly name: string
  readonly title: string
  readonly disc8: string
  readonly risk: string
}

export interface PresetPermissionData {
  readonly slug: string
  readonly programName: string
  readonly programIds: Readonly<Partial<Record<RegistryCluster, string>>>
  readonly instructions: readonly PresetInstructionData[]
}

export interface PresetData {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly audience: string
  readonly riskSummary: string
  /** The preset needs a relay policy (so the wizard can build it). */
  readonly requiresRelay: boolean
  readonly permissions: readonly PresetPermissionData[]
  readonly warnings: readonly string[]
  readonly honestLimits: readonly string[]
  readonly blocked: readonly {
    readonly program: string
    readonly instruction: string
    readonly why: string
  }[]
}

export interface RegistryData {
  readonly programs: readonly RegistryProgramData[]
  readonly presets: readonly PresetData[]
}

/** Build the slice of the registry the SDK needs (names, risk classes) from plain data. */
export function makeRegistry(data: RegistryData): RegistryLike {
  const byId = new Map<string, RegistryProgramLike>()
  for (const program of data.programs) {
    const like: RegistryProgramLike = {
      slug: program.slug,
      name: program.name,
      instructions: program.instructions.map((i) => ({
        name: i.name,
        title: i.title,
        disc8: i.disc8,
        risk: i.risk,
        defaultDeny: i.defaultDeny,
        ...(i.rationale === undefined ? {} : { rationale: i.rationale }),
      })),
    }
    for (const id of Object.values(program.ids)) if (id) byId.set(id, like)
  }
  const find = (programId: string, disc8: string) =>
    byId.get(programId)?.instructions.find((i) => i.disc8 === disc8)
  return {
    getProgramById: (programId) => byId.get(programId) ?? null,
    riskOf: (programId, disc8) => find(programId, disc8)?.risk ?? null,
    isDefaultDeny: (programId, disc8) => find(programId, disc8)?.defaultDeny ?? false,
  }
}

export const EMPTY_REGISTRY: RegistryData = { programs: [], presets: [] }
