import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Localnet e2e needs a validator (scripts/localnet.sh) and the demo bootstrap. This runs the
 * bootstrap into its OWN demo directory (never the shared .demo) when AA_RPC_URL is set. Delete
 * the directory (`$TMPDIR/aa-mcp-demo-<port>`) when you are done.
 * Without AA_RPC_URL the e2e files skip themselves, loudly; with AA_MCP_E2E=1 they fail instead.
 */
export default function setup(): () => void {
  const rpc = process.env['AA_RPC_URL']
  if (!rpc) {
    process.stderr.write(
      '[mcp tests] AA_RPC_URL is not set: localnet e2e tests will be SKIPPED (set AA_MCP_E2E=1 to make that a failure).\n',
    )
    return () => undefined
  }
  const root = resolve(import.meta.dirname, '..', '..', '..')
  // One demo directory per validator port, reused between runs: bootstrap is idempotent for the
  // same keys, and gated-example can only be initialised once per ledger.
  const port = new URL(rpc).port || 'default'
  const demoDir = join(tmpdir(), `aa-mcp-demo-${port}`)
  const res = spawnSync('pnpm', ['--filter', '@agentauth-sol/demo', 'bootstrap'], {
    cwd: root,
    env: { ...process.env, AA_DEMO_DIR: demoDir },
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(
      `demo bootstrap failed (exit ${String(res.status)}): ${(res.stderr || res.stdout).slice(-600)}`,
    )
  }
  process.env['AA_MCP_DEMO_DIR'] = demoDir
  return () => undefined
}
