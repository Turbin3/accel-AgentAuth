import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  describeInstruction,
  parseExpiry,
  programIds,
} from '@agentauth-sol/sdk'
import type { RegistryLike } from '@agentauth-sol/sdk'
import * as registry from '@agentauth-sol/registry'

/** Static analysis of a mandate plan. Pure: no network, no keys. */

export type Severity = 'error' | 'warn' | 'info'

export interface Finding {
  readonly rule: string
  readonly severity: Severity
  readonly message: string
  /** JSON path into the plan (`permissions[0].spendLimit`). */
  readonly path: string
  readonly hint?: string
}

/** Stable rule catalogue. Ids never change meaning; new rules get new ids. */
export const RULES: Readonly<Record<string, { severity: Severity; title: string }>> = {
  AA001: {
    severity: 'error',
    title: 'unlimited limit (0 / "unlimited") on a value-moving permission or delegation',
  },
  AA002: { severity: 'error', title: 'relay delegation larger than the lifetime budget' },
  AA003: {
    severity: 'error',
    title: 'allowed instruction is authority_change, account_close or admin (default-deny)',
  },
  AA004: { severity: 'error', title: 'expiry beyond --max-expiry' },
  AA005: { severity: 'warn', title: 'value-out permission without a recipient allowlist' },
  AA006: { severity: 'warn', title: 'unit-less spend counter shared by several mints' },
  AA007: { severity: 'error', title: 'swap without a price floor' },
  AA008: { severity: 'error', title: 'plan puts the agent key in the owner role' },
  AA009: { severity: 'warn', title: 'program or instruction not in the registry (risk unknown)' },
  AA010: { severity: 'error', title: 'malformed plan' },
  AA011: { severity: 'info', title: 'permission is advisory (not hard-enforced by the relay)' },
  AA012: { severity: 'warn', title: 'per-call limit larger than the lifetime budget' },
}

/** A limit as written in a plan: the word `unlimited`, `0`, or a positive decimal in token units. */
export type LimitSpec = 'unlimited' | { readonly text: string; readonly scaled: bigint }

export interface LintPermission {
  readonly program: string
  readonly instructions: readonly string[]
  readonly spendLimit: LimitSpec | undefined
  readonly perTxLimit: LimitSpec | undefined
  readonly mints: readonly string[]
}

export interface LintRelay {
  readonly recipients: readonly string[]
  readonly delegate: LimitSpec | undefined
  readonly swap: {
    readonly floorOut: LimitSpec | undefined
    readonly floorIn: LimitSpec | undefined
  } | null
  readonly sourceAccountOwner: string | undefined
}

export interface LintPlan {
  readonly owner: string | undefined
  readonly agent: string | undefined
  /** `undefined` for presets (they have no expiry). */
  readonly expiry: string | number | undefined
  readonly permissions: readonly LintPermission[]
  /** `null` = the plan has no relay; `'unspecified'` = a preset (relay settings are the user's). */
  readonly relay: LintRelay | null | 'unspecified'
  readonly isPreset: boolean
  readonly name: string | undefined
}

export interface LintOptions {
  readonly nowSeconds: bigint
  /** Maximum lifetime in seconds (`--max-expiry`). */
  readonly maxExpirySeconds?: bigint | undefined
}

const SCALE = 18
const DENY_RISKS = new Set(['authority_change', 'account_close', 'admin'])
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/

function scale(text: string): bigint | undefined {
  const clean = text.replaceAll(',', '')
  if (!DECIMAL.test(clean)) return undefined
  const [whole = '0', frac = ''] = clean.split('.')
  if (frac.length > SCALE) return undefined
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, '0'))
}

// ---------------------------------------------------------------------------------------------
// Reading a plan file
// ---------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function malformed(path: string, message: string): Finding {
  return { rule: 'AA010', severity: 'error', message, path }
}

