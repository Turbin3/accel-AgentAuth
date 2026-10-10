import { describe, expect, it } from 'vitest'
import { TRANSFER_CHECKED_DISC, programIds } from '@agentauth-sol/sdk'
import type { Context } from '../../src/context'
import { resolveInstructionInput, resolveProgramInput } from '../../src/tools/owner'

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ctx = {
  client: { programIds: programIds('localnet') },
  config: { cluster: 'localnet' },
} as unknown as Context

describe('owner_plan_revoke_permission input resolution', () => {
  it('accepts a base58 id or a registry slug and gives the same program', () => {
    const bySlug = resolveProgramInput(ctx, 'spl-token')
    const byId = resolveProgramInput(ctx, TOKEN)
    expect(bySlug.id).toBe(TOKEN)
    expect(byId.id).toBe(TOKEN)
    expect(byId.slug).toBe('spl-token')
  })

  it('resolves AgentAuth program names and rejects unknown programs', () => {
    expect(resolveProgramInput(ctx, 'relay').id).toBe(programIds('localnet').relay)
    expect(() => resolveProgramInput(ctx, 'no-such-program')).toThrow(/unknown program/)
  })

  it('accepts instruction names and 16-hex disc8 (any case)', () => {
    const program = resolveProgramInput(ctx, 'spl-token')
    expect(resolveInstructionInput(program, 'transfer_checked')).toBe(TRANSFER_CHECKED_DISC)
    expect(resolveInstructionInput(program, TRANSFER_CHECKED_DISC.toUpperCase())).toBe(
      TRANSFER_CHECKED_DISC,
    )
    expect(() => resolveInstructionInput(program, 'no_such_instruction')).toThrow(
      /unknown instruction/,
    )
  })
})
