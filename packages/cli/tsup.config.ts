import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['@solana/kit', '@agentauth-sol/sdk', '@agentauth-sol/registry', 'commander'],
})