function readLimit(value: unknown, path: string, problems: Finding[]): LimitSpec | undefined {
  if (value === undefined) return undefined
  if (value === 'unlimited' || value === 0 || value === '0') return 'unlimited'
  if (typeof value === 'number' || typeof value === 'string') {
    const text = String(value)
    const scaled = scale(text)
    if (scaled === undefined) {
      problems.push(
        malformed(path, `cannot read "${text}" as an amount (use a decimal string or "unlimited")`),
      )
      return undefined
    }
    return { text, scaled }
  }
  problems.push(malformed(path, 'a limit is a decimal string, a number or "unlimited"'))
  return undefined
}

function readStrings(value: unknown, path: string, problems: Finding[]): string[] {
  if (value === undefined) return []
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  problems.push(malformed(path, 'expected an array of strings'))
  return []
}

/** Read a plan file (already JSON-parsed). Structural problems come back as AA010 findings. */
export function readPlan(raw: unknown): { plan: LintPlan | null; problems: Finding[] } {
  const problems: Finding[] = []
  if (!isRecord(raw)) {
    return { plan: null, problems: [malformed('$', 'the plan must be a JSON object')] }
  }
  const permsRaw = raw['permissions']
  if (!Array.isArray(permsRaw) || permsRaw.length === 0) {
    problems.push(malformed('permissions', 'a plan needs a non-empty "permissions" array'))
  }
  const permissions: LintPermission[] = []
  for (const [i, p] of (Array.isArray(permsRaw) ? permsRaw : []).entries()) {
    const at = `permissions[${i}]`
    if (!isRecord(p) || typeof p['program'] !== 'string') {
      problems.push(
        malformed(at, 'each permission needs a "program" (registry slug or program id)'),
      )
      continue
    }
    const instructions = readStrings(p['instructions'], `${at}.instructions`, problems)
    if (instructions.length === 0) {
      problems.push(
        malformed(`${at}.instructions`, 'list at least one instruction (name or disc8)'),
      )
    }
    permissions.push({
      program: p['program'],
      instructions,
      spendLimit: readLimit(p['spendLimit'], `${at}.spendLimit`, problems),
      perTxLimit: readLimit(p['perTxLimit'], `${at}.perTxLimit`, problems),
      mints: readStrings(p['mints'], `${at}.mints`, problems),
    })
  }
  let relay: LintRelay | null = null
  const relayRaw = raw['relay']
  if (relayRaw !== undefined && relayRaw !== null) {
    if (!isRecord(relayRaw)) problems.push(malformed('relay', '"relay" must be an object or null'))
    else {
      const swapRaw = relayRaw['swap']
      let swap: LintRelay['swap'] = null
      if (swapRaw !== undefined && swapRaw !== null) {
        if (!isRecord(swapRaw))
          problems.push(malformed('relay.swap', '"swap" must be an object or null'))
        else {
          swap = {
            floorOut: readLimit(swapRaw['floorOut'], 'relay.swap.floorOut', problems),
            floorIn: readLimit(swapRaw['floorIn'], 'relay.swap.floorIn', problems),
          }
        }
      }
      relay = {
        recipients: readStrings(relayRaw['recipients'], 'relay.recipients', problems),
        delegate: readLimit(relayRaw['delegate'], 'relay.delegate', problems),
        swap,
        sourceAccountOwner:
          typeof relayRaw['sourceAccountOwner'] === 'string'
            ? relayRaw['sourceAccountOwner']
            : undefined,
      }
    }
  }
  const expiry = raw['expiry']
  if (typeof expiry !== 'string' && typeof expiry !== 'number') {
    problems.push(
      malformed('expiry', 'a plan needs an "expiry" (7d, an ISO timestamp or unix seconds)'),
    )
  }
  const plan: LintPlan = {
    owner: typeof raw['owner'] === 'string' ? raw['owner'] : undefined,
    agent: typeof raw['agent'] === 'string' ? raw['agent'] : undefined,
    expiry: typeof expiry === 'string' || typeof expiry === 'number' ? expiry : undefined,
    permissions,
    relay,
    isPreset: false,
    name: typeof raw['name'] === 'string' ? raw['name'] : undefined,
  }
  return { plan, problems }
}

