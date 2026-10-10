import { isAddress, type Address } from '@solana/kit'

/** Clusters the dashboard can talk to. AgentAuth has no mainnet deployment. */
export type DashboardCluster = 'localnet' | 'devnet'

export interface AppConfig {
  readonly cluster: DashboardCluster
  readonly rpcUrl: string
  /** Mandate shown read-only to visitors without a wallet, when configured. */
  readonly demoMandate: Address | null
  readonly phantomAppId: string | null
  /** Public source repository, when the deployer sets one. */
  readonly repoUrl: string | null
  readonly devSigner: {
    /** The browser-side throwaway key is offered. */
    readonly browserKey: boolean
    /** The server-side demo owner key (route /api/dev/sign) is offered. Localnet with a loopback RPC only. */
    readonly serverKey: boolean
    /** Why a requested dev signer is off, for the UI. */
    readonly disabledReason: string | null
  }
  /** Blocking configuration problem (for example a mainnet request). The app renders only this. */
  readonly fatal: string | null
}

type Env = Readonly<Record<string, string | undefined>>

const DEFAULT_RPC: Record<DashboardCluster, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v === undefined || v === '' ? undefined : v
}

/**
 * Resolve the runtime configuration from the environment. Pure and total: it never throws, and a
 * mainnet request yields `fatal` with every dev signer switched off. The dev signer can only be
 * enabled when the cluster is localnet or devnet; there is no code path that enables it otherwise.
 */
export function resolveConfig(env: Env): AppConfig {
  const requested = clean(env['NEXT_PUBLIC_AA_CLUSTER']) ?? 'devnet'
  const wantsDevSigner = clean(env['NEXT_PUBLIC_AA_DEV_SIGNER']) === '1'
  const demoRaw = clean(env['NEXT_PUBLIC_AA_DEMO_MANDATE'])
  const demoMandate = demoRaw !== undefined && isAddress(demoRaw) ? demoRaw : null
  const phantomAppId = clean(env['NEXT_PUBLIC_PHANTOM_APP_ID']) ?? null
  const repoRaw = clean(env['NEXT_PUBLIC_AA_REPO_URL'])
  const repoUrl = repoRaw !== undefined && /^https:\/\/[^\s]+$/.test(repoRaw) ? repoRaw : null

  if (requested !== 'localnet' && requested !== 'devnet') {
    return {
      cluster: 'devnet',
      rpcUrl: DEFAULT_RPC.devnet,
      demoMandate: null,
      phantomAppId,
      repoUrl,
      devSigner: {
        browserKey: false,
        serverKey: false,
        disabledReason: wantsDevSigner
          ? `the dev signer cannot be enabled on "${requested}"`
          : null,
      },
      fatal:
        requested === 'mainnet-beta'
          ? 'AgentAuth has no mainnet deployment and this build refuses mainnet-beta. It is an unaudited devnet prototype. Set NEXT_PUBLIC_AA_CLUSTER to devnet or localnet.'
          : `Unknown cluster "${requested}". Set NEXT_PUBLIC_AA_CLUSTER to devnet or localnet.`,
    }
  }

  const cluster: DashboardCluster = requested
  const rpcUrl =
    clean(env['NEXT_PUBLIC_AA_RPC_URL']) ?? clean(env['AA_RPC_URL']) ?? DEFAULT_RPC[cluster]
  const serverKey = wantsDevSigner && cluster === 'localnet' && isLoopbackUrl(rpcUrl)
  return {
    cluster,
    rpcUrl,
    demoMandate,
    phantomAppId,
    repoUrl,
    devSigner: {
      browserKey: wantsDevSigner,
      serverKey,
      disabledReason: null,
    },
    fatal: null,
  }
}

/** Explorer link for a transaction or an address on the configured cluster. */
export function explorerUrl(
  config: Pick<AppConfig, 'cluster' | 'rpcUrl'>,
  kind: 'tx' | 'address',
  value: string,
): string {
  const base = `https://explorer.solana.com/${kind}/${value}`
  if (config.cluster === 'devnet') return `${base}?cluster=devnet`
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`
}

export function clusterLabel(cluster: DashboardCluster): string {
  return cluster === 'localnet' ? 'Localnet' : 'Devnet'
}
