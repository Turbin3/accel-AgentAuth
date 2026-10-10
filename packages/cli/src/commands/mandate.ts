import type { Command } from 'commander'
import type { Address } from '@solana/kit'
import {
  MAX_TRANSACTION_SIZE,
  POLICY_FLAG_STRICT_TOP_LEVEL,
  POLICY_VERSION,
  SWAP_BASE_INPUT_DISC,
  TRANSFER_CHECKED_DISC,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodeTokenAccount,
  explainMandate,
  explanationToJson,
  fetchRawAccount,
  mandatePda,
  parseAddress,
  parseDisc,
  parseUnits,
  planToJson,
  relayAuthorityPda,
  relayPolicyPda,
  stripSigners,
  toHex,
  type Mandate,
  type OnboardingInput,
  type Permission,
  type PermissionInput,
  type PauseScope,
  type Plan,
  type RelayPolicy,
  type SwapConfig,
} from '@agentauth-sol/sdk'
import { CliError, usageError } from '../errors'
import type { Ctx } from '../env'
import { UNAUDITED } from '../env'
import { registry, registryCluster } from '../registry'
import {
  describeSteps,
  mintMeta,
  resolveTarget,
  runPlan,
  stepJson,
  type MintMeta,
} from '../resolve'
import type { Runner } from '../runner'
import { parseExpiryFlag, parseHumanAmount, parseLimitFlag, shortAddress } from '../units'
import {
  loadView,
  printCapacity,
  printExplanation,
  printPermissions,
  printRelay,
  statusLine,
} from '../view'

const collect = (value: string, previous: string[]): string[] => [...previous, value]

interface TargetOpts {
  agent?: string
  owner?: string
}

interface CreateOpts extends TargetOpts {
  expiry?: string
  preset?: string
  mint?: string
  source?: string
  recipient: string[]
  perCall?: string
  budget?: string
  delegate?: string
  swapPool?: string
  swapFloor?: string
  swapMaxDeadlineSlots?: string
  swapPerCall?: string
  swapBudget?: string
  swapDelegate?: string
  allowUnlimited?: boolean
  allowOverride?: boolean
  allowCpi?: boolean
  fundAgent?: string
  dryRun?: boolean
}

/** A mint given as an address, an `@alias`, or a known symbol. */
function resolveMint(ctx: Ctx, input: string | undefined, field: string): Address {
  if (input === undefined) {
    const demoDefault = ctx.demoMode ? ctx.demo?.state.mints['dusd']?.address : undefined
    if (demoDefault === undefined) {
      throw usageError(
        `${field} is required`,
        'Give a mint address or a known symbol (for example USDC on devnet).',
      )
    }
    return ctx.address(demoDefault, field)
  }
  if (input.startsWith('@') || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input))
    return ctx.address(input, field)
  const known = ctx.symbols.resolve(input)
  if (known === undefined) {
    throw usageError(
      `${field}: unknown token symbol "${input}" on ${ctx.cluster}`,
      `Pass the mint address. Known symbols here: ${
        ctx.symbols
          .all()
          .map((m) => m.symbol)
          .join(', ') || 'none'
      }.`,
    )
  }
  return ctx.address(known.address, field)
}

async function checkTokenAccount(
  ctx: Ctx,
  address: Address,
  field: string,
  expect: { mint: Address; owner?: Address },
): Promise<string | null> {
  const raw = await fetchRawAccount(ctx.client.rpc, address)
  if (raw === null) return `${field} ${address} does not exist yet`
  if (raw.data.length < 165) {
    throw usageError(
      `${field} ${address} is not a token account`,
      'The relay works on token ACCOUNTS, not wallets. Give the token account address (an associated token account).',
    )
  }
  const view = decodeTokenAccount(raw.data)
  if (view.mint !== expect.mint) {
    throw usageError(`${field} ${address} holds mint ${view.mint}, not ${expect.mint}`)
  }
  if (expect.owner !== undefined && view.owner !== expect.owner) {
    throw usageError(
      `${field} ${address} is owned by ${view.owner}, not by the signing owner ${expect.owner}`,
    )
  }
  return null
}

