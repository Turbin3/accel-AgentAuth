import type { Command } from 'commander'
import { CliError, EXIT, toCliError } from './errors'
import { makeCtx, type Ctx, type Deps, type GlobalOpts } from './env'
import { Out } from './output'

export interface RunState {
  exitCode: number
}

export type Handler<T> = (ctx: Ctx, o: T & GlobalOpts, args: string[]) => Promise<number | void>

/**
 * Wraps one command: builds the context from the global options, runs the handler, and turns every
 * failure into the documented exit code (and the `--json` error envelope).
 */
export type Runner = <T>(name: string, actionArgs: unknown[], handler: Handler<T>) => Promise<void>

export function makeRunner(deps: Deps, state: RunState): Runner {
  return async (name, actionArgs, handler) => {
    const cmd = actionArgs[actionArgs.length - 1] as Command
    const opts = cmd.optsWithGlobals() as GlobalOpts
    const args = actionArgs.slice(0, -2) as string[]
    let ctx: Ctx | undefined
    try {
      ctx = await makeCtx(deps, opts)
      const code = await handler(ctx, opts as never, args)
      if (typeof code === 'number') state.exitCode = code
    } catch (error) {
      const err = toCliError(error)
      const out =
        ctx?.out ?? new Out(deps.stdout, deps.stderr, { json: opts.json === true, color: false })
      out.fail(name, ctx?.cluster ?? opts.cluster, err)
      state.exitCode = err.exitCode
      if (
        err.exitCode === EXIT.usage &&
        !(error instanceof CliError) &&
        deps.env['AGENTAUTH_DEBUG']
      ) {
        deps.stderr.write(`${String((error as Error).stack)}\n`)
      }
    }
  }
}
