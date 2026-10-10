import type { Command } from 'commander'
import type { Address } from '@solana/kit'
import { decodeTokenAccount, fetchRawAccount, formatUnits } from '@agentauth-sol/sdk'
import { CliError, isNetworkError } from '../errors'
import type { Runner } from '../runner'
import { UNAUDITED } from '../env'
import { VERSION } from '../version'

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  name: string
  status: Status
  detail: string
}

export function registerDiagnostics(program: Command, run: Runner): void {
  program
    .command('doctor')
    .description('check the environment: node, RPC, programs, keypairs and balances (read-only)')
    .action((...a) =>
      run('doctor', a, async (ctx) => {
        const { client, out } = ctx
        const checks: Check[] = []
        const add = (name: string, status: Status, detail: string): void => {
          checks.push({ name, status, detail })
        }
        const major = Number(process.versions.node.split('.')[0])
        add(
          'node',
          major >= 22 ? 'ok' : 'fail',
          `v${process.versions.node}${major >= 22 ? '' : ' (22 or newer is required)'}`,
        )
        add(
          'cluster',
          'ok',
          `${ctx.cluster}${ctx.rpcUrl ? ` (${ctx.rpcUrl})` : ''}${ctx.demoMode ? ', demo environment found' : ''}`,
        )

        let reachable = false
        try {
          const slot = await client.rpc.getSlot().send()
          reachable = true
          add('rpc', 'ok', `reachable, slot ${slot}`)
        } catch (error) {
          add(
            'rpc',
            'fail',
            isNetworkError(error)
              ? 'cannot reach the RPC endpoint'
              : `RPC error: ${error instanceof Error ? error.message : String(error)}`,
          )
        }

        if (reachable) {
          const programs: Array<[string, Address, boolean]> = [
            ['agent_auth', client.programIds.agentAuth, true],
            ['agent_auth_relay', client.programIds.relay, true],
            ['mock_amm', client.programIds.mockAmm, ctx.cluster === 'localnet'],
            ['gated_example', client.programIds.gatedExample, ctx.cluster === 'localnet'],
          ]
          for (const [name, id, required] of programs) {
            const raw = await fetchRawAccount(client.rpc, id)
            if (raw?.executable === true) add(`program ${name}`, 'ok', `deployed (${id})`)
            else
              add(
                `program ${name}`,
                required ? 'fail' : 'warn',
                `not deployed on ${ctx.cluster} (${id})`,
              )
          }
          const balance = async (
            label: string,
            who: Address | undefined,
            source: string,
          ): Promise<void> => {
            if (who === undefined) return
            const raw = await fetchRawAccount(client.rpc, who)
            const sol = formatUnits(raw?.lamports ?? 0n, 9)
            add(
              label,
              (raw?.lamports ?? 0n) === 0n ? 'warn' : 'ok',
              `${who} (${source}), ${sol} SOL`,
            )
          }
          const owner = await ctx.ownerAddress().catch(() => undefined)
          const agent = await ctx.agentAddress().catch(() => undefined)
          if (owner === undefined)
            add(
              'owner keypair',
              'warn',
              'none found (read-only commands still work; pass --keypair to sign)',
            )
          else
            await balance(
              'owner',
              owner,
              ctx.opts.keypair ? '--keypair' : ctx.demoMode ? 'demo key' : 'default keypair',
            )
          if (agent === undefined)
            add(
              'agent keypair',
              'warn',
              'none (needed only for `relay pay` / `relay swap`: pass --agent-keypair)',
            )
          else await balance('agent', agent, ctx.opts.agentKeypair ? '--agent-keypair' : 'demo key')
          if (ctx.demoMode && ctx.demo) {
            for (const [key, mint] of Object.entries(ctx.demo.state.mints)) {
              const holder =
                key === 'dusd'
                  ? ctx.demo.state.tokenAccounts['ownerDusd']
                  : ctx.demo.state.tokenAccounts['ownerDout']
              if (holder === undefined) continue
              const raw = await fetchRawAccount(client.rpc, ctx.address(holder))
              const amount =
                raw && raw.data.length >= 165 ? decodeTokenAccount(raw.data).amount : 0n
              add(
                `demo ${mint.symbol}`,
                amount > 0n || key !== 'dusd' ? 'ok' : 'warn',
                `owner holds ${formatUnits(amount, mint.decimals)} ${mint.symbol}`,
              )
            }
          }
        }

        const failed = checks.filter((c) => c.status === 'fail')
        for (const c of checks) {
          const tag =
            c.status === 'ok'
              ? out.ok('ok  ')
              : c.status === 'warn'
                ? out.warn('warn')
                : out.bad('FAIL')
          out.say(`${tag}  ${c.name.padEnd(26)} ${c.detail}`)
        }
        out.say()
        out.say(out.dim(UNAUDITED))
        const next = ctx.demoMode
          ? 'Next: agentauth mandate create --preset payments-usdc --per-call 25 --budget 100 --recipient @recipientDusd'
          : ctx.cluster === 'localnet'
            ? 'Next: scripts/localnet.sh start && pnpm --filter @agentauth-sol/demo bootstrap'
            : 'Next: agentauth registry presets'
        out.say(next)
        if (failed.length > 0) {
          const network = failed.some((c) => c.name === 'rpc')
          throw new CliError(network ? 'network' : 'usage', `${failed.length} check(s) failed`, {
            hint: failed.map((c) => `${c.name}: ${c.detail}`).join('\n'),
            data: { checks },
          })
        }
        out.emit('doctor', ctx.cluster, { checks, ok: true })
      }),
    )

  program
    .command('version')
    .description('print the CLI version')
    .action((...a) =>
      run('version', a, async (ctx) => {
        ctx.out.say(`agentauth ${VERSION}`)
        ctx.out.emit('version', undefined, { version: VERSION })
      }),
    )
}
