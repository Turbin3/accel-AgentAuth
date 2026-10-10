/**
 * Terminal presentation helpers for the scripted scenarios: colour (only on a TTY), headings,
 * wrapped text, localnet explorer links and a pause that `--fast` turns off.
 */

const useColour =
  process.env['NO_COLOR'] === undefined &&
  (process.env['FORCE_COLOR'] !== undefined || process.stdout.isTTY === true)

const wrap = (open: number, close: number) => (s: string) =>
  useColour ? `\u001b[${open}m${s}\u001b[${close}m` : s

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
}

/** `abcd...wxyz` for an address or signature. */
export function short(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}...${value.slice(-tail)}`
}

/** Explorer link for a transaction on a local validator (the explorer reads the RPC from the URL). */
export function explorerTxUrl(signature: string, rpcUrl: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`
}

/** Explorer link for an account on a local validator. */
export function explorerAddressUrl(address: string, rpcUrl: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`
}

/** Break `text` into lines of at most `width` characters (words are never split). */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      if (line.length > 0 && line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else {
        line = line.length === 0 ? word : `${line} ${word}`
      }
    }
    lines.push(line)
  }
  return lines
}

/** A fixed-width text table (header, rows). Cells are padded to the widest entry of their column. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const fmt = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')
  const rule = widths.map((w) => '-'.repeat(w)).join('  ')
  return [fmt(header), rule, ...rows.map(fmt)]
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
