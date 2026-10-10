import { describe, expect, it } from 'vitest'
import {
  MOCK_AMM_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  decodeMandate,
  explainMandate,
  type Mandate,
  type RegistryLike,
  type RelayPolicy,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, type TestPermission } from './helpers'

const owner = fakeAddress(0x21)
const agent = fakeAddress(0x22)
const authority = fakeAddress(0x23)
const NOW = 1_800_000_000n
const EXPIRY = NOW + 7n * 86_400n

function mandate(
  permissions: TestPermission[],
  over: { active?: boolean; expiry?: bigint; version?: number } = {},
): Mandate {
  return decodeMandate(
    encodeMandateBytes({
      owner,
      agent,
      expiry: over.expiry ?? EXPIRY,
      active: over.active,
      version: over.version,
      permissions,
    }),
    undefined,
    { acceptLegacyVersion: true },
  )
}
const tokenPerm: TestPermission = {
  program: TOKEN_PROGRAM_ID,
  spendLimit: 5_000_000n,
  perTxLimit: 1_000_000n,
  spendTotal: 1_200_000n,
  callCount: 3,
  discs: [TRANSFER_CHECKED_DISC],
}
const swapPerm: TestPermission = {
  program: MOCK_AMM_PROGRAM_ID,
  spendLimit: 5_000_000n,
  perTxLimit: 5_000_000n,
  discs: [SWAP_BASE_INPUT_DISC],
}

function policy(over: Partial<RelayPolicy> = {}, withSwap = false): RelayPolicy {
  return {
    address: fakeAddress(0x24),
    version: 1,
    policyBump: 255,
    authorityBump: 254,
    flags: 2,
    paused: false,
    strictTopLevel: true,
    mandate: fakeAddress(0x25),
    owner,
    agent,
    authority,
    mandateExpiry: EXPIRY,
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: fakeAddress(0x26),
    sourceAccount: fakeAddress(0x27),
    recipients: [fakeAddress(0x28)],
    swap: withSwap
      ? {
          ammProgram: MOCK_AMM_PROGRAM_ID,
          ammAuthority: fakeAddress(0x30),
          ammConfig: fakeAddress(0x31),
          poolState: fakeAddress(0x32),
          inputVault: fakeAddress(0x33),
          outputVault: fakeAddress(0x34),
          observationState: fakeAddress(0x35),
          inMint: fakeAddress(0x26),
          outMint: fakeAddress(0x36),
          inTokenProgram: TOKEN_PROGRAM_ID,
          outTokenProgram: TOKEN_PROGRAM_ID,
          inAccount: fakeAddress(0x27),
          outAccount: fakeAddress(0x37),
          floorOut: 95n,
          floorIn: 100n,
          maxDeadlineSlots: 150,
        }
      : null,
    ...over,
  }
}
const joined = (xs: readonly string[]): string => xs.join('\n')

describe('explainMandate: payments mandate with a relay policy', () => {
  const e = explainMandate(mandate([tokenPerm]), {
    policy: policy(),
    now: NOW,
    budgetDecimals: 6,
    delegation: { delegate: authority, delegatedAmount: 5_000_000n },
  })

  it('headline states agent, owner, permissions, status, expiry and what is hard-enforced', () => {
    expect(e.headline).toBe(
      'Agent 3JF3…QKy3 acts for owner 3EKk…ezeL with 1 permission (active); expires 2027-01-22T08:00:00.000Z (in 7 days). A relay policy hard-enforces transfers.',
    )
    expect(e.status).toBe('active')
    expect(e.expiry).toEqual({
      iso: '2027-01-22T08:00:00.000Z',
      relative: 'in 7 days',
      expired: false,
    })
  })

  it('can: the relay payment (hard), nothing else', () => {
    expect(e.can).toHaveLength(1)
    expect(e.can[0]).toMatch(
      /^Pay token .* to 1 allowlisted token account .* through the relay \(hard-enforced\)$/,
    )
  })

  it('limits are bigint-exact and humanised with the budget decimals', () => {
    expect(e.limits).toHaveLength(1)
    expect(e.limits[0]).toMatchObject({
      spendLimit: 5_000_000n,
      perTxLimit: 1_000_000n,
      spendTotal: 1_200_000n,
      callCount: 3,
      remaining: 3_800_000n,
    })
    expect(e.limits[0]?.text).toContain('at most 1 (1000000 raw units) per call')
    expect(e.limits[0]?.text).toContain(
      '3.8 (3800000 raw units) of 5 (5000000 raw units) lifetime budget left',
    )
    expect(e.limits[0]?.text).toContain('3 calls so far')
  })

  it('enforcement: TransferChecked is hard (relay)', () => {
    expect(e.enforcement).toEqual([
      {
        action:
          'Transfer (checked) on SPL Token (Toke…Q5DA) (only via relay transfer, to allowlisted token accounts)',
        level: 'hard (relay)',
      },
    ])
  })

  it('cannot: spells out the on-chain blast radius', () => {
    const c = joined(e.cannot)
    expect(c).toContain('Pay any token account that is not on the allowlist (relay error 104)')
    expect(c).toContain('Take custody')
    expect(c).toContain('hard cap enforced by the Token program')
    expect(c).toContain('Change the mandate, its permissions or the relay policy')
  })

  it('warns honestly: recipients are token accounts, unit-less counters', () => {
    const w = joined(e.warnings)
    expect(w).toContain('Recipients are token accounts, not wallets')
    expect(w).toContain('unit-less')
    expect(w).not.toMatch(/UNLIMITED/)
  })

  it('warns when the SPL delegation exceeds the remaining mandate budget', () => {
    expect(joined(e.warnings)).toContain(
      'larger than the remaining mandate budget (3.8 (3800000 raw units))',
    )
  })

  it('never claims more than the code enforces', () => {
    const all = joined([e.headline, ...e.can, ...e.cannot, ...e.warnings])
    for (const banned of [
      /audited/i,
      /trustless/i,
      /prevent[s]? prompt/i,
      /MEV-safe/i,
      /immutable/i,
    ])
      expect(all).not.toMatch(banned)
  })
})

