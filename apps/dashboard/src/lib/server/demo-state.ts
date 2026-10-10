import { checkDemoEnv, connect, loadDemoEnv, type DemoEnv } from '@agentauth-sol/demo'
import { alignDemoEndpoints } from './guard'

export interface DemoStatus {
  readonly available: boolean
  readonly reason: string | null
  readonly problems: readonly string[]
  /** True when the state file exists but the validator did not answer. */
  readonly unreachable: boolean
  readonly env: DemoEnv | null
}

/** The bootstrapped demo environment, checked against the live validator. Public addresses only. */
export async function readDemoStatus(): Promise<DemoStatus> {
  alignDemoEndpoints()
  let env: DemoEnv
  try {
    env = await loadDemoEnv()
  } catch (e) {
    return {
      available: false,
      reason: e instanceof Error ? e.message : 'The demo environment is not set up.',
      problems: [],
      unreachable: false,
      env: null,
    }
  }
  try {
    const problems = await checkDemoEnv(env, connect())
    return { available: problems.length === 0, reason: null, problems, unreachable: false, env }
  } catch {
    return {
      available: false,
      reason: `Cannot reach the RPC at ${env.rpcUrl}`,
      problems: [],
      unreachable: true,
      env,
    }
  }
}
