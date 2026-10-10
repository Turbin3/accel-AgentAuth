'use client'

import {
  SWAP_BASE_INPUT_DISC,
  TRANSFER_CHECKED_DISC,
  describeInstruction,
  type Mandate,
  type Permission,
  type RegistryLike,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import type { Address } from '@solana/kit'
import { formatLimit } from '@/lib/format'
import { AddressText } from './address'
import { BudgetMeter } from './meter'
import { EnforcementTag, RiskBadge } from './risk'
import { Button, Chip } from './ui'

function isHard(policy: RelayPolicy | null, program: Address, disc: string): boolean {
  if (!policy) return false
  if (program === policy.tokenProgram && disc === TRANSFER_CHECKED_DISC)
    return policy.recipients.length > 0
  if (policy.swap && program === policy.swap.ammProgram && disc === SWAP_BASE_INPUT_DISC)
    return true
  return false
}

export interface PermissionTableProps {
  readonly mandate: Mandate
  readonly policy: RelayPolicy | null
  readonly registry: RegistryLike
  readonly decimalsFor: (program: Address) => number | null
  /** Token symbol shown after amounts of a slot (optional). */
  readonly unitFor?: (program: Address) => string | null
  /** When given, each instruction gets a Revoke button. */
  readonly onRevoke?: (permission: Permission, discHex: string, title: string) => void
  readonly disabled?: boolean
}

/** Every permission slot with registry names, risk classes, hard/advisory labels and a budget meter. */
export function PermissionTable({
  mandate,
  policy,
  registry,
  decimalsFor,
  unitFor,
  onRevoke,
  disabled,
}: PermissionTableProps) {
  if (mandate.permissions.length === 0) {
    return (
      <p className="text-sm text-muted">
        This mandate has no permissions: the agent can do nothing through it.
      </p>
    )
  }
  return (
    <ul className="space-y-4" aria-label="Permissions">
      {mandate.permissions.map((perm) => {
        const decimals = decimalsFor(perm.program)
        const unit = unitFor?.(perm.program) ?? null
        const programInfo = describeInstruction(
          perm.program,
          perm.discriminatorsHex[0] ?? '',
          registry,
        )
        return (
          <li
            key={perm.program}
            className="rounded-lg border border-line p-4"
            data-testid="permission-slot"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 max-w-full">
                <p className="break-words font-medium">
                  {programInfo.programName ?? 'Unlisted program'}
                </p>
                <AddressText value={perm.program} link />
              </div>
              <div className="text-right text-xs text-muted">
                <p>
                  per call:{' '}
                  <span className="font-mono">
                    {formatLimit(perm.perTxUnlimited ? 'unlimited' : perm.perTxLimit, decimals)}
                    {unit && !perm.perTxUnlimited ? ` ${unit}` : ''}
                  </span>
                </p>
                <p>
                  {perm.callCount} verified call{perm.callCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <BudgetMeter
                label="Lifetime budget"
                used={perm.spendTotal}
                limit={perm.spendUnlimited ? 'unlimited' : perm.spendLimit}
                decimals={decimals}
                {...(unit ? { unit } : {})}
              />
            </div>
            <ul
              className="mt-3 divide-y divide-line"
              aria-label={`Instructions allowed on ${programInfo.programName ?? perm.program}`}
            >
              {perm.discriminatorsHex.map((disc) => {
                const info = describeInstruction(perm.program, disc, registry)
                const title = info.title ?? info.name ?? `unlisted instruction ${disc}`
                return (
                  <li
                    key={disc}
                    className="flex flex-col gap-2 py-2 sm:flex-row sm:flex-wrap sm:items-center"
                    data-testid="permission-instruction"
                  >
                    <span className="min-w-0 break-words text-sm sm:flex-1">
                      <span className="font-medium">{title}</span>{' '}
                      <span className="break-all font-mono text-xs text-muted">{disc}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {info.known ? (
                        <RiskBadge risk={info.risk} />
                      ) : (
                        <Chip tone="warn">not in registry</Chip>
                      )}
                      {info.defaultDeny ? <Chip tone="bad">default-deny</Chip> : null}
                      <EnforcementTag
                        level={isHard(policy, perm.program, disc) ? 'hard' : 'advisory'}
                      />
                    </span>
                    {onRevoke ? (
                      <Button
                        variant="danger"
                        disabled={disabled}
                        aria-label={`Revoke ${title} on ${programInfo.programName ?? perm.program}`}
                        onClick={() => onRevoke(perm, disc, title)}
                        className="self-start sm:self-auto"
                        data-testid="revoke-instruction"
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}