/** Turn a registry preset into a lintable plan (limits from the preset's suggested examples). */
export function planFromPreset(name: string): LintPlan | null {
  const preset = registry.preset(name)
  if (!preset) return null
  const permissions: LintPermission[] = preset.permissions.map((p) => {
    const suggested = p.suggested as {
      perTxLimit?: { human?: string }
      lifetimeLimit?: { human?: string }
    } | null
    const fromHuman = (human: string | undefined): LimitSpec | undefined => {
      const m = human === undefined ? null : /^([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(human)
      const text = m?.[1]?.replaceAll(',', '')
      const scaled = text === undefined ? undefined : scale(text)
      return text === undefined || scaled === undefined ? undefined : { text, scaled }
    }
    const noAmount = p.instructions.every((i) => i.amount === null)
    return {
      program: p.programIds.devnet ?? p.slug,
      instructions: p.instructions.map((i) => i.disc8),
      spendLimit: noAmount ? 'unlimited' : fromHuman(suggested?.lifetimeLimit?.human),
      perTxLimit: noAmount ? 'unlimited' : fromHuman(suggested?.perTxLimit?.human),
      mints: [],
    }
  })
  return {
    owner: undefined,
    agent: undefined,
    expiry: undefined,
    permissions,
    relay: 'unspecified',
    isPreset: true,
    name: preset.name,
  }
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

interface ResolvedIx {
  readonly input: string
  readonly disc8: string | undefined
  readonly name: string | undefined
  readonly risk: string | undefined
  readonly known: boolean
}

function programId(input: string): string | undefined {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return input
  const own = programIds('devnet')
  const table: Record<string, string> = {
    'agent-auth': own.agentAuth,
    relay: own.relay,
    'mock-amm': own.mockAmm,
    'gated-example': own.gatedExample,
  }
  return table[input] ?? registry.getProgramBySlug(input)?.programIds.devnet
}

function resolveInstruction(id: string, input: string): ResolvedIx {
  let disc8: string | undefined
  if (/^[0-9a-fA-F]{16}$/.test(input)) disc8 = input.toLowerCase()
  else disc8 = registry.instructionByName(id, input)?.disc8
  if (disc8 === undefined) return { input, disc8, name: undefined, risk: undefined, known: false }
  const info = describeInstruction(id, disc8, registry as unknown as RegistryLike)
  return {
    input,
    disc8,
    name: info.name ?? undefined,
    risk: info.risk ?? undefined,
    known: info.known,
  }
}

function listNames(names: readonly string[]): string {
  return names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ')
}

function isUnlimited(limit: LimitSpec | undefined): boolean {
  return limit === 'unlimited'
}

function seconds(plan: LintPlan, opts: LintOptions): bigint | undefined {
  if (plan.expiry === undefined) return undefined
  try {
    const value =
      typeof plan.expiry === 'number'
        ? BigInt(Math.trunc(plan.expiry))
        : /^[0-9]+$/.test(plan.expiry)
          ? BigInt(plan.expiry)
          : plan.expiry
    return parseExpiry(value, opts.nowSeconds)
  } catch {
    return undefined
  }
}

/** Run every rule. Findings are sorted by severity, then rule id, then path. */
export function lintPlan(plan: LintPlan, opts: LintOptions): Finding[] {
  const out: Finding[] = []
  const add = (rule: string, path: string, message: string, hint?: string): void => {
    const meta = RULES[rule]
    if (!meta) throw new Error(`unknown lint rule ${rule}`)
    out.push({
      rule,
      severity: meta.severity,
      message,
      path,
      ...(hint === undefined ? {} : { hint }),
    })
  }

  // AA008 agent key in the owner role
  if (plan.owner !== undefined && plan.agent !== undefined && plan.owner === plan.agent) {
    add(
      'AA008',
      'owner',
      'the owner and the agent are the same key',
      'Use a separate agent key; the agent must never hold owner authority.',
    )
  }
  if (
    plan.relay !== null &&
    plan.relay !== 'unspecified' &&
    plan.relay.sourceAccountOwner !== undefined &&
    plan.relay.sourceAccountOwner === plan.agent
  ) {
    add(
      'AA008',
      'relay.sourceAccountOwner',
      'the funded token account is owned by the agent key',
      'The relay source account must belong to the owner; an agent-owned account is not capped by the relay.',
    )
  }

  // Expiry (AA004, AA010)
  if (!plan.isPreset) {
    const expiry = seconds(plan, opts)
    if (plan.expiry !== undefined && expiry === undefined) {
      add(
        'AA010',
        'expiry',
        `cannot read expiry "${String(plan.expiry)}"`,
        'Use a duration (7d), an ISO timestamp or unix SECONDS (not milliseconds).',
      )
    } else if (expiry !== undefined) {
      if (expiry <= opts.nowSeconds)
        add(
          'AA010',
          'expiry',
          'the expiry is already in the past',
          'create_mandate rejects expiry <= now.',
        )
      if (opts.maxExpirySeconds !== undefined && expiry - opts.nowSeconds > opts.maxExpirySeconds) {
        add(
          'AA004',
          'expiry',
          `the mandate lives ${(expiry - opts.nowSeconds) / 86_400n} day(s), longer than the allowed ${opts.maxExpirySeconds / 86_400n} day(s)`,
          'Shorter mandates limit how long a leaked agent key stays useful.',
        )
      }
    }
  }

  let hasValueOut = false
  let hasSwap = false
  let tokenSpend: { scaled: bigint; text: string } | undefined

  for (const [i, perm] of plan.permissions.entries()) {
    const at = `permissions[${i}]`
    const id = programId(perm.program)
    if (id === undefined) {
      add(
        'AA009',
        `${at}.program`,
        `unknown program "${perm.program}"`,
        'Not in the registry: the risk class of its instructions cannot be checked.',
      )
      continue
    }
    const ixs = perm.instructions.map((input) => resolveInstruction(id, input))
    const moves = ixs.some((x) => x.risk === 'value_out' || x.risk === 'value_swap')

    for (const [j, ix] of ixs.entries()) {
      const where = `${at}.instructions[${j}]`
      if (ix.disc8 === undefined) {
        add(
          'AA009',
          where,
          `instruction "${ix.input}" is not in the registry for this program`,
          'Give its 16-hex-character disc8 and review it by hand.',
        )
      } else if (!ix.known) {
        add(
          'AA009',
          where,
          `instruction ${ix.disc8} is not in the registry (risk unknown)`,
          'Unknown instructions are allowed only by exact disc8; review what it does.',
        )
      }
      if (ix.risk !== undefined && DENY_RISKS.has(ix.risk)) {
        add(
          'AA003',
          where,
          `${ix.name ?? ix.disc8} is ${ix.risk} and is default-deny in the registry`,
          'An agent that can call this can hand control of the owner funds to someone else.',
        )
      }
      if (ix.risk === 'value_out') hasValueOut = true
      if (ix.risk === 'value_swap') hasSwap = true
    }

    // AA001 unlimited
    if (moves) {
      if (isUnlimited(perm.spendLimit))
        add(
          'AA001',
          `${at}.spendLimit`,
          'the lifetime limit is unlimited (0)',
          'On chain 0 means unlimited. Set a finite budget.',
        )
      if (isUnlimited(perm.perTxLimit))
        add(
          'AA001',
          `${at}.perTxLimit`,
          'the per-call limit is unlimited (0)',
          'Set a per-call cap.',
        )
    }

    // AA012
    if (
      perm.spendLimit !== undefined &&
      perm.perTxLimit !== undefined &&
      perm.spendLimit !== 'unlimited' &&
      perm.perTxLimit !== 'unlimited' &&
      perm.perTxLimit.scaled > perm.spendLimit.scaled
    ) {
      add(
        'AA012',
        `${at}.perTxLimit`,
        `the per-call limit (${perm.perTxLimit.text}) is larger than the lifetime budget (${perm.spendLimit.text})`,
      )
    }

    // AA006
    if (new Set(perm.mints).size > 1) {
      add(
        'AA006',
        `${at}.mints`,
        `the spend counter is unit-less but this permission is used with ${perm.mints.length} mints (${perm.mints.join(', ')})`,
        'Base units of different tokens are summed together. Use one mint per program, or split the budget.',
      )
    }

    if (id === TOKEN_PROGRAM_ID || id === TOKEN_2022_PROGRAM_ID) {
      if (
        perm.spendLimit !== undefined &&
        perm.spendLimit !== 'unlimited' &&
        ixs.some((x) => x.risk === 'value_out')
      ) {
        tokenSpend = perm.spendLimit
      }
    }

    // AA011 advisory
    const relayObj = plan.relay !== null && plan.relay !== 'unspecified' ? plan.relay : null
    const hardCovered =
      relayObj !== null &&
      ixs.length > 0 &&
      ((id === TOKEN_PROGRAM_ID && ixs.every((x) => x.disc8 === TRANSFER_CHECKED_DISC)) ||
        (relayObj.swap !== null && ixs.every((x) => x.disc8 === SWAP_BASE_INPUT_DISC)))
    if (!hardCovered) {
      add(
        'AA011',
        at,
        `${registry.getProgramById(id)?.name ?? perm.program}: ${listNames(ixs.map((x) => x.name ?? x.disc8 ?? x.input))} is advisory unless the target program calls verify`,
        'Only the relay transfer and the pinned swap are hard-enforced.',
      )
    }
  }

  // Relay checks
  if (plan.relay !== 'unspecified') {
    const relay = plan.relay
    if (hasValueOut && (relay === null || relay.recipients.length === 0)) {
      add(
        'AA005',
        relay === null ? 'relay' : 'relay.recipients',
        relay === null
          ? 'no relay policy: payments are not tied to a recipient allowlist and are only advisory'
          : 'the relay recipient allowlist is empty (every relay transfer is refused until recipients are set)',
        relay === null
          ? 'Without a relay policy nothing pins the recipients: a fooled agent can pay any account the target program accepts.'
          : 'List the exact recipient token accounts; the allowlist is the main brake on a fooled agent.',
      )
    }
    if (relay !== null) {
      if (isUnlimited(relay.delegate)) {
        add(
          'AA001',
          'relay.delegate',
          'the SPL delegation is unlimited (0)',
          'The delegation is the independent hard cap: make it finite.',
        )
      } else if (
        relay.delegate !== undefined &&
        relay.delegate !== 'unlimited' &&
        tokenSpend !== undefined &&
        relay.delegate.scaled > tokenSpend.scaled
      ) {
        add(
          'AA002',
          'relay.delegate',
          `the relay delegation (${relay.delegate.text}) is larger than the lifetime budget (${tokenSpend.text})`,
          'Delegate no more than the lifetime budget so AgentAuth stays the binding cap.',
        )
      }
    }
    if (hasSwap) {
      const floor = relay?.swap
      const ok =
        floor !== null &&
        floor !== undefined &&
        floor.floorOut !== undefined &&
        floor.floorOut !== 'unlimited' &&
        floor.floorIn !== undefined &&
        floor.floorIn !== 'unlimited'
      if (!ok) {
        add(
          'AA007',
          relay === null ? 'relay' : 'relay.swap',
          'a swap is allowed without a price floor (relay.swap.floorOut / floorIn)',
          'Without a floor the agent can swap at any price; the relay enforces max(minOut, floor).',
        )
      }
    }
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  return out.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      a.path.localeCompare(b.path),
  )
}

export function summarize(findings: readonly Finding[]): {
  error: number
  warn: number
  info: number
} {
  const s = { error: 0, warn: 0, info: 0 }
  for (const f of findings) s[f.severity]++
  return s
}
