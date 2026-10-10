import { runCli } from './app'

// `agentauth ... | head` closes the pipe early: that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `agentauth: internal error: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  },
)
