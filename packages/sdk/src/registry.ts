import type { Address } from '@solana/kit'
import {
  GATED_ACTION_DISC,
  GATED_EXAMPLE_PROGRAM_ID,
  MOCK_AMM_PROGRAM_ID,
  RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
} from './constants'

/** Risk classes of the AgentAuth registry (packages/registry/SCHEMA.md). */
export type RiskClass =
  | 'read_only'
  | 'value_out'
  | 'value_swap'
  | 'position_mgmt'
  | 'authority_change'
  | 'account_close'
  | 'admin'
  | 'other'

/** One instruction row, as the registry exposes it. */
export interface RegistryInstructionLike {
  readonly name: string
  readonly title?: string
  /** Canonical 8-byte discriminator, lower-case hex. */
  readonly disc8: string
  readonly risk: string
  readonly defaultDeny?: boolean
  readonly rationale?: string
}

/** One program entry, as the registry exposes it. */
export interface RegistryProgramLike {
  readonly slug?: string
  readonly name: string
  readonly instructions: readonly RegistryInstructionLike[]
}

/**
 * The slice of `@agentauth-sol/registry` the SDK uses. The SDK never imports the registry
 * statically: pass the module (`import * as registry from '@agentauth-sol/registry'`), or let
 * {@link loadRegistry} find it. Everything except `getProgramById` is optional.
 */
export interface RegistryLike {
  getProgramById(programId: string): RegistryProgramLike | null | undefined
  riskOf?(programId: string, disc8: string): string | null | undefined
  isDefaultDeny?(programId: string, disc8: string): boolean
}

