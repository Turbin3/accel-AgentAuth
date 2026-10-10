import { Chip, type Tone } from './ui'

const RISK: Record<string, { label: string; tone: Tone; help: string }> = {
  read_only: { label: 'read only', tone: 'neutral', help: "No effect on the owner's funds." },
  value_out: {
    label: 'value out',
    tone: 'warn',
    help: 'Moves value out of an owner-controlled account.',
  },
  value_swap: {
    label: 'value swap',
    tone: 'warn',
    help: 'Exchanges one asset for another; price risk.',
  },
  position_mgmt: { label: 'position mgmt', tone: 'warn', help: 'Opens or changes DeFi positions.' },
  authority_change: {
    label: 'authority change',
    tone: 'bad',
    help: 'Grants or transfers control. Default-deny.',
  },
  account_close: {
    label: 'account close',
    tone: 'bad',
    help: 'Closes accounts and moves their rent. Default-deny.',
  },
  admin: { label: 'admin', tone: 'bad', help: 'Upgrade or parameter changes. Default-deny.' },
  other: { label: 'other', tone: 'neutral', help: 'Does not fit another class.' },
  unknown: {
    label: 'unknown',
    tone: 'neutral',
    help: 'Not in the verified registry. Treat as dangerous.',
  },
}

/** Risk class of a registry instruction. Red marks the classes the registry denies by default. */
export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  const key = risk ?? 'unknown'
  const entry = RISK[key] ?? {
    label: key,
    tone: 'neutral' as Tone,
    help: 'Unrecognised risk class.',
  }
  return (
    <Chip tone={entry.tone} title={entry.help} mark={entry.tone !== 'neutral'}>
      {entry.label}
    </Chip>
  )
}

/** Hard (relay) versus advisory: the one distinction the product must never blur. */
export function EnforcementTag({ level }: { level: 'hard' | 'advisory' }) {
  return level === 'hard' ? (
    <span
      title="Enforced by the relay program itself."
      className="inline-flex whitespace-nowrap rounded border border-accent bg-accent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-ink"
    >
      hard (relay)
    </span>
  ) : (
    <span
      title="Only binding if the program that performs the action calls verify."
      className="inline-flex whitespace-nowrap rounded border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted"
    >
      advisory
    </span>
  )
}

export function enforcementLevel(label: string): 'hard' | 'advisory' {
  return label.startsWith('hard') ? 'hard' : 'advisory'
}