async function loadSwapConfig(ctx: Ctx, o: CreateOpts): Promise<SwapConfig> {
  const spec = o.swapPool as string
  let fields: Record<string, unknown>
  if (spec === 'demo') {
    if (!ctx.demoMode || !ctx.demo) {
      throw usageError(
        '--swap-pool demo needs the localnet demo environment',
        'Run `pnpm --filter @agentauth-sol/demo bootstrap` first.',
      )
    }
    const s = ctx.demo.state
    fields = {
      ammProgram: ctx.client.programIds.mockAmm,
      ammAuthority: s.pool['authority'],
      ammConfig: s.pool['config'],
      poolState: s.pool['state'],
      inputVault: s.pool['vaultDusd'],
      outputVault: s.pool['vaultDout'],
      observationState: s.pool['observation'],
      inMint: s.mints['dusd']?.address,
      outMint: s.mints['dout']?.address,
      inTokenProgram: TOKEN_PROGRAM_ID,
      outTokenProgram: TOKEN_PROGRAM_ID,
      inAccount: s.tokenAccounts['ownerDusd'],
      outAccount: s.tokenAccounts['ownerDout'],
    }
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(await ctx.deps.readFile(spec))
    } catch (error) {
      throw usageError(
        `--swap-pool: cannot read ${spec} as JSON (${error instanceof Error ? error.message : String(error)})`,
        'Use `demo` on localnet, or a JSON file with the pinned pool accounts (see the README).',
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw usageError('--swap-pool: the file must contain a JSON object')
    }
    fields = parsed as Record<string, unknown>
  }
  const addr = (key: string): Address => {
    const v = fields[key]
    if (typeof v !== 'string') throw usageError(`--swap-pool: "${key}" is missing`)
    return ctx.address(v, `--swap-pool ${key}`)
  }
  const floor = (
    o.swapFloor ??
    (fields['floorOut'] !== undefined
      ? `${String(fields['floorOut'])}/${String(fields['floorIn'])}`
      : '95/100')
  ).split('/')
  const floorOut = floor[0]
  const floorIn = floor[1]
  if (
    floor.length !== 2 ||
    floorOut === undefined ||
    floorIn === undefined ||
    !/^[0-9]+$/.test(floorOut) ||
    !/^[0-9]+$/.test(floorIn)
  ) {
    throw usageError('--swap-floor must look like 95/100 (raw units out per raw units in)')
  }
  const slots = Number(o.swapMaxDeadlineSlots ?? fields['maxDeadlineSlots'] ?? 150)
  if (!Number.isInteger(slots) || slots < 1)
    throw usageError('--swap-max-deadline-slots must be a positive integer')
  return {
    ammProgram: addr('ammProgram'),
    ammAuthority: addr('ammAuthority'),
    ammConfig: addr('ammConfig'),
    poolState: addr('poolState'),
    inputVault: addr('inputVault'),
    outputVault: addr('outputVault'),
    observationState: addr('observationState'),
    inMint: addr('inMint'),
    outMint: addr('outMint'),
    inTokenProgram: addr('inTokenProgram'),
    outTokenProgram: addr('outTokenProgram'),
    inAccount: addr('inAccount'),
    outAccount: addr('outAccount'),
    floorOut: BigInt(floorOut),
    floorIn: BigInt(floorIn),
    maxDeadlineSlots: slots,
  }
}