describe('explainMandate: swap mandate', () => {
  const e = explainMandate(mandate([tokenPerm, swapPerm]), { policy: policy({}, true), now: NOW })
  it('both relay actions are hard, with the pinned-pool wording and the MEV caveat', () => {
    expect(e.enforcement.map((x) => x.level)).toEqual(['hard (relay)', 'hard (relay)'])
    expect(e.enforcement[1]?.action).toContain('only via relay swap, on the pinned pool')
    expect(e.can[1]).toMatch(/Swap .* on the ONE pinned pool .* at no worse than 95\/100/)
    expect(e.can[1]).toContain('deadline at most 150 slots ahead')
    expect(e.can[1]).toContain('not MEV protection')
    expect(e.headline).toMatch(/hard-enforces transfers and one pinned swap\.$/)
    expect(joined(e.warnings)).toContain('swap floor price is static')
  })
  it('a swap permission without a swap policy is advisory only', () => {
    const adv = explainMandate(mandate([swapPerm]), { policy: policy(), now: NOW })
    expect(adv.enforcement[0]?.level).toBe('advisory (integrator must call verify)')
    expect(adv.can.some((c) => c.includes('advisory'))).toBe(true)
  })
})

describe('explainMandate: risky mandate without a relay policy', () => {
  const risky = mandate([
    {
      program: TOKEN_PROGRAM_ID,
      spendLimit: 0n,
      perTxLimit: 0n,
      discs: [TRANSFER_CHECKED_DISC, '0400000000000000', '0600000000000000', '0900000000000000'],
    },
  ])
  const e = explainMandate(risky, { now: NOW })
  it('everything is advisory and the headline says so', () => {
    expect(e.enforcement.every((x) => x.level === 'advisory (integrator must call verify)')).toBe(
      true,
    )
    expect(e.headline).toMatch(/Nothing is hard-enforced \(no relay policy\)\.$/)
    expect(joined(e.warnings)).toContain(
      'No relay policy was supplied or found for this mandate: nothing here is hard-enforced',
    )
  })
  it('warns on unlimited limits (0 on chain) and on default-deny instructions', () => {
    const w = joined(e.warnings)
    expect(w).toContain('lifetime limit is UNLIMITED (0 on chain)')
    expect(w).toContain('per-call limit is UNLIMITED (0 on chain)')
    expect(w).toContain('"Approve delegate" is classified authority_change')
    expect(w).toContain('"Set authority" is classified authority_change')
    expect(w).toContain('"Close account" is classified account_close')
    expect(w).not.toContain('"Transfer (checked)" is classified')
  })
  it('limits show unlimited explicitly', () => {
    expect(e.limits[0]).toMatchObject({
      spendLimit: 'unlimited',
      perTxLimit: 'unlimited',
      remaining: 'unlimited',
    })
    expect(e.limits[0]?.text).toContain('no per-call limit; no lifetime limit')
  })
  it('flags unknown instructions as not in the registry rather than inventing a name', () => {
    const u = explainMandate(
      mandate([
        { program: fakeAddress(0x61), spendLimit: 1n, perTxLimit: 1n, discs: ['aabbccddeeff0011'] },
      ]),
      { now: NOW },
    )
    expect(u.grants[0]).toContain('instruction 0xaabbccddeeff0011 (not in the registry)')
  })
  it('uses a supplied registry for names and risk classes', () => {
    const registry: RegistryLike = {
      getProgramById: (id) =>
        id === fakeAddress(0x61)
          ? {
              name: 'Lend',
              instructions: [
                {
                  name: 'withdraw_all',
                  title: 'Withdraw everything',
                  disc8: 'aabbccddeeff0011',
                  risk: 'admin',
                },
              ],
            }
          : null,
    }
    const u = explainMandate(
      mandate([
        { program: fakeAddress(0x61), spendLimit: 1n, perTxLimit: 1n, discs: ['aabbccddeeff0011'] },
      ]),
      { now: NOW, registry },
    )
    expect(u.grants[0]).toContain('Withdraw everything')
    expect(joined(u.warnings)).toContain('classified admin')
  })
  it('a broken registry degrades to unknown instead of throwing', () => {
    const registry: RegistryLike = {
      getProgramById: () => {
        throw new Error('boom')
      },
    }
    expect(() => explainMandate(risky, { now: NOW, registry })).not.toThrow()
  })
  it('an empty discriminator list is called out', () => {
    const u = explainMandate(
      mandate([{ program: fakeAddress(0x61), spendLimit: 1n, perTxLimit: 1n, discs: [] }]),
      { now: NOW },
    )
    expect(joined(u.warnings)).toContain('allows nothing')
  })
})

