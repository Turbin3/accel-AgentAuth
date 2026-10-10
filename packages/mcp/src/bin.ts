#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, USAGE, parseConfig } from './config'
import { createLogger } from './log'
import { buildFromConfig } from './start'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE)
    return
  }
  const config = parseConfig(argv)
  const log = createLogger(config.logLevel)
  const handle = await buildFromConfig(config, log)
  await handle.server.connect(new StdioServerTransport())
  const stop = () => {
    void handle.server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : 'unexpected error'
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'startup_failed', message })}\n`)
  if (e instanceof ConfigError) process.stderr.write(`\n${USAGE}`)
  process.exit(e instanceof ConfigError ? 2 : 1)
})
