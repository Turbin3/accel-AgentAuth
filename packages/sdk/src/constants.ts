import { address, type Address } from '@solana/kit'

/** AgentAuth core program (devnet deployment). Source: idl/core-idl.json `addresses.devnet`. */
export const AGENT_AUTH_PROGRAM_ID: Address = address(
  'AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if',
)
/** AgentAuth Relay program (throwaway test/devnet key). Source: idl/relay-idl.json. */
export const RELAY_PROGRAM_ID: Address = address('33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6')
/** Raydium-CPMM-shaped mock AMM (test/demo only; never allowlisted on a mainnet relay build). */
export const MOCK_AMM_PROGRAM_ID: Address = address('6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw')
/** `gated-example`, the second (non-relay) integrator of `verify` (test/demo only). */
export const GATED_EXAMPLE_PROGRAM_ID: Address = address(
  'CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ',
)
/** SPL Token (classic; p-token shares this id). */
export const TOKEN_PROGRAM_ID: Address = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
/** SPL Token-2022. */
export const TOKEN_2022_PROGRAM_ID: Address = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
/** System program. */
export const SYSTEM_PROGRAM_ID: Address = address('11111111111111111111111111111111')
/** Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID: Address = address(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
)
/** Wrapped SOL mint. The relay rejects it as budget mint / input mint. */
export const NATIVE_MINT: Address = address('So11111111111111111111111111111111111111112')
/** Raydium CP-Swap, mainnet-beta. */
export const RAYDIUM_CPMM_MAINNET_PROGRAM_ID: Address = address(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
)
/** Raydium CP-Swap, devnet. */
export const RAYDIUM_CPMM_DEVNET_PROGRAM_ID: Address = address(
  'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb',
)
/** The all-zero address (System program id). Used by the relay for "unset" config slots. */
export const ZERO_ADDRESS: Address = SYSTEM_PROGRAM_ID

/**
 * `disc8` reported to `verify` for SPL `TransferChecked`: the SPL tag byte (12) zero padded.
 * SPL instructions have no 8-byte discriminator; this is the documented AgentAuth convention.
 */
export const TRANSFER_CHECKED_DISC = '0c00000000000000'
/** `disc8` of Raydium CP-Swap `swap_base_input` = sha256("global:swap_base_input")[0..8]. */
export const SWAP_BASE_INPUT_DISC = '8fbe5adac41e33de'
/** `disc8` of the `gated-example` program's `gated_action` instruction. */
export const GATED_ACTION_DISC = '0100000000000000'

/** Core mandate account size in bytes (locked layout). */
export const ACCOUNT_SIZE = 2136
/** Mandate header size; permission slots start here. */
export const HEADER_SIZE = 88
/** Size of one permission slot. */
export const PERMISSION_SIZE = 128
/** Maximum permission slots per mandate. */
export const MAX_PERMISSIONS = 16
/** Maximum discriminators per permission slot. */
export const MAX_DISCRIMINATORS = 8
/** First byte of every initialised mandate. */
export const MANDATE_DISCRIMINATOR = 1
/** Mandate layout version written by the hardened core (header byte 79). */
export const MANDATE_VERSION = 1

/** RelayPolicy account size in bytes. */
export const POLICY_SIZE = 944
/** First byte of every RelayPolicy. */
export const POLICY_DISCRIMINATOR = 0xa7
/** RelayPolicy layout version. */
export const POLICY_VERSION = 1
/** Offset of the immutable config region inside the policy account. */
export const POLICY_CONFIG_OFFSET = 144
/** Length of the config region (also bytes [2..802) of `init_policy` data). */
export const POLICY_CONFIG_SIZE = 800
/** Total `init_policy` instruction data length (tag + flags + config). */
export const INIT_POLICY_DATA_SIZE = 802
/** Maximum allowlisted recipient token accounts per policy. */
export const MAX_RECIPIENTS = 8
/** Upper bound of `max_deadline_slots`. */
export const MAX_DEADLINE_SLOTS_CAP = 9000
/** Policy flag bit 0: the relay refuses every action (reversible kill switch). */
export const POLICY_FLAG_PAUSED = 0x01
/** Policy flag bit 1: relay actions must be top-level instructions (stack height 1). */
export const POLICY_FLAG_STRICT_TOP_LEVEL = 0x02

/** Maximum serialized transaction size accepted by the cluster. */
export const MAX_TRANSACTION_SIZE = 1232

/** Supported clusters. */
export type Cluster = 'localnet' | 'devnet' | 'mainnet-beta'

/** Public RPC endpoint presets (rate limited; use your own provider for anything serious). */
export const CLUSTER_RPC_URLS: Readonly<Record<Cluster, string>> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
}

/** Program ids the SDK talks to for one cluster. */
export interface ProgramIds {
  readonly agentAuth: Address
  readonly relay: Address
  readonly mockAmm: Address
  readonly gatedExample: Address
  readonly token: Address
  readonly token2022: Address
  readonly system: Address
  readonly associatedToken: Address
  /** Raydium CP-Swap for this cluster (devnet id on localnet). */
  readonly raydiumCpmm: Address
}

/**
 * Program ids for a cluster, optionally overridden (localnet, tests, forks).
 *
 * The same AgentAuth/relay ids are returned for every cluster, but only devnet has a deployment
 * (as of 2026-10-10): there is NO mainnet-beta deployment. Overrides are per call; nothing global
 * is mutated.
 *
 * @example
 * const ids = programIds('localnet', { relay: address('...') })
 */
export function programIds(cluster: Cluster, overrides: Partial<ProgramIds> = {}): ProgramIds {
  const base: ProgramIds = {
    agentAuth: AGENT_AUTH_PROGRAM_ID,
    relay: RELAY_PROGRAM_ID,
    mockAmm: MOCK_AMM_PROGRAM_ID,
    gatedExample: GATED_EXAMPLE_PROGRAM_ID,
    token: TOKEN_PROGRAM_ID,
    token2022: TOKEN_2022_PROGRAM_ID,
    system: SYSTEM_PROGRAM_ID,
    associatedToken: ASSOCIATED_TOKEN_PROGRAM_ID,
    raydiumCpmm:
      cluster === 'mainnet-beta' ? RAYDIUM_CPMM_MAINNET_PROGRAM_ID : RAYDIUM_CPMM_DEVNET_PROGRAM_ID,
  }
  return { ...base, ...overrides }
}

/** True when AgentAuth + relay are deployed on the cluster (devnet only, to the best of our knowledge). */
export function isDeployedOn(cluster: Cluster): boolean {
  return cluster === 'devnet' || cluster === 'localnet'
}
