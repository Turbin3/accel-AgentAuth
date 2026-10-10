import type { Command } from 'commander'
import { CliError, usageError } from '../errors'
import {
  RULES,
  lintPlan,
  planFromPreset,
  readPlan,
  summarize,
  type Finding,
  type LintPlan,
} from '../lint'
import type { Runner } from '../runner'
import { parseDurationFlag } from '../units'

interface LintOpts {
  maxExpiry?: string
  failOn?: 'error' | 'warn'
}

export function registerLint(program: Command, run: Runner): void {
  program
    .command('lint')
    .argument('<plan>', 'plan.json, "-" for stdin, or a registry preset name')
    .option('--max-expiry <duration>', 'flag mandates that live longer than this (for example 30d)')
    .option('--fail-on <level>', 'exit 1 on "error" (default) or on "warn" too', 'error')
    .description(
      'static analysis of a mandate plan for CI (no network, no keys); exit 1 on any error',
    )
    .addHelpText(
      'after',
      `
Rules: ${Object.entries(RULES)
        .map(([id, r]) => `${id} ${r.severity}`)
        .join(', ')}.
Plan file format and a GitHub Actions snippet: see the README ("Lint a plan in CI").`,
    )
    .action((...a) =>
      run<LintOpts>('lint', a, async (ctx, o, args) => {
        const source = args[0] as string
        if (o.failOn !== undefined && o.failOn !== 'error' && o.failOn !== 'warn') {
          throw usageError('--fail-on must be "error" or "warn"')
        }
        const nowSeconds = BigInt(Math.floor(ctx.deps.now() / 1000))
        const maxExpirySeconds =
          o.maxExpiry === undefined ? undefined : parseDurationFlag(o.maxExpiry, '--max-expiry')

        let plan: LintPlan | null = null
        let problems: Finding[] = []
        let text: string | undefined
        try {
          text = source === '-' ? await ctx.deps.readStdin() : await ctx.deps.readFile(source)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw usageError(`cannot read ${source}`)
        }
        if (text === undefined) {
          plan = planFromPreset(source)
          if (plan === null)
            throw usageError(
              `"${source}" is neither a readable plan file nor a registry preset`,
              'See `agentauth registry presets`.',
            )
        } else {
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch (error) {
            throw usageError(
              `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          const read = readPlan(parsed)
          plan = read.plan
          problems = read.problems
        }
        const findings = [
          ...problems,
          ...(plan === null ? [] : lintPlan(plan, { nowSeconds, maxExpirySeconds })),
        ].sort(
          (x, y) =>
            ['error', 'warn', 'info'].indexOf(x.severity) -
              ['error', 'warn', 'info'].indexOf(y.severity) ||
            x.rule.localeCompare(y.rule) ||
            x.path.localeCompare(y.path),
        )
        const summary = summarize(findings)
        const out = ctx.out
        out.say(out.bold(source === '-' ? '<stdin>' : source))
        for (const f of findings) {
          const tag =
            f.severity === 'error'
              ? out.bad('error')
              : f.severity === 'warn'
                ? out.warn('warn ')
                : out.dim('info ')
          out.say(`  ${tag}  ${f.rule}  ${f.path}  ${f.message}`)
          if (f.hint) out.say(`${' '.repeat(18)}${out.dim(f.hint)}`)
        }
        if (findings.length === 0) out.say(`  ${out.ok('no findings')}`)
        out.say()
        out.say(`${summary.error} error(s), ${summary.warn} warning(s), ${summary.info} info`)
        if (plan?.isPreset === true) {
          out.say(
            out.dim(
              'A preset has no expiry, owner, recipients, delegation or swap floor: lint your real plan too.',
            ),
          )
        }
        const data = {
          source: source === '-' ? '<stdin>' : source,
          findings,
          summary,
          rules: RULES,
        }
        const failed = summary.error > 0 || (o.failOn === 'warn' && summary.warn > 0)
        if (failed) {
          throw new CliError(
            'usage',
            `lint failed: ${summary.error} error(s), ${summary.warn} warning(s)`,
            { data, exitCode: 1 },
          )
        }
        out.emit('lint', undefined, data)
      }),
    )
}
