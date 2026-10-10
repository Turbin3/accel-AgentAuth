/**
 * The scenario runner: narrates every beat (what is attempted, who signs, decoded outcome,
 * signature, explorer link, running scoreboard), asserts the expected outcome and records a JSON
 * transcript. A beat that does not end as expected throws {@link DeviationError}: the scripts exit
 * non-zero on any deviation.
 */
import { writeFile } from 'node:fs/promises'
import {
  toJsonSafe,
  type AgentAuthError,
  type Client,
  type ErrorProgram,
  type JsonValue,
} from '@agentauth-sol/sdk'
import type { Instruction, TransactionSigner } from '@solana/kit'
import { c, explorerTxUrl, short, sleep, wrapText } from './ui'

export interface RunOptions {
  readonly name: string
  /** No pauses between beats (CI). */
  readonly fast: boolean
  /** Print only the JSON transcript on stdout. */
  readonly json: boolean
  /** Pause after each beat, in milliseconds (ignored with `fast`). */
  readonly pauseMs: number
  /** Also write the JSON transcript to this file. */
  readonly transcriptFile: string | undefined
}

/** Parse `--fast`, `--json`, `--pause <ms>`, `--transcript <file>`. Unknown flags are an error. */
export function parseRunOptions(name: string, argv: readonly string[]): RunOptions {
  let fast = false
  let json = false
  let pauseMs = 1200
  let transcriptFile: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--fast') fast = true
    else if (a === '--json') json = true
    else if (a === '--pause') pauseMs = Number(argv[++i])
    else if (a === '--transcript') transcriptFile = argv[++i]
    else if (a === '--') continue
    else
      throw new Error(
        `unknown option ${String(a)} (use --fast, --json, --pause <ms>, --transcript <file>)`,
      )
  }
  if (!Number.isFinite(pauseMs) || pauseMs < 0)
    throw new Error('--pause needs a number of milliseconds')
  return { name, fast: fast || json, json, pauseMs, transcriptFile }
}

/** What a beat must end in. */
export type Expect =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly program: ErrorProgram
      readonly code: number
      readonly name: string
    }
  /** A failure that is not a program error, matched by a message substring (for example a replay). */
  | { readonly ok: false; readonly message: string }

export function describeExpect(e: Expect): string {
  if (e.ok) return 'success'
  return 'message' in e ? `rejected: "${e.message}"` : `${e.program} ${e.code} ${e.name}`
}

export type Actor = 'agent' | 'attacker' | 'hot' | 'owner' | 'harness'

/** What an `execute` override returns: the outcome of a transaction the runner did not send itself. */
export interface SendOutcome {
  readonly signature: string
  readonly ok: boolean
  readonly error: AgentAuthError | null
  readonly message: string | null
  readonly err: unknown
}

export interface AttemptSpec {
  readonly id: string
  readonly title: string
  /** What is being attempted, in one sentence. */
  readonly doing: string
  /** Who signs, in words. */
  readonly who: string
  readonly actor: Actor
  /** A scripted attacker step: labelled SCRIPTED on screen. */
  readonly scripted?: boolean
  /** Fee payer first. */
  readonly signers: readonly TransactionSigner[]
  readonly build?: () => Promise<readonly Instruction[]> | readonly Instruction[]
  /** Replaces build + send (for example a replayed transaction). */
  readonly execute?: () => Promise<SendOutcome>
  readonly expect: Expect
  /** Why it ends this way (one sentence). */
  readonly why?: string
  /** Counted on this scoreboard (agent and attacker actions only). */
  readonly board?: Scoreboard
  readonly computeUnitLimit?: number
  /** Extra lines printed under the result. */
  readonly detail?: () => Promise<readonly string[]> | readonly string[]
}

export interface BeatRecord {
  readonly id: string
  readonly title: string
  readonly doing: string
  readonly who: string
  readonly actor: Actor
  readonly scripted: boolean
  readonly expected: string
  readonly kind: 'allowed' | 'blocked' | 'admin'
  readonly ok: boolean
  readonly matched: boolean
  readonly error: { program: string; code: number; name: string; message: string } | null
  readonly instructionIndex: number | null
  readonly signature: string
  readonly explorer: string
  readonly why: string | null
}

export class DeviationError extends Error {
  constructor(
    readonly beatId: string,
    message: string,
  ) {
    super(`deviation at ${beatId}: ${message}`)
    this.name = 'DeviationError'
  }
}

/**
 * attempted / blocked / allowed / funds lost to the attacker, for one phase of a scenario.
 * An optional second tracker reports value that moved to an allowlisted payee within the
 * budget (accepted spends such as the disclosed L4 split are counted there, never as a loss).
 */
