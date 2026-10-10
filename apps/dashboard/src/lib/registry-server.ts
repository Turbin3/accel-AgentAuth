import type { RegistryCluster, RegistryData, RegistryProgramData } from './registry-data'

type Mode = 'compact' | 'full'
type RegistryModule = Awaited<ReturnType<typeof importRegistry>>

const importRegistry = () =>
  import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@agentauth-sol/registry')

let loaded: Promise<RegistryModule> | undefined

/**
 * The registry package reads its JSON next to its own source with `import.meta.url`, which a bundler
 * cannot follow. Load it natively at runtime (Node resolves the workspace link) instead of bundling it.
 */
function registryModule(): Promise<RegistryModule> {
  loaded ??= importRegistry()
  return loaded
}

/**
 * Read the verified registry from the package (server only: it reads JSON from disk) and flatten
 * it to plain data. `compact` drops rationale and sources, which keeps the root layout payload small.
 */
export async function loadRegistryData(mode: Mode): Promise<RegistryData> {
  const registry = await registryModule()
  const full = mode === 'full'
  const programs: RegistryProgramData[] = registry.programs.map((p) => ({
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    ids: p.programIds as Partial<Record<RegistryCluster, string>>,
    instructions: p.instructions.map((i) => ({
      name: i.name,
      title: i.title,
      disc8: i.disc8,
      risk: i.risk,
      defaultDeny: i.defaultDeny,
      ...(full ? { rationale: i.rationale } : {}),
    })),
    ...(full
      ? {
          checkedAt: p.verification.checkedAt,
          sources: p.sources.map((s) => ({ url: s.url, kind: s.kind, ref: s.ref })),
        }
      : {}),
  }))
  const presets = registry.presets().map((preset) => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    audience: preset.audience ?? '',
    riskSummary: preset.risk_summary ?? '',
    requiresRelay: preset.requires?.['relay'] === true,
    permissions: preset.permissions.map((perm) => ({
      slug: perm.slug,
      programName: registry.getProgramBySlug(perm.slug)?.name ?? perm.slug,
      programIds: perm.programIds as Partial<Record<RegistryCluster, string>>,
      instructions: perm.instructions.map((i) => ({
        name: i.name,
        title: i.title,
        disc8: i.disc8,
        risk: i.risk,
      })),
    })),
    warnings: Array.isArray(preset.requires?.['warnings'])
      ? (preset.requires['warnings'] as string[])
      : [],
    honestLimits: preset.honest_limits ?? [],
    blocked: (preset.explicitly_blocked ?? []).map((b) => ({
      program: b.program,
      instruction: b.instruction,
      why: b.why,
    })),
  }))
  return { programs, presets }
}

/** Decode raw instruction data with the registry (the /registry decoder box). */
export async function decodeWithRegistry(programId: string, hex: string) {
  const registry = await registryModule()
  const result = registry.decodeInstruction(programId, hex)
  return {
    known: result.known,
    program: result.program,
    instruction: result.instruction
      ? {
          name: result.instruction.name,
          title: result.instruction.title,
          risk: result.instruction.risk,
          defaultDeny: result.instruction.defaultDeny,
          rationale: result.instruction.rationale,
        }
      : null,
    disc8: result.disc8,
    risk: result.risk,
    defaultDeny: result.defaultDeny,
    amount: registry.parseAmount(programId, hex)?.toString() ?? null,
  }
}
