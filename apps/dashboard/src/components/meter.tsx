import { formatAmount, percentOf } from '@/lib/format'

/**
 * Budget meter in human units. Unlimited budgets render as a word, never as an empty bar or a 0.
 * `decimals` is null when the unit of the slot is unknown (then raw units are shown).
 */
export function BudgetMeter({
  label,
  used,
  limit,
  decimals,
  unit,
}: {
  label: string
  used: bigint
  limit: bigint | 'unlimited'
  decimals: number | null
  unit?: string
}) {
  const percent = percentOf(used, limit)
  const suffix = unit ? ` ${unit}` : ''
  const usedText = formatAmount(used, decimals)
  const remaining = limit === 'unlimited' ? null : limit > used ? limit - used : 0n
  const text =
    limit === 'unlimited'
      ? `${usedText}${suffix} used, no lifetime limit`
      : `${usedText} of ${formatAmount(limit, decimals)}${suffix} used, ${formatAmount(remaining ?? 0n, decimals)}${suffix} left`
  const tone =
    percent === null ? 'bg-warn' : percent >= 100 ? 'bg-bad' : percent >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {limit === 'unlimited' ? (
          <span className="rounded-full border border-warn/40 bg-warn-bg px-2 text-xs font-medium text-warn">
            ! unlimited
          </span>
        ) : null}
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? 0 : Math.round(percent)}
        aria-valuetext={text}
        className="mt-1 h-2 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--meter-track)' }}
      >
        <div
          className={`h-full ${tone}`}
          style={{
            width: `${percent === null ? 100 : Math.max(percent, used > 0n ? 2 : 0)}%`,
            opacity: percent === null ? 0.35 : 1,
          }}
        />
      </div>
      <p className="mt-1 text-xs text-muted">{text}</p>
    </div>
  )
}