/** The mandate and policy that the plan WOULD create, so the same explainer can preview them. */
async function syntheticView(
  ctx: Ctx,
  input: OnboardingInput,
  mint: MintMeta,
  owner: Address,
  allowCpi: boolean,
  swap: SwapConfig | null,
  perms: readonly PermissionInput[],
  now: bigint,
) {
  const mandateAddress = (await mandatePda(owner, input.agent, ctx.client.programIds.agentAuth))
    .address
  const authority = (await relayAuthorityPda(mandateAddress, ctx.client.programIds.relay)).address
  const policyAddress = (await relayPolicyPda(mandateAddress, ctx.client.programIds.relay)).address
  const permissions: Permission[] = perms.map((p, index) => {
    const discs = p.discriminators.map((d) => parseDisc(d))
    const spendUnlimited = p.spendLimit === 'unlimited'
    const perTxUnlimited = p.perTxLimit === 'unlimited'
    return {
      index,
      program: p.program,
      spendLimit: spendUnlimited ? 0n : (p.spendLimit as bigint),
      perTxLimit: perTxUnlimited ? 0n : (p.perTxLimit as bigint),
      spendUnlimited,
      perTxUnlimited,
      spendTotal: 0n,
      callCount: 0,
      discriminators: discs,
      discriminatorsHex: discs.map((d) => toHex(d)),
    }
  })
  const mandate: Mandate = {
    address: mandateAddress,
    owner,
    agent: input.agent,
    expiry: input.expiry,
    active: true,
    version: 1,
    bump: 0,
    permissions,
  }
  const policy: RelayPolicy = {
    address: policyAddress,
    version: POLICY_VERSION,
    policyBump: 0,
    authorityBump: 0,
    flags: allowCpi ? 0 : POLICY_FLAG_STRICT_TOP_LEVEL,
    paused: false,
    strictTopLevel: !allowCpi,
    mandate: mandateAddress,
    owner,
    agent: input.agent,
    authority,
    mandateExpiry: input.expiry,
    tokenProgram: input.token.tokenProgram ?? TOKEN_PROGRAM_ID,
    budgetMint: mint.address,
    sourceAccount: input.token.source,
    recipients: input.recipients,
    swap,
  }
  const explanation = explainMandate(mandate, {
    policy,
    registry: ctx.client.registry,
    now,
    budgetDecimals: mint.decimals,
    delegation: { delegate: authority, delegatedAmount: input.token.delegateCap },
    mandateAddress,
  })
  return { mandateAddress, policyAddress, authority, explanation }
}

