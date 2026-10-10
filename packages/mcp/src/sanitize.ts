/**
 * Prompt-injection hygiene for text that did not come from this server's own source code.
 *
 * Anything an attacker can influence (token-account labels, memos, program logs, RPC error text,
 * names in a registry the operator did not write) reaches the model only through these helpers:
 * every character outside printable ASCII is escaped, markup characters are escaped, the length is
 * capped, and the result is wrapped in an object that says "untrusted". This does not make hostile
 * text harmless to a model that chooses to obey it. It removes invisible and structural tricks and
 * labels the text as data; the server instructions and tool descriptions tell the model what to do
 * with such data.
 */

/** Text that originated outside this server. Always data, never instructions. */
export interface UntrustedText {
  readonly untrusted_text: string
  /** Present and true when the text was cut at the length cap. */
  readonly truncated?: true
  /** Heuristic: the text reads like an instruction to an AI system. Still data. */
  readonly looks_like_instructions?: true
}

const INSTRUCTION_LIKE =
  /ignore (all |any |the )?(previous|prior|above|earlier)|disregard|system prompt|new instructions?|you (must|should|are now)|as an? (ai|assistant|llm)|<\s*\/?\s*(system|tool|assistant|instructions?)|\b(assistant|system|developer)\s*:|send (all|every|the funds)|private key|seed phrase|recovery phrase/i

/** `\xNN` below 0x100, else `\uNNNN` per UTF-16 unit (astral characters become a surrogate pair). */
function escapeUnit(unit: number): string {
  return unit <= 0xff
    ? `\\x${unit.toString(16).padStart(2, '0')}`
    : `\\u${unit.toString(16).padStart(4, '0')}`
}

/**
 * Escape `input` to printable ASCII without markup characters and cap the escaped length.
 * Backslash is escaped too, so the output is unambiguous. Surrogates are escaped one UTF-16 unit at a time.
 */
export function escapeText(input: string, maxLength: number): { text: string; truncated: boolean } {
  let out = ''
  let truncated = false
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i)
    const ch = input.charAt(i)
    const plain = unit >= 0x20 && unit <= 0x7e && !'<>`[]{}\\'.includes(ch)
    const piece = plain ? ch : escapeUnit(unit)
    if (out.length + piece.length > maxLength) {
      truncated = true
      break
    }
    out += piece
  }
  return { text: out, truncated }
}

/** Wrap outside text for a model-visible result (see the module comment). */
export function untrusted(input: unknown, maxLength = 160): UntrustedText {
  const raw = typeof input === 'string' ? input : String(input)
  const { text, truncated } = escapeText(raw, maxLength)
  return {
    untrusted_text: text,
    ...(truncated ? { truncated: true as const } : {}),
    ...(INSTRUCTION_LIKE.test(raw) ? { looks_like_instructions: true as const } : {}),
  }
}

/** Escaped, capped plain string for fields where an object wrapper would be noise (error messages). */
export function safeString(input: unknown, maxLength = 300): string {
  const raw = typeof input === 'string' ? input : String(input)
  const { text, truncated } = escapeText(raw, maxLength)
  return truncated ? `${text}...[truncated]` : text
}

// Control characters, zero-width and bidirectional formatting characters, line and paragraph
// separators, and the BOM. Built from escapes so the source file itself contains none of them.
const INVISIBLE = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]',
  'g',
)

/**
 * For text written by this repository or the SDK (explanations, plan summaries): strip invisible and
 * control characters, collapse whitespace and cap the length, but keep ordinary punctuation such as
 * the ellipsis. Never use this for text an outsider can influence; use {@link untrusted} or
 * {@link safeString}.
 */
export function tidy(input: unknown, maxLength = 300): string {
  const raw = typeof input === 'string' ? input : String(input)
  const clean = raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean
}
