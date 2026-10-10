import { Command, CommanderError, Option } from 'commander'
import { registerActivity } from './commands/activity'
import { registerCheck } from './commands/check'
import { registerDiagnostics } from './commands/diagnostics'
import { registerLint } from './commands/lint'
import { registerMandate } from './commands/mandate'
import { registerPermission } from './commands/permission'
import { registerRegistry } from './commands/registry'
import { registerRelay } from './commands/relay'
import { defaultDeps, type Deps } from './env'
import { EXIT } from './errors'
import { makeRunner, type RunState } from './runner'
import { VERSION } from './version'

const FOOTER = `
Exit codes: 0 ok, 1 usage (and lint errors), 2 denied by pre-flight, 3 on-chain failure, 4 network.
AgentAuth is an unaudited devnet prototype. Hard enforcement exists only for the relay transfer and
the pinned swap; everything else a mandate lists is advisory. Docs: packages/cli/README.md`

export function buildProgram(deps: Deps, state: RunState): Command {
  const program = new Command('agentauth')
  program
    .description(
      'AgentAuth: give an AI agent a mandate on Solana, see what it did, take it back (unaudited devnet prototype)',
    )
    .version(VERSION, '-V, --version', 'print the CLI version')
    .addOption(
      new Option(
        '--cluster <name>',
        'localnet, devnet or mainnet-beta (default: localnet when the demo environment exists, else devnet)',
      ).choices(['localnet', 'devnet', 'mainnet-beta']),
    )
    .option(
      '--url <rpc-url>',
      'RPC endpoint (default: the cluster preset; localnet: AA_RPC_URL or the demo state)',
    )
    .option(
      '--keypair <path>',
      'owner keypair file (default: ~/.config/solana/id.json, or the demo owner on localnet)',
    )
    .option('--agent-keypair <path>', 'agent keypair file (default: the demo agent on localnet)')
    .option('--json', 'machine-readable output: one JSON document on stdout')
    .option('--yes', 'do not ask for confirmation')
    .option('--simulate', 'simulate transactions instead of sending them')
    .option('--no-color', 'disable colour (NO_COLOR is honoured too)')
    .option('--raw', 'show and accept raw base units instead of human amounts')
    .option('--i-understand-this-is-unaudited', 'required for --cluster mainnet-beta')
    .addHelpText('after', FOOTER)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
    })
    .showHelpAfterError('(add --help for usage)')

  const run = makeRunner(deps, state)
  registerDiagnostics(program, run)
  registerRegistry(program, run)
  registerMandate(program, run)
  registerPermission(program, run)
  registerRelay(program, run)
  registerActivity(program, run)
  registerLint(program, run)
  registerCheck(program, run)
  return program
}

/** Run the CLI and return its exit code (no process.exit: callers and tests decide). */
export async function runCli(argv: readonly string[], deps: Deps = defaultDeps()): Promise<number> {
  const state: RunState = { exitCode: EXIT.ok }
  const program = buildProgram(deps, state)
  try {
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      ) {
        return EXIT.ok
      }
      return EXIT.usage
    }
    throw error
  }
  return state.exitCode
}