const TOKEN_PROGRAM_ENTRY: RegistryProgramLike = {
  slug: 'spl-token',
  name: 'SPL Token',
  instructions: [
    { name: 'transfer', title: 'Transfer', disc8: '0300000000000000', risk: 'value_out' },
    {
      name: 'approve',
      title: 'Approve delegate',
      disc8: '0400000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    {
      name: 'revoke',
      title: 'Revoke delegate',
      disc8: '0500000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    {
      name: 'set_authority',
      title: 'Set authority',
      disc8: '0600000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    {
      name: 'mint_to',
      title: 'Mint tokens',
      disc8: '0700000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    { name: 'burn', title: 'Burn', disc8: '0800000000000000', risk: 'value_out' },
    {
      name: 'freeze_account',
      title: 'Freeze account',
      disc8: '0a00000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    {
      name: 'thaw_account',
      title: 'Thaw account',
      disc8: '0b00000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    {
      name: 'close_account',
      title: 'Close account',
      disc8: '0900000000000000',
      risk: 'account_close',
      defaultDeny: true,
    },
    {
      name: 'transfer_checked',
      title: 'Transfer (checked)',
      disc8: TRANSFER_CHECKED_DISC,
      risk: 'value_out',
    },
    {
      name: 'mint_to_checked',
      title: 'Mint tokens (checked)',
      disc8: '0e00000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    { name: 'burn_checked', title: 'Burn (checked)', disc8: '0f00000000000000', risk: 'value_out' },
    {
      name: 'sync_native',
      title: 'Sync native',
      disc8: '1100000000000000',
      risk: 'other',
    },
    {
      name: 'approve_checked',
      title: 'Approve delegate (checked)',
      disc8: '0d00000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
  ],
}

/** System program, canonical disc8 = u32-LE tag + 4 zero bytes. Only the value/authority-moving rows. */
const SYSTEM_PROGRAM_ENTRY: RegistryProgramLike = {
  slug: 'system',
  name: 'System Program',
  instructions: [
    {
      name: 'create_account',
      title: 'Create account',
      disc8: '0000000000000000',
      risk: 'value_out',
    },
    {
      name: 'assign',
      title: 'Assign account owner',
      disc8: '0100000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
    { name: 'transfer', title: 'Transfer SOL', disc8: '0200000000000000', risk: 'value_out' },
    {
      name: 'allocate',
      title: 'Allocate account space',
      disc8: '0800000000000000',
      risk: 'authority_change',
      defaultDeny: true,
    },
  ],
}

const SWAP_PROGRAM_ENTRY: RegistryProgramLike = {
  slug: 'amm-swap',
  name: 'Raydium CP-Swap ABI',
  instructions: [
    {
      name: 'swap_base_input',
      title: 'Swap (exact input)',
      disc8: SWAP_BASE_INPUT_DISC,
      risk: 'value_swap',
    },
  ],
}

const GATED_PROGRAM_ENTRY: RegistryProgramLike = {
  slug: 'gated-example',
  name: 'AgentAuth gated-example',
  instructions: [
    { name: 'gated_action', title: 'Gated action', disc8: GATED_ACTION_DISC, risk: 'value_out' },
  ],
}

const BUILTIN: ReadonlyMap<string, RegistryProgramLike> = new Map<string, RegistryProgramLike>([
  [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ENTRY],
  [
    TOKEN_2022_PROGRAM_ID,
    { ...TOKEN_PROGRAM_ENTRY, slug: 'spl-token-2022', name: 'SPL Token-2022' },
  ],
  [RAYDIUM_CPMM_DEVNET_PROGRAM_ID, SWAP_PROGRAM_ENTRY],
  [RAYDIUM_CPMM_MAINNET_PROGRAM_ID, SWAP_PROGRAM_ENTRY],
  [MOCK_AMM_PROGRAM_ID, { ...SWAP_PROGRAM_ENTRY, slug: 'mock-amm', name: 'Mock AMM (test only)' }],
  [GATED_EXAMPLE_PROGRAM_ID, GATED_PROGRAM_ENTRY],
  [SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM_ENTRY],
])

/**
 * A tiny built-in registry covering the SPL Token core, the Raydium CP-Swap ABI, the mock AMM and
 * gated-example. It lets `explain` and `activity` work without the registry package; the real
 * registry (hundreds of instructions, sources, verification metadata) is preferred when available.
 */
export const builtinRegistry: RegistryLike = {
  getProgramById(programId) {
    return BUILTIN.get(programId) ?? null
  },
}

/** Everything the SDK knows about one (program, disc8) pair. */
export interface InstructionInfo {
  readonly programId: string
  readonly programName: string | null
  readonly name: string | null
  readonly title: string | null
  readonly risk: string | null
  readonly defaultDeny: boolean
  /** True when a registry row matched. */
  readonly known: boolean
}

/** Risk classes that the registry marks default-deny. */
export const DEFAULT_DENY_RISKS: readonly string[] = ['authority_change', 'account_close', 'admin']

/**
 * Look up a (program, disc8) pair in `registry`, falling back to the built-in table. Never throws
 * on registry errors: a misbehaving registry degrades to "unknown".
 */
export function describeInstruction(
  programId: Address | string,
  disc8: string,
  registry?: RegistryLike | null,
): InstructionInfo {
  for (const source of [registry, builtinRegistry]) {
    if (!source) continue
    try {
      const program = source.getProgramById(programId)
      if (!program) continue
      const row = program.instructions.find((i) => i.disc8.toLowerCase() === disc8.toLowerCase())
      if (row) {
        const defaultDeny =
          row.defaultDeny === true ||
          DEFAULT_DENY_RISKS.includes(row.risk) ||
          safeBool(() => source.isDefaultDeny?.(programId, disc8))
        return {
          programId,
          programName: program.name,
          name: row.name,
          title: row.title ?? row.name,
          risk: row.risk,
          defaultDeny,
          known: true,
        }
      }
      return {
        programId,
        programName: program.name,
        name: null,
        title: null,
        risk: null,
        defaultDeny: false,
        known: false,
      }
    } catch {
      continue
    }
  }
  return {
    programId,
    programName: null,
    name: null,
    title: null,
    risk: null,
    defaultDeny: false,
    known: false,
  }
}

/**
 * Display name of a program: the registry's name, else the built-in table's, else a short address
 * (`Abcd…wxyz`). Never throws.
 */
export function describeProgram(
  programId: Address | string,
  registry?: RegistryLike | null,
): string {
  for (const source of [registry, builtinRegistry]) {
    if (!source) continue
    try {
      const name = source.getProgramById(programId)?.name
      if (name) return name
    } catch {
      continue
    }
  }
  return programId.length > 10 ? `${programId.slice(0, 4)}…${programId.slice(-4)}` : programId
}

function safeBool(fn: () => boolean | undefined): boolean {
  try {
    return fn() === true
  } catch {
    return false
  }
}

/**
 * Try to load `@agentauth-sol/registry` without a static dependency. Resolves to `null` when the
 * package is not installed. The import specifier is intentionally not a literal so bundlers keep it
 * external.
 */
export async function loadRegistry(): Promise<RegistryLike | null> {
  try {
    const specifier = '@agentauth-sol/registry'
    const mod: unknown = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
    )
    const candidate = (mod as { default?: unknown }).default ?? mod
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as RegistryLike).getProgramById === 'function'
    ) {
      return candidate as RegistryLike
    }
    return null
  } catch {
    return null
  }
}
