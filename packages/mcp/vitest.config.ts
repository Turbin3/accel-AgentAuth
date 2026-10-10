import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    globalSetup: ['test/global-setup.ts'],
    // Localnet tests share one validator and one funded owner: run files one after another.
    fileParallelism: false,
  },
})