export class Scoreboard {
  attempted = 0
  blocked = 0
  allowed = 0
  constructor(
    readonly title: string,
    private readonly fundsLost: () => Promise<string>,
    private readonly movedToPayee?: () => Promise<string>,
  ) {}
  record(ok: boolean): void {
    this.attempted++
    if (ok) this.allowed++
    else this.blocked++
  }
  async line(): Promise<string> {
    const moved =
      this.movedToPayee === undefined
        ? ''
        : ` | moved to the allowlisted payee within the budget ${await this.movedToPayee()}`
    return `scoreboard [${this.title}]  attempted ${this.attempted} | blocked ${this.blocked} | allowed ${this.allowed} | funds lost to the attacker ${await this.fundsLost()}${moved}`
  }
  async snapshot(): Promise<{
    title: string
    attempted: number
    blocked: number
    allowed: number
    fundsLost: string
    movedToPayee: string | null
  }> {
    return {
      title: this.title,
      attempted: this.attempted,
      blocked: this.blocked,
      allowed: this.allowed,
      fundsLost: await this.fundsLost(),
      movedToPayee: this.movedToPayee === undefined ? null : await this.movedToPayee(),
    }
  }
}

/** The instruction index inside a failed transaction (`InstructionError: [index, ...]`), if present. */
export function instructionIndexOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const ie = (err as { InstructionError?: unknown }).InstructionError
  if (!Array.isArray(ie)) return null
  const first: unknown = ie[0]
  return typeof first === 'number' || typeof first === 'bigint' ? Number(first) : null
}

export class Run {
  readonly beats: BeatRecord[] = []
  readonly boards: Scoreboard[] = []
  readonly notes: string[] = []
  private readonly started = Date.now()

  constructor(
    readonly opts: RunOptions,
    readonly client: Client,
    readonly rpcUrl: string,
  ) {}

  /** Print a line (nothing in `--json` mode). */
  out(line = ''): void {
    if (!this.opts.json) console.log(line)
  }

  banner(title: string, lines: readonly string[]): void {
    const width = 100
    this.out(c.bold('='.repeat(width)))
    this.out(c.bold(` ${title}`))
    for (const l of lines) for (const w of wrapText(l, width - 2)) this.out(` ${w}`)
    this.out(c.bold('='.repeat(width)))
  }

  heading(title: string, lines: readonly string[] = []): void {
    this.out()
    this.out(c.bold(c.cyan(`--- ${title} ${'-'.repeat(Math.max(3, 94 - title.length))}`)))
    for (const l of lines) for (const w of wrapText(l, 96)) this.out(`  ${w}`)
  }

  say(text: string): void {
    for (const w of wrapText(text, 96)) this.out(`  ${w}`)
  }

  /** A fact established outside a transaction (a balance, an assertion). Recorded in the transcript. */
  fact(text: string): void {
    this.notes.push(text)
    this.out(`  ${c.dim('fact')}      ${text}`)
  }

  /** `label  text` with the text wrapped under itself. */
  field(label: string, text: string): void {
    const pad = ' '.repeat(12)
    const lines = wrapText(text, 88)
    lines.forEach((l, i) => this.out(`  ${i === 0 ? label.padEnd(10) : pad.slice(0, 10)}${l}`))
  }

  async pause(): Promise<void> {
    if (!this.opts.fast && this.opts.pauseMs > 0) await sleep(this.opts.pauseMs)
  }

  newBoard(
    title: string,
    fundsLost: () => Promise<string>,
    movedToPayee?: () => Promise<string>,
  ): Scoreboard {
    const b = new Scoreboard(title, fundsLost, movedToPayee)
    this.boards.push(b)
    return b
  }

