import { stripVTControlCharacters, styleText } from 'node:util'
import { toJsonSafe, type JsonValue } from '@agentauth-sol/sdk'
import type { CliError } from './errors'

/** Version of the `--json` envelope. Bump only for breaking changes (documented in the README). */
export const JSON_SCHEMA = 'agentauth-cli/1'

export interface Sink {
  write(chunk: string): unknown
  readonly isTTY?: boolean | undefined
}

type Style = 'green' | 'red' | 'yellow' | 'cyan' | 'bold' | 'dim' | 'magenta'

export interface OutOptions {
  readonly json: boolean
  /** Final decision on colour (already combined from --no-color, NO_COLOR and the TTY). */
  readonly color: boolean
}

/**
 * All terminal output goes through here. In `--json` mode human text is suppressed and the command
 * ends with exactly one JSON document on stdout (the envelope); progress notes go to stderr.
 */
export class Out {
  readonly json: boolean
  readonly color: boolean

  constructor(
    private readonly stdout: Sink,
    private readonly stderr: Sink,
    opts: OutOptions,
  ) {
    this.json = opts.json
    this.color = opts.color
  }

  style(format: Style | Style[], text: string): string {
    return this.color ? styleText(format, text, { validateStream: false }) : text
  }

  ok(text: string): string {
    return this.style('green', text)
  }
  bad(text: string): string {
    return this.style('red', text)
  }
  warn(text: string): string {
    return this.style('yellow', text)
  }
  dim(text: string): string {
    return this.style('dim', text)
  }
  bold(text: string): string {
    return this.style('bold', text)
  }
  link(text: string): string {
    return this.style('cyan', text)
  }

  /** A line of human output on stdout (suppressed in `--json` mode). */
  say(text = ''): void {
    if (!this.json) this.stdout.write(`${text}\n`)
  }

  /** A note on stderr (suppressed in `--json` mode so that stdout stays one document). */
  note(text: string): void {
    if (!this.json) this.stderr.write(`${text}\n`)
  }

  /** A heading followed by indented lines. */
  section(title: string, lines: readonly string[]): void {
    if (lines.length === 0) return
    this.say(this.bold(title))
    for (const line of lines) this.say(`  ${line}`)
  }

  /** Aligned `key  value` rows. */
  keyValues(rows: ReadonlyArray<readonly [string, string]>, indent = 2): void {
    const width = Math.max(0, ...rows.map(([k]) => k.length))
    for (const [key, value] of rows) {
      this.say(`${' '.repeat(indent)}${this.dim(key.padEnd(width))}  ${value}`)
    }
  }

  /** A simple aligned table. Cells may already contain colour codes. */
  table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
    const widths = header.map((h, i) =>
      Math.max(
        stripVTControlCharacters(h).length,
        ...rows.map((r) => stripVTControlCharacters(r[i] ?? '').length),
      ),
    )
    const pad = (cell: string, i: number): string =>
      cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - stripVTControlCharacters(cell).length))
    this.say(
      this.dim(
        header
          .map((h, i) => pad(h, i))
          .join('  ')
          .trimEnd(),
      ),
    )
    for (const row of rows)
      this.say(
        row
          .map((c, i) => pad(c, i))
          .join('  ')
          .trimEnd(),
      )
  }

  /** Print the success envelope (JSON mode only). */
  emit(command: string, cluster: string | undefined, data: unknown): void {
    if (!this.json) return
    this.stdout.write(
      `${JSON.stringify(envelope({ ok: true, command, cluster, data: toJsonSafe(data) }))}\n`,
    )
  }

  /** One NDJSON line (for `activity --follow --json`). */
  emitLine(command: string, cluster: string | undefined, data: unknown): void {
    this.emit(command, cluster, data)
  }

  /** Print a failure: human text on stderr, or the error envelope on stdout in `--json` mode. */
  fail(command: string, cluster: string | undefined, error: CliError): void {
    if (this.json) {
      const payload: Record<string, JsonValue> = {
        kind: error.kind,
        message: error.message,
      }
      if (error.hint !== undefined) payload['hint'] = error.hint
      if (error.program !== undefined) {
        payload['program'] = toJsonSafe(error.program)
        payload['programErrorSource'] = error.program.program
      }
      this.stdout.write(
        `${JSON.stringify(
          envelope({
            ok: false,
            command,
            cluster,
            error: payload,
            exitCode: error.exitCode,
            data: error.data === undefined ? null : toJsonSafe(error.data),
          }),
        )}\n`,
      )
      return
    }
    this.stderr.write(`${this.bad('error')} ${error.message}\n`)
    if (error.program !== undefined) {
      const p = error.program
      this.stderr.write(`  ${this.bold('program error')}  ${p.program}:${p.code} ${p.name}\n`)
      this.stderr.write(`  ${this.dim('why')}            ${p.message}\n`)
      if (p.hint) this.stderr.write(`  ${this.dim('fix')}            ${p.hint}\n`)
    }
    if (error.hint !== undefined && error.hint !== error.program?.hint) {
      for (const [i, line] of error.hint.split('\n').entries()) {
        this.stderr.write(
          `  ${i === 0 ? this.dim('hint') + '           ' : ' '.repeat(18)}${line}\n`,
        )
      }
    }
  }
}

interface EnvelopeInput {
  readonly ok: boolean
  readonly command: string
  readonly cluster: string | undefined
  readonly data?: JsonValue
  readonly error?: JsonValue
  readonly exitCode?: number
}

function envelope(input: EnvelopeInput): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {
    schema: JSON_SCHEMA,
    ok: input.ok,
    command: input.command,
    cluster: input.cluster ?? null,
  }
  if (input.ok) out['data'] = input.data ?? null
  else {
    out['error'] = input.error ?? null
    out['exitCode'] = input.exitCode ?? 1
    out['data'] = input.data ?? null
  }
  return out
}