async function createMandate(ctx: Ctx, o: CreateOpts): Promise<void> {
  const { out, client } = ctx
  const owner = await ctx.ownerSigner()
  const agent = await ctx.agentAddress(o.agent)
  if (agent === undefined) {
    throw usageError(
      'which agent? pass --agent <address> (or --agent-keypair <path>)',
      'The agent is the key your AI agent signs with. It must differ from your owner key.',
    )
  }
  const now = await ctx.nowSeconds()
  const expiry = parseExpiryFlag(o.expiry ?? '7d', now)
  const mint = await mintMeta(ctx, resolveMint(ctx, o.mint, '--mint'))
  const amountCtx = (field: string) => ({
    decimals: mint.decimals,
    symbol: mint.symbol,
    raw: ctx.opts.raw === true,
    field,
  })
  const preset = o.preset === undefined ? null : registry.preset(o.preset)
  if (o.preset !== undefined && preset === null) {
    throw usageError(
      `unknown preset "${o.preset}"`,
      `Known: ${registry
        .presets()
        .map((p) => p.name)
        .join(', ')}`,
    )
  }

  const swap = o.swapPool === undefined ? null : await loadSwapConfig(ctx, o)
  const wantsSwapFromPreset = preset?.permissions.some((p) => p.slug === 'raydium-cpmm') === true
  if (wantsSwapFromPreset && swap === null) {
    throw usageError(
      `preset ${preset?.name} swaps through a pool: pass --swap-pool <demo|file.json>`,
    )
  }

  // Token / preset permissions
  const permissions: PermissionInput[] = []
  const perCall =
    o.perCall === undefined ? undefined : parseLimitFlag(o.perCall, amountCtx('--per-call'))
  const budget =
    o.budget === undefined ? undefined : parseLimitFlag(o.budget, amountCtx('--budget'))
  let autoUnlimited = false
  const needLimits = (what: string): [bigint | 'unlimited', bigint | 'unlimited'] => {
    if (perCall === undefined || budget === undefined) {
      throw usageError(
        `${what} needs both --per-call and --budget`,
        'Example: --per-call "25 DUSD" --budget "100 DUSD" (a limit is never guessed).',
      )
    }
    return [perCall, budget]
  }
  if (preset !== null) {
    for (const p of preset.permissions) {
      if (p.slug === 'raydium-cpmm') continue
      const program = p.programIds[registryCluster(ctx.cluster)] ?? p.programIds.devnet
      if (program === undefined)
        throw usageError(`preset ${preset.name}: ${p.slug} has no program id on ${ctx.cluster}`)
      const valueMoving = p.instructions.some((i) => i.amount !== null)
      const [pc, bg] = valueMoving
        ? needLimits(`preset ${preset.name} (${p.slug})`)
        : (['unlimited', 'unlimited'] as const)
      if (!valueMoving) autoUnlimited = true
      permissions.push({
        program: parseAddress(program),
        spendLimit: bg,
        perTxLimit: pc,
        discriminators: p.instructions.map((i) => i.disc8),
      })
    }
  } else if (o.recipient.length > 0) {
    const [pc, bg] = needLimits('a payments mandate')
    permissions.push({
      program: TOKEN_PROGRAM_ID,
      spendLimit: bg,
      perTxLimit: pc,
      discriminators: [TRANSFER_CHECKED_DISC],
    })
  }

  // Swap permission
  let swapDelegate: bigint | undefined
  if (swap !== null) {
    const swapMint = swap.inMint === mint.address ? mint : await mintMeta(ctx, swap.inMint)
    const sctx = (field: string) => ({
      decimals: swapMint.decimals,
      symbol: swapMint.symbol,
      raw: ctx.opts.raw === true,
      field,
    })
    const spc = o.swapPerCall ?? o.perCall
    const sbg = o.swapBudget ?? o.budget
    if (spc === undefined || sbg === undefined) {
      throw usageError(
        'a swap needs --per-call and --budget (or --swap-per-call and --swap-budget)',
      )
    }
    const swapBudgetValue = parseLimitFlag(sbg, sctx('--swap-budget'))
    permissions.push({
      program: swap.ammProgram,
      spendLimit: swapBudgetValue,
      perTxLimit: parseLimitFlag(spc, sctx('--swap-per-call')),
      discriminators: [SWAP_BASE_INPUT_DISC],
    })
    if (o.swapDelegate !== undefined)
      swapDelegate = parseHumanAmount(o.swapDelegate, sctx('--swap-delegate'))
    else if (swapBudgetValue !== 'unlimited') swapDelegate = swapBudgetValue
  }
  if (permissions.length === 0) {
    throw usageError(
      'nothing to allow',
      'Give --recipient (payments), --swap-pool (swaps) or --preset <name>. See `agentauth registry presets`.',
    )
  }

  // Source account
  const demoSource =
    ctx.demoMode && mint.address === ctx.demo?.state.mints['dusd']?.address
      ? ctx.demo.state.tokenAccounts['ownerDusd']
      : undefined
  const source =
    o.source !== undefined
      ? ctx.address(o.source, '--source')
      : demoSource !== undefined
        ? ctx.address(demoSource, '--source')
        : (await associatedTokenAddress(owner.address, mint.address)).address
  const sourceProblem = await checkTokenAccount(ctx, source, '--source', {
    mint: mint.address,
    owner: owner.address,
  })
  if (sourceProblem !== null) {
    throw usageError(
      sourceProblem,
      `Create the owner's token account for this mint first, or pass --source <token account>.`,
    )
  }
  const recipients = o.recipient.map((r) => ctx.address(r, '--recipient'))
  const missing: string[] = []
  for (const r of recipients) {
    const problem = await checkTokenAccount(ctx, r, '--recipient', { mint: mint.address })
    if (problem !== null) missing.push(problem)
  }

  // Delegation cap
  const tokenBudget =
    permissions[0]?.program === TOKEN_PROGRAM_ID ? permissions[0].spendLimit : undefined
  let delegateCap: bigint
  if (o.delegate !== undefined) delegateCap = parseHumanAmount(o.delegate, amountCtx('--delegate'))
  else if (typeof tokenBudget === 'bigint') delegateCap = tokenBudget
  else if (swapDelegate !== undefined) delegateCap = swapDelegate
  else if (typeof budget === 'bigint') delegateCap = budget
  else
    throw usageError(
      '--delegate is required when the budget is unlimited',
      'The SPL delegation is the independent hard cap: give it a finite amount.',
    )

  const fundText = o.fundAgent ?? '0.005'
  let fund: bigint
  try {
    fund = parseUnits(fundText, 9)
  } catch {
    throw usageError(`--fund-agent: cannot read "${fundText}" as SOL`)
  }

  const input: OnboardingInput = {
    owner,
    agent,
    expiry,
    now,
    ...(fund > 0n ? { fundAgentLamports: fund } : {}),
    token: { mint: mint.address, source, delegateCap },
    permissions,
    recipients,
    ...(swap === null
      ? {}
      : {
          swap: {
            ...swap,
            ...(swap.inAccount !== source && swapDelegate !== undefined
              ? { delegateCap: swapDelegate }
              : {}),
          },
        }),
    ...(o.allowUnlimited === true || autoUnlimited ? { allowUnlimited: true } : {}),
    ...(o.allowOverride === true ? { allowOverride: true } : {}),
    ...(o.allowCpi === true ? { allowCpi: true } : {}),
  }
  const plan = await client.plan.onboarding(input)
  const { mandateAddress, explanation } = await syntheticView(
    ctx,
    input,
    mint,
    owner.address,
    o.allowCpi === true,
    swap,
    permissions,
    now,
  )

  // Preview: warnings first
  const extra = [
    ...plan.warnings,
    ...missing.map((m) => `${m} (transfers to it fail until it exists)`),
  ]
  if (recipients.length === 0 && permissions.some((p) => p.program === TOKEN_PROGRAM_ID)) {
    extra.push(
      'no --recipient: every relay transfer will be refused (RecipientNotAllowed) because the allowlist is empty',
    )
  }
  if (autoUnlimited)
    extra.push(
      'limits on instructions that move no value are set to unlimited (--allow-unlimited applied for those only)',
    )
  out.say(out.bold(`Preview: mandate ${shortAddress(mandateAddress, 6)} on ${ctx.cluster}`))
  out.say(out.dim(`owner ${owner.address}  agent ${agent}`))
  out.say()
  printExplanation(out, explanation, extra)
  out.say()
  out.say(
    out.bold(
      `Transactions (${plan.steps.length}, signed by the owner ${shortAddress(owner.address)})`,
    ),
  )
  for (const line of describeSteps(plan)) out.say(`  ${line}`)
  out.say(`  ${out.dim(`${plan.summary}; each must stay under ${MAX_TRANSACTION_SIZE} bytes`)}`)
  out.say()
  out.say(out.dim(UNAUDITED))

  const preview = {
    explanation: explanationToJson(explanation),
    plan: planToJson(stripSigners(plan)),
    warnings: extra,
  }
  if (o.dryRun === true) {
    out.say()
    out.say('Dry run: nothing was sent.')
    out.emit('mandate create', ctx.cluster, { dryRun: true, mandate: mandateAddress, preview })
    return
  }
  out.say()
  if (
    ctx.opts.simulate !== true &&
    !(await ctx.confirm(`Send ${plan.steps.length} transaction(s) now?`))
  ) {
    throw new CliError('usage', 'cancelled: nothing was sent', { exitCode: 1 })
  }
  const result = await runPlan(ctx, plan, [owner])
  out.say()
  if (!result.simulated) {
    out.say(`${out.ok('Mandate created.')} ${mandateAddress}`)
    out.say('Next:')
    out.say(`  agentauth mandate show ${agent}`)
    out.say(`  agentauth relay pay --to <recipient token account> --amount "1"`)
  }
  out.emit('mandate create', ctx.cluster, {
    mandate: mandateAddress,
    simulated: result.simulated,
    steps: result.steps.map(stepJson),
    preview,
  })
}