  /** Send one transaction (or run `execute`), narrate it and assert the expected outcome. */
  async attempt(spec: AttemptSpec): Promise<BeatRecord> {
    const tag = spec.scripted === true ? ` ${c.magenta('[SCRIPTED compromised agent]')}` : ''
    this.out()
    this.out(`${c.bold(`> ${spec.id}`)}  ${c.bold(spec.title)}${tag}`)
    this.field('attempt', spec.doing)
    this.field('signer', spec.who)

    let outcome: SendOutcome
    if (spec.execute !== undefined) {
      outcome = await spec.execute()
    } else {
      if (spec.build === undefined) throw new Error(`${spec.id}: needs build or execute`)
      const ixs = await spec.build()
      const res = await this.client.sendAndConfirm(ixs, {
        signers: spec.signers,
        skipPreflight: true,
        ...(spec.computeUnitLimit !== undefined ? { computeUnitLimit: spec.computeUnitLimit } : {}),
      })
      outcome = {
        signature: res.signature,
        ok: res.ok,
        error: res.error,
        message: res.ok ? null : JSON.stringify(toJsonSafe(res.err)),
        err: res.err,
      }
    }

    const index = instructionIndexOf(outcome.err)
    const matched = matches(spec.expect, outcome)
    const kind: BeatRecord['kind'] =
      spec.actor === 'owner' || spec.actor === 'harness'
        ? 'admin'
        : outcome.ok
          ? 'allowed'
          : 'blocked'
    const record: BeatRecord = {
      id: spec.id,
      title: spec.title,
      doing: spec.doing,
      who: spec.who,
      actor: spec.actor,
      scripted: spec.scripted === true,
      expected: describeExpect(spec.expect),
      kind,
      ok: outcome.ok,
      matched,
      error: outcome.error
        ? {
            program: outcome.error.program,
            code: outcome.error.code,
            name: outcome.error.name,
            message: outcome.error.message,
          }
        : null,
      instructionIndex: index,
      signature: outcome.signature,
      explorer: explorerTxUrl(outcome.signature, this.rpcUrl),
      why: spec.why ?? null,
    }
    this.beats.push(record)
    if (spec.board !== undefined && kind !== 'admin') spec.board.record(outcome.ok)

    const verdict = outcome.ok
      ? c.green('ALLOWED')
      : outcome.error
        ? c.yellow('BLOCKED')
        : c.yellow('REJECTED')
    const detailText = outcome.ok
      ? 'transaction succeeded'
      : outcome.error
        ? `${outcome.error.program} ${outcome.error.code} ${outcome.error.name}${
            index !== null ? ` at instruction ${index}` : ''
          }: ${outcome.error.message}`
        : (outcome.message ?? 'rejected')
    this.field('result', `${verdict}  ${detailText}`)
    if (spec.why !== undefined) this.field('why', spec.why)
    this.out(
      `  expected  ${describeExpect(spec.expect)} ${matched ? c.green('(matched)') : c.red('(MISMATCH)')}`,
    )
    this.out(
      `  tx        ${short(outcome.signature, 8, 8)}${outcome.ok ? '' : '  (landed and failed: the fee is paid, nothing else moves)'}`,
    )
    this.out(`  explorer  ${record.explorer}`)
    if (spec.detail !== undefined) for (const l of await spec.detail()) this.out(`  ${l}`)
    if (spec.board !== undefined && kind !== 'admin') this.out(`  ${await spec.board.line()}`)

    if (!matched) {
      throw new DeviationError(
        spec.id,
        `expected ${describeExpect(spec.expect)} but got ${outcome.ok ? 'success' : detailText}`,
      )
    }
    await this.pause()
    return record
  }

  /** The JSON transcript. */
  async transcript(result: 'pass' | 'fail', failure?: string): Promise<JsonValue> {
    return toJsonSafe({
      tool: `agentauth-demo ${this.opts.name}`,
      honesty:
        'Local validator only. Unaudited devnet prototype. Hard enforcement only for the relay transfer and the pinned swap. Attackers are scripted.',
      rpcUrl: this.rpcUrl,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      result,
      failure: failure ?? null,
      scoreboards: await Promise.all(this.boards.map((b) => b.snapshot())),
      facts: this.notes,
      beats: this.beats,
    })
  }

  /** Print the JSON (or write it to the transcript file) at the end of a run. */
  async finish(result: 'pass' | 'fail', failure?: string): Promise<void> {
    const transcript = await this.transcript(result, failure)
    const text = `${JSON.stringify(transcript, null, 2)}\n`
    if (this.opts.transcriptFile !== undefined) await writeFile(this.opts.transcriptFile, text)
    if (this.opts.json) process.stdout.write(text)
  }
}

function matches(expect: Expect, outcome: SendOutcome): boolean {
  if (expect.ok) return outcome.ok
  if (outcome.ok) return false
  if ('message' in expect) return (outcome.message ?? '').includes(expect.message)
  const e = outcome.error
  return (
    e !== null && e.program === expect.program && e.code === expect.code && e.name === expect.name
  )
}

/** Run a scenario `main`, turn any failure into a non-zero exit and always emit the transcript. */
export async function runMain(run: Run, main: () => Promise<void>): Promise<void> {
  try {
    await main()
    await run.finish('pass')
    run.out()
    run.out(
      c.green(
        c.bold(
          `${run.opts.name}: PASSED (${run.beats.length} transactions, every outcome as expected)`,
        ),
      ),
    )
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await run.finish('fail', message)
    console.error(c.red(c.bold(`${run.opts.name}: FAILED: ${message}`)))
    process.exit(1)
  }
}