describe('explainMandate: status', () => {
  it('paused', () => {
    const e = explainMandate(mandate([tokenPerm], { active: false }), {
      policy: policy(),
      now: NOW,
    })
    expect(e.status).toBe('paused')
    expect(e.can).toEqual([])
    expect(e.cannot[0]).toBe(
      'Anything right now: the mandate is paused, so verify fails with NotActive until the owner resumes it.',
    )
    expect(e.headline).toContain('(PAUSED)')
  })
  it('expired (now == expiry is expired)', () => {
    const e = explainMandate(mandate([tokenPerm]), { policy: policy(), now: EXPIRY })
    expect(e.status).toBe('expired')
    expect(e.expiry.expired).toBe(true)
    expect(e.can).toEqual([])
    expect(e.cannot[0]).toContain('has expired')
    expect(e.cannot[0]).toContain('Expiry cannot be extended')
    expect(e.headline).toContain('(EXPIRED)')
    expect(e.headline).toContain('expired 2027-01-22')
  })
  it('one second before expiry is still active; relative time is in seconds', () => {
    const e = explainMandate(mandate([tokenPerm]), { now: EXPIRY - 1n })
    expect(e.status).toBe('active')
    expect(e.expiry.relative).toBe('in 1 second')
  })
  it('expired mandates read "... ago"', () => {
    expect(explainMandate(mandate([tokenPerm]), { now: EXPIRY + 3n * 3600n }).expiry.relative).toBe(
      '3 hours ago',
    )
  })
  it('expired beats paused in the status', () => {
    expect(explainMandate(mandate([tokenPerm], { active: false }), { now: EXPIRY }).status).toBe(
      'expired',
    )
  })
  it('a paused relay policy removes the relay payment from `can`', () => {
    const e = explainMandate(mandate([tokenPerm]), {
      policy: policy({ paused: true, flags: 3 }),
      now: NOW,
    })
    expect(e.can).toEqual([])
    expect(joined(e.cannot)).toContain('relay policy is paused')
    expect(joined(e.warnings)).toContain('The relay policy is paused')
  })
  it('stale policy, STRICT_TOP_LEVEL off, wrong delegate, legacy version, owner == agent, > 1 year', () => {
    const e = explainMandate(mandate([tokenPerm], { version: 0, expiry: NOW + 400n * 86400n }), {
      policy: policy({ strictTopLevel: false, mandateExpiry: 1n }),
      now: NOW,
      delegation: { delegate: null, delegatedAmount: 0n },
    })
    const w = joined(e.warnings)
    expect(w).toContain('STRICT_TOP_LEVEL is off')
    expect(w).toContain('StalePolicy (118)')
    expect(w).toContain('is not the relay authority')
    expect(w).toContain('legacy (pre-hardening, version 0)')
    expect(w).toContain('more than a year')
  })
  it('without a live delegation reading, says so', () => {
    expect(
      joined(explainMandate(mandate([tokenPerm]), { policy: policy(), now: NOW }).warnings),
    ).toContain('live SPL delegation was not provided')
  })
  it('accepts a Date for now', () => {
    expect(explainMandate(mandate([tokenPerm]), { now: new Date(Number(NOW) * 1000) }).status).toBe(
      'active',
    )
  })
  it('is pure: same input, same output', () => {
    const m = mandate([tokenPerm, swapPerm])
    const a = JSON.stringify(explainMandate(m, { policy: policy({}, true), now: NOW }), (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    const b = JSON.stringify(explainMandate(m, { policy: policy({}, true), now: NOW }), (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    expect(a).toBe(b)
  })
})