export function registerMandate(program: Command, run: Runner): void {
  const mandate = program
    .command('mandate')
    .description('create, inspect and control mandates (owner side)')

  mandate
    .command('create')
    .description('create a mandate and its relay policy: preview with warnings, confirm, then send')
    .option('--agent <address>', 'the agent key (default: --agent-keypair, or the demo agent)')
    .option('--expiry <when>', 'duration (7d, 12h), ISO timestamp or unix seconds', '7d')
    .option('--preset <name>', 'start from a registry preset (agentauth registry presets)')
    .option('--mint <symbol|address>', 'budget mint (default on the demo: DUSD)')
    .option(
      '--source <account>',
      "owner's token account to spend from (default: the associated token account)",
    )
    .option(
      '--recipient <account>',
      'allowlisted recipient TOKEN ACCOUNT (repeatable)',
      collect,
      [],
    )
    .option('--per-call <amount>', 'cap per call, human units ("25" or "25 DUSD")')
    .option('--budget <amount>', 'lifetime budget, human units')
    .option('--delegate <amount>', 'SPL delegation to the relay (default: the budget)')
    .option(
      '--swap-pool <demo|file>',
      'pin one swap pool (demo on localnet, or a JSON file of pool accounts)',
    )
    .option('--swap-floor <out/in>', 'price floor in raw units, default 95/100')
    .option('--swap-max-deadline-slots <n>', 'longest swap deadline in slots, default 150')
    .option('--swap-per-call <amount>', 'per-call cap of the swap permission (default --per-call)')
    .option('--swap-budget <amount>', 'lifetime budget of the swap permission (default --budget)')
    .option(
      '--swap-delegate <amount>',
      'delegation for the swap input account when it differs from --source',
    )
    .option('--allow-unlimited', 'accept "unlimited" limits (0 on chain means unlimited)')
    .option('--allow-override', 'accept a delegation larger than the smallest budget')
    .option('--allow-cpi', 'let relay calls run inside CPIs (default: top-level only)')
    .option('--fund-agent <sol>', 'SOL to send the agent for fees (0 skips)', '0.005')
    .option('--dry-run', 'print the preview and exit; send nothing')
    .action((...a) => run<CreateOpts>('mandate create', a, (ctx, o) => createMandate(ctx, o)))

  for (const name of ['show', 'explain'] as const) {
    mandate
      .command(name)
      .argument('[agent-or-mandate]', 'an agent address, or a mandate address')
      .option('--owner <address>', "the mandate's owner when you give an agent address")
      .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
      .description(
        name === 'show'
          ? 'show a mandate: status, limits spent, relay policy and live capacity'
          : 'explain a mandate in plain English: what the agent can do, cannot do, and what is hard-enforced',
      )
      .action((...a) =>
        run<TargetOpts>(`mandate ${name}`, a, async (ctx, o, args) => {
          const target = await resolveTarget(ctx, args[0], o)
          const loaded = await loadView(ctx, target)
          const { view } = loaded
          const mandateData = target.mandate as Mandate
          const out = ctx.out
          if (name === 'explain' && view.explanation) {
            printExplanation(out, view.explanation)
            out.say()
            printCapacity(ctx, view.capacity, loaded.budget)
            out.say()
            out.say(out.dim(UNAUDITED))
          } else {
            const now = await ctx.nowSeconds()
            out.say(
              `${out.bold('Mandate')} ${target.mandateAddress}   ${statusLine(ctx, mandateData, now)}`,
            )
            out.keyValues(
              [
                ['owner', target.owner],
                ['agent', target.agent],
                ['expiry', `${new Date(Number(mandateData.expiry) * 1000).toISOString()}`],
              ],
              0,
            )
            out.say()
            out.say(out.bold('Permissions'))
            printPermissions(ctx, mandateData, loaded)
            out.say()
            if (target.policy === null) {
              out.say(
                `${out.bold('Relay')} ${out.warn('no relay policy: nothing is hard-enforced; permissions are advisory')}`,
              )
            } else {
              out.say(
                out.bold('Relay (hard enforcement for the relay transfer and the pinned swap)'),
              )
              printRelay(ctx, target.policy, loaded)
            }
            out.say()
            printCapacity(ctx, view.capacity, loaded.budget)
            if (view.explanation && view.explanation.warnings.length > 0) {
              out.say()
              for (const w of view.explanation.warnings) out.say(`${out.warn('!')} ${w}`)
            }
            out.say()
            out.say(out.dim(`Plain English: agentauth mandate explain ${target.agent}`))
          }
          out.emit(`mandate ${name}`, ctx.cluster, {
            mandate: target.mandateAddress,
            owner: target.owner,
            agent: target.agent,
            data: mandateData,
            policy: target.policy,
            explanation: view.explanation === null ? null : explanationToJson(view.explanation),
            delegation: view.delegation,
            balance: view.balance,
            capacity: view.capacity,
          })
        }),
      )
  }

  mandate
    .command('list')
    .option('--owner <address>', 'list the mandates of this owner (default: your owner keypair)')
    .description('list the mandates an owner has created')
    .action((...a) =>
      run<TargetOpts>('mandate list', a, async (ctx, o) => {
        const owner = await ctx.ownerAddress(o.owner)
        if (owner === undefined) throw usageError('whose mandates? pass --owner <address>')
        const list = await ctx.client.mandatesByOwner(owner)
        const now = await ctx.nowSeconds()
        const rows = await Promise.all(
          list.map(async (m) => ({
            mandate:
              m.address ??
              (await mandatePda(m.owner, m.agent, ctx.client.programIds.agentAuth)).address,
            m,
          })),
        )
        if (rows.length === 0) ctx.out.say(`No mandates for ${owner} on ${ctx.cluster}.`)
        else {
          ctx.out.table(
            ['MANDATE', 'AGENT', 'STATUS', 'PERMISSIONS'],
            rows.map((r) => [
              r.mandate,
              r.m.agent,
              statusLine(ctx, r.m, now),
              String(r.m.permissions.length),
            ]),
          )
        }
        ctx.out.emit('mandate list', ctx.cluster, {
          owner,
          mandates: rows.map((r) => ({ mandate: r.mandate, ...r.m })),
        })
      }),
    )

  for (const verb of ['pause', 'resume'] as const) {
    mandate
      .command(verb)
      .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
      .option('--scope <scope>', 'relay (set_paused), mandate (set_active) or both', 'both')
      .description(
        verb === 'pause'
          ? 'reversible kill switch: pause the relay and/or deactivate the mandate'
          : 'undo a pause',
      )
      .action((...a) =>
        run<TargetOpts & { scope: string }>(`mandate ${verb}`, a, async (ctx, o) => {
          if (o.scope !== 'relay' && o.scope !== 'mandate' && o.scope !== 'both') {
            throw usageError('--scope must be relay, mandate or both')
          }
          const owner = await ctx.ownerSigner()
          const agent = await ctx.agentAddress(o.agent)
          if (agent === undefined) throw usageError('which agent? pass --agent <address>')
          const scope: PauseScope = o.scope
          const plan = await (verb === 'pause' ? ctx.client.plan.pause : ctx.client.plan.resume)({
            owner,
            agent,
            scope,
          })
          await finishOwnerPlan(
            ctx,
            `mandate ${verb}`,
            plan,
            owner,
            verb === 'resume' ? 'This lets the agent act again.' : undefined,
          )
        }),
      )
  }

  mandate
    .command('revoke')
    .option('--agent <address>', 'the agent (default: --agent-keypair or the demo agent)')
    .description(
      'unwind everything in ONE transaction: revoke the SPL delegation, revoke_mandate, close_policy',
    )
    .action((...a) =>
      run<TargetOpts>('mandate revoke', a, async (ctx, o) => {
        const owner = await ctx.ownerSigner()
        const agent = await ctx.agentAddress(o.agent)
        if (agent === undefined) throw usageError('which agent? pass --agent <address>')
        const plan = await ctx.client.plan.unwind({ owner, agent })
        const note = 'Revoking does not undo transfers that already happened.'
        await finishOwnerPlan(ctx, 'mandate revoke', plan, owner, note)
      }),
    )
}

