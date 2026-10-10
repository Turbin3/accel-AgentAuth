import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against a PRODUCTION build (`pnpm build`) and a fresh local validator with the
 * demo bootstrapped (`scripts/localnet.sh start`, `pnpm --filter @agentauth-sol/demo bootstrap`).
 * They sign with the dev signer, so the server is started with NEXT_PUBLIC_AA_DEV_SIGNER=1 on localnet.
 *
 * Environment: AA_RPC_URL / AA_DEMO_DIR (from `scripts/localnet.sh env`), E2E_PORT (default 3113).
 * Set E2E_BASE_URL to reuse an already running server.
 */
const port = Number(process.env['E2E_PORT'] ?? 3113)
const baseURL = process.env['E2E_BASE_URL'] ?? `http://localhost:${port}`

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : {
        command: `pnpm exec next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          NEXT_PUBLIC_AA_CLUSTER: 'localnet',
          NEXT_PUBLIC_AA_DEV_SIGNER: '1',
          AA_RPC_URL: process.env['AA_RPC_URL'] ?? 'http://127.0.0.1:8899',
          ...(process.env['AA_DEMO_DIR'] ? { AA_DEMO_DIR: process.env['AA_DEMO_DIR'] } : {}),
        },
      },
})
