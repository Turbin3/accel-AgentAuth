export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet'
export type Risk = 'read_only' | 'value_out' | 'value_swap' | 'position_mgmt' | 'authority_change' | 'account_close' | 'admin' | 'other'
export type DiscriminatorScheme = 'anchor-sha256' | 'u8-tag' | 'u32le-tag' | 'borsh-enum-u8' | 'custom'
export type InstructionData = string | Uint8Array | readonly number[]

export interface AmountDescriptor {
  offset: number
  size: 4 | 8
  type: 'u32le' | 'u64le'
  unit: string
}

export interface Instruction {
  readonly name: string
  readonly title: string
  readonly disc8: string
  readonly rawPrefixHex: string
  readonly risk: Risk
  readonly defaultDeny: boolean
  readonly rationale: string
  readonly amount: Readonly<AmountDescriptor> | null
  readonly notes: string
}

export interface Source {
  readonly url: string
  readonly kind: 'idl' | 'docs' | 'source'
  readonly ref: string
  readonly retrieved: string
}

export interface Program {
  readonly schemaVersion: 1
  readonly slug: string
  readonly name: string
  readonly kind: 'native' | 'anchor' | 'pinocchio' | 'other'
  readonly programIds: Readonly<Partial<Record<Cluster, string>>>
  readonly discriminatorScheme: DiscriminatorScheme
  readonly instructions: readonly Instruction[]
  readonly sources: readonly Source[]
  readonly verification: {
    readonly disc8RecomputedFromNames: boolean
    readonly idlExplicitDiscriminatorsMatch: boolean | null
    readonly onchainExecutable?: Readonly<Partial<Record<Cluster, boolean>>>
    readonly checkedAt: string
  }
}

export interface DecodeResult {
  /** true only when an instruction in the registry matched. Fail-closed callers should deny when false. */
  known: boolean
  program: { slug: string; name: string; programId: string } | null
  instruction: Instruction | null
  /** Canonical 8-byte discriminator (16 lowercase hex chars), or null when it cannot be determined. */
  disc8: string | null
  risk: Risk | 'unknown'
  defaultDeny: boolean
}

export interface PresetInstruction {
  readonly name: string
  readonly title: string
  readonly disc8: string
  readonly risk: Risk
  readonly amount: Readonly<AmountDescriptor> | null
}
export interface PresetPermission {
  readonly slug: string
  readonly programIds: Readonly<Partial<Record<Cluster, string>>>
  readonly instructions: readonly PresetInstruction[]
  readonly notes: string
  /** Example limits for this permission (free-form, from the preset file); null if none. */
  readonly suggested: Readonly<Record<string, unknown>> | null
}
export interface Preset {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly permissions: readonly PresetPermission[]
  readonly audience?: string
  readonly risk_summary?: string
  readonly explicitly_blocked?: readonly { program: string; instruction: string; why: string }[]
  readonly requires?: Readonly<Record<string, unknown>>
  readonly honest_limits?: readonly string[]
}

export const programs: readonly Program[]
export function getProgramById(id: string, cluster?: Cluster): Program | null
export function getProgramBySlug(slug: string): Program | null
export function instructionByName(programIdOrSlug: string, name: string): Instruction | null
export function decodeInstruction(programId: string, ixData: InstructionData, cluster?: Cluster): DecodeResult
export function canonicalDisc8(programId: string, ixData: InstructionData): string | null
export function riskOf(programId: string, disc8: string | Uint8Array): Risk | null
export function isDefaultDeny(programId: string, disc8: string | Uint8Array): boolean
export function parseAmount(programId: string, ixData: InstructionData): bigint | null
export function presets(): Preset[]
export function preset(name: string): Preset | null