/** Preview an owner plan (size check included), confirm, run it, print the result. */
export async function finishOwnerPlan(
  ctx: Ctx,
  command: string,
  plan: Plan,
  owner: Awaited<ReturnType<Ctx['ownerSigner']>>,
  caution?: string,
): Promise<void> {
  const { out } = ctx
  out.say(out.bold(plan.summary))
  for (const w of plan.warnings) out.say(`  ${out.warn('!')} ${w}`)
  for (const s of plan.steps) {
    out.say(`  ${s.label}: ${s.description}`)
    out.say(
      `    ${out.dim(`${s.estimatedSizeBytes} B of ${MAX_TRANSACTION_SIZE} (worst case with a priority fee ${s.worstCaseSizeBytes} B): ${s.fitsInOneTx ? 'fits in one transaction' : 'DOES NOT fit with a priority fee'}`)}`,
    )
  }
  if (plan.steps.length > 1)
    out.say(
      `  ${out.warn('!')} the plan needs ${plan.steps.length} transactions (see the sizes above)`,
    )
  if (caution !== undefined) out.say(out.dim(caution))
  out.say()
  if (
    ctx.opts.simulate !== true &&
    !(await ctx.confirm(
      `Send ${plan.steps.length} transaction(s) as ${shortAddress(owner.address)}?`,
    ))
  ) {
    throw new CliError('usage', 'cancelled: nothing was sent', { exitCode: 1 })
  }
  const result = await runPlan(ctx, plan, [owner])
  out.say()
  out.say(result.simulated ? 'Simulated only.' : out.ok('Done.'))
  out.emit(command, ctx.cluster, {
    summary: plan.summary,
    simulated: result.simulated,
    plan: planToJson(stripSigners(plan)),
    steps: result.steps.map(stepJson),
  })
}
