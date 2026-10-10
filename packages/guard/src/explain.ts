import type { GuardReport } from './types'

/**
 * Plain-text explanation of a guard report: one line per instruction, then the honesty footer.
 * COOPERATIVE CLIENT-SIDE GUARD (not enforcement).
 */
export function explainReport(report: GuardReport): string {
  const lines: string[] = []
  lines.push(
    report.ok
      ? `Allowed: every instruction passes the guard (mode ${report.mode}).`
      : `Refused: ${report.refusals.length} of ${report.verdicts.length} instructions would be denied (mode ${report.mode}).`,
  )
  lines.push(`Mandate ${report.mandate} (owner ${report.owner}, agent ${report.agent}).`)
  for (const note of report.notes) lines.push(`Note: ${note}`)
  for (const v of report.verdicts) {
    const what = v.instruction ?? v.disc8 ?? 'unknown instruction'
    const amount = v.amount === null ? '' : ` amount ${v.amount}`
    lines.push(
      `  #${v.index} ${v.allowed ? 'ALLOW' : 'DENY '} ${v.programName ?? v.programId} ${what}${amount}: ${v.reason}${v.code === null ? '' : ` [${v.code}]`}`,
    )
  }
  lines.push(report.disclaimer)
  return lines.join('\n')
}
