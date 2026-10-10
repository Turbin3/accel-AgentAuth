import type { Command } from 'commander'
import { registry } from '../registry'
import { usageError } from '../errors'
import type { Runner } from '../runner'
import { resolveProgram, registryCluster } from '../registry'

export function registerRegistry(program: Command, run: Runner): void {
  const reg = program
    .command('registry')
    .description(
      'browse the verified catalog of Solana programs, instructions, risk classes and presets',
    )

  reg
    .command('list')
    .description('list known programs')
    .action((...a) =>
      run('registry list', a, async (ctx) => {
        const rows = registry.programs.map((p) => ({
          slug: p.slug,
          name: p.name,
          kind: p.kind,
          instructions: p.instructions.length,
          defaultDeny: p.instructions.filter((i) => i.defaultDeny).length,
          programId: p.programIds[registryCluster(ctx.cluster)] ?? null,
        }))
        ctx.out.table(
          ['SLUG', 'PROGRAM', 'INSTRUCTIONS', 'DEFAULT-DENY', 'PROGRAM ID'],
          rows.map((r) => [
            r.slug,
            r.name,
            String(r.instructions),
            String(r.defaultDeny),
            r.programId ?? '-',
          ]),
        )
        ctx.out.say()
        ctx.out.say(
          ctx.out.dim(
            'Details: agentauth registry show <slug>. Risk and amount calls are conservative judgements from cited sources, not guarantees.',
          ),
        )
        ctx.out.emit('registry list', ctx.cluster, { programs: rows })
      }),
    )

  reg
    .command('show')
    .argument('<program>', 'registry slug or program id')
    .description('show every instruction of a program with disc8 and risk class')
    .action((...a) =>
      run('registry show', a, async (ctx, _o, args) => {
        const p = resolveProgram(args[0] as string, ctx.client, ctx.cluster)
        if (!p.entry) {
          throw usageError(
            `${p.name} is not in the registry`,
            'Only registry programs list instructions; use `registry list`.',
          )
        }
        const e = p.entry
        ctx.out.say(
          `${ctx.out.bold(e.name)}  ${ctx.out.dim(`(${e.slug}, ${e.kind}, ${e.discriminatorScheme})`)}`,
        )
        ctx.out.say(`program id: ${p.id}`)
        ctx.out.say()
        const colour = (risk: string, deny: boolean): string =>
          deny
            ? ctx.out.bad(risk)
            : risk === 'value_out' || risk === 'value_swap'
              ? ctx.out.warn(risk)
              : risk
        ctx.out.table(
          ['INSTRUCTION', 'DISC8', 'RISK', 'DENY', 'AMOUNT'],
          e.instructions.map((i) => [
            i.name,
            i.disc8,
            colour(i.risk, i.defaultDeny),
            i.defaultDeny ? 'default-deny' : '',
            i.amount ? `${i.amount.type}@${i.amount.offset}` : '-',
          ]),
        )
        ctx.out.emit('registry show', ctx.cluster, { programId: p.id, program: e })
      }),
    )

  reg
    .command('decode')
    .argument('<program>', 'registry slug or program id')
    .argument(
      '<hex...>',
      'instruction data as hex (several arguments are joined, 0x prefixes and spaces ignored)',
    )
    .description('decode raw instruction data into name, canonical disc8, risk and amount')
    .action((...a) =>
      run('registry decode', a, async (ctx, _o, args) => {
        const p = resolveProgram(args[0] as string, ctx.client, ctx.cluster)
        let result: ReturnType<typeof registry.decodeInstruction>
        try {
          result = registry.decodeInstruction(
            p.id,
            args
              .slice(1)
              .flat()
              .map((h) => String(h).replace(/^0x/i, ''))
              .join(''),
          )
        } catch (error) {
          throw usageError(
            `cannot decode: ${error instanceof Error ? error.message : String(error)}`,
            'Give the instruction data as an even number of hex digits.',
          )
        }
        const amount = registry.parseAmount(
          p.id,
          args
            .slice(1)
            .flat()
            .map((h) => String(h).replace(/^0x/i, ''))
            .join(''),
        )
        ctx.out.keyValues(
          [
            ['program', `${p.name} (${p.id})`],
            [
              'known',
              result.known
                ? 'yes'
                : 'no (not in the registry; a fail-closed integrator must deny it)',
            ],
            ['instruction', result.instruction?.name ?? '-'],
            ['disc8', result.disc8 ?? '-'],
            ['risk', result.risk],
            ['default-deny', result.defaultDeny ? ctx.out.bad('yes') : 'no'],
            ['amount (raw)', amount === null ? '-' : amount.toString()],
          ],
          0,
        )
        ctx.out.emit('registry decode', ctx.cluster, {
          programId: p.id,
          known: result.known,
          instruction: result.instruction?.name ?? null,
          disc8: result.disc8,
          risk: result.risk,
          defaultDeny: result.defaultDeny,
          amountRaw: amount,
        })
      }),
    )

  reg
    .command('presets')
    .description('list mandate presets')
    .action((...a) =>
      run('registry presets', a, async (ctx) => {
        const list = registry.presets()
        ctx.out.table(
          ['PRESET', 'TITLE', 'PROGRAMS', 'DESCRIPTION'],
          list.map((p) => [
            p.name,
            p.title,
            p.permissions.map((x) => x.slug).join(', '),
            p.description,
          ]),
        )
        ctx.out.say()
        ctx.out.say(
          ctx.out.dim(
            'Details: agentauth registry preset <name>.  Lint one: agentauth lint <name>.',
          ),
        )
        ctx.out.emit('registry presets', ctx.cluster, {
          presets: list.map((p) => ({
            name: p.name,
            title: p.title,
            description: p.description,
            programs: p.permissions.map((x) => x.slug),
          })),
        })
      }),
    )

  reg
    .command('preset')
    .argument('<name>', 'preset name')
    .description('show one preset: what it allows, what it blocks and its honest limits')
    .action((...a) =>
      run('registry preset', a, async (ctx, _o, args) => {
        const p = registry.preset(args[0] as string)
        if (!p) {
          throw usageError(
            `unknown preset "${args[0]}"`,
            `Known: ${registry
              .presets()
              .map((x) => x.name)
              .join(', ')}`,
          )
        }
        const out = ctx.out
        out.say(`${out.bold(p.title)}  ${out.dim(`(${p.name})`)}`)
        out.say(p.description)
        if (p.audience) out.say(out.dim(`For: ${p.audience}`))
        out.say()
        out.section(
          'Allows',
          p.permissions.flatMap((x) =>
            x.instructions.map((i) => `${x.slug}.${i.name}  ${out.dim(`${i.disc8}, ${i.risk}`)}`),
          ),
        )
        if (p.risk_summary) {
          out.say()
          out.section('Risk', [p.risk_summary])
        }
        if (p.explicitly_blocked && p.explicitly_blocked.length > 0) {
          out.say()
          out.say(out.bold(`Not allowed (${p.explicitly_blocked.length}, for example)`))
          for (const b of p.explicitly_blocked.slice(0, 4))
            out.say(`  ${b.program}.${b.instruction}  ${out.dim(b.why)}`)
        }
        if (p.honest_limits && p.honest_limits.length > 0) {
          out.say()
          out.section('Honest limits', p.honest_limits)
        }
        out.say()
        out.say(
          `Use it: agentauth mandate create --preset ${p.name} --per-call <amount> --budget <amount> ...`,
        )
        out.emit('registry preset', ctx.cluster, { preset: p })
      }),
    )
}
