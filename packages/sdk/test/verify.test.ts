import { describe, expect, it } from 'vitest'
import {
  ValidationError,
  checkVerify,
  decodeMandate,
  preflightFailureToError,
  type Mandate,
  type PreflightFailure,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, type TestMandate, type TestPermission } from './helpers'

const owner = fakeAddress(0x01)
const agent = fakeAddress(0x02)
const prog = fakeAddress(0x03)
const other = fakeAddress(0x04)
const DISC = '0c00000000000000'
const OTHER_DISC = '0d00000000000000'
const U64 = 2n ** 64n - 1n
const EXPIRY = 1_000n

function perm(over: Partial<TestPermission> = {}): TestPermission {
  return {
    program: prog,
    spendLimit: 100n,
    perTxLimit: 40n,
    spendTotal: 0n,
    callCount: 0,
    discs: [DISC],
    ...over,
  }
}
function mandate(
  over: Partial<TestMandate> = {},
  permissions: TestPermission[] = [perm()],
): Mandate {
  return decodeMandate(encodeMandateBytes({ owner, agent, expiry: EXPIRY, permissions, ...over }))
}
const call = (
  over: Partial<Parameters<typeof checkVerify>[1]> = {},
): Parameters<typeof checkVerify>[1] => ({
  owner,
  agent,
  targetProgram: prog,
  discriminator: DISC,
  amount: 10n,
  ...over,
})

interface Row {
  name: string
  mandate: Mandate | null
  call?: Partial<Parameters<typeof checkVerify>[1]>
  now?: bigint
  signed?: boolean
  /** expected AgentAuth error code, or 0 for success */
  expect: number
}

const rows: Row[] = [
  // existence / status
  { name: 'missing mandate account', mandate: null, expect: 14 },
  { name: 'happy path', mandate: mandate(), expect: 0 },
  { name: 'paused', mandate: mandate({ active: false }), expect: 4 },
  {
    name: 'paused beats expired (order: 4 before 5)',
    mandate: mandate({ active: false }),
    now: EXPIRY + 5n,
    expect: 4,
  },
  // expiry boundary: expired iff now >= expiry
  { name: 'now = expiry - 1 is valid', mandate: mandate(), now: EXPIRY - 1n, expect: 0 },
  { name: 'now = expiry is EXPIRED', mandate: mandate(), now: EXPIRY, expect: 5 },
  { name: 'now = expiry + 1 is expired', mandate: mandate(), now: EXPIRY + 1n, expect: 5 },
  {
    name: 'expired beats wrong owner (5 before 2)',
    mandate: mandate(),
    now: EXPIRY,
    call: { owner: other },
    expect: 5,
  },
  {
    name: 'negative expiry (legacy) is expired',
    mandate: mandate({ expiry: -1n }),
    now: 0n,
    expect: 5,
  },
  // keys and signer
  { name: 'wrong owner key', mandate: mandate(), call: { owner: other }, expect: 2 },
  { name: 'wrong agent key', mandate: mandate(), call: { agent: other }, expect: 17 },
  {
    name: 'wrong owner and wrong agent: owner first',
    mandate: mandate(),
    call: { owner: other, agent: other },
    expect: 2,
  },
  { name: 'agent did not sign', mandate: mandate(), signed: false, expect: 18 },
  {
    name: 'unsigned agent beats missing program (18 before 6)',
    mandate: mandate(),
    signed: false,
    call: { targetProgram: other },
    expect: 18,
  },
  {
    name: 'wrong agent beats unsigned (17 before 18)',
    mandate: mandate(),
    signed: false,
    call: { agent: other },
    expect: 17,
  },
  // program slot
  { name: 'empty permission list: empty slot', mandate: mandate({}, []), expect: 6 },
  { name: 'program not in mandate', mandate: mandate(), call: { targetProgram: other }, expect: 6 },
  {
    name: 'second slot is found',
    mandate: mandate({}, [perm({ program: other }), perm()]),
    expect: 0,
  },
  // discriminator
  {
    name: 'discriminator miss',
    mandate: mandate(),
    call: { discriminator: OTHER_DISC },
    expect: 7,
  },
  {
    name: 'slot with an empty discriminator list allows nothing',
    mandate: mandate({}, [perm({ discs: [] })]),
    expect: 7,
  },
  {
    name: 'second discriminator of the slot',
    mandate: mandate({}, [perm({ discs: [OTHER_DISC, DISC] })]),
    expect: 0,
  },
  {
    name: 'discriminator as bytes',
    mandate: mandate(),
    call: { discriminator: Uint8Array.from([12, 0, 0, 0, 0, 0, 0, 0]) },
    expect: 0,
  },
  // per_tx
  { name: 'amount = per_tx is ok', mandate: mandate(), call: { amount: 40n }, expect: 0 },
  { name: 'amount = per_tx + 1 fails', mandate: mandate(), call: { amount: 41n }, expect: 8 },
  {
    name: 'per_tx unlimited accepts a huge amount (lifetime unlimited too)',
    mandate: mandate({}, [perm({ perTxLimit: 0n, spendLimit: 0n })]),
    call: { amount: U64 },
    expect: 0,
  },
  { name: 'amount 0 is allowed', mandate: mandate(), call: { amount: 0n }, expect: 0 },
  // lifetime
  {
    name: 'spend_total + amount = limit is ok',
    mandate: mandate({}, [perm({ spendTotal: 60n })]),
    call: { amount: 40n },
    expect: 0,
  },
  {
    name: 'spend_total + amount = limit + 1 with amount > per_tx: per_tx fails first',
    mandate: mandate({}, [perm({ spendTotal: 60n })]),
    call: { amount: 41n },
    expect: 8,
  },
  {
    name: 'lifetime exceeded with per_tx unlimited',
    mandate: mandate({}, [perm({ perTxLimit: 0n, spendTotal: 60n })]),
    call: { amount: 41n },
    expect: 9,
  },
  {
    name: 'per_tx is checked before lifetime (8 before 9)',
    mandate: mandate({}, [perm({ spendTotal: 90n })]),
    call: { amount: 41n },
    expect: 8,
  },
  {
    name: 'spend_total + amount = limit + 1 with amount <= per_tx fails lifetime',
    mandate: mandate({}, [perm({ spendTotal: 61n })]),
    call: { amount: 40n },
    expect: 9,
  },
  {
    name: 'exhausted budget, amount within per_tx',
    mandate: mandate({}, [perm({ spendTotal: 100n })]),
    call: { amount: 1n },
    expect: 9,
  },
  {
    name: 'exhausted budget, amount 0 still ok',
    mandate: mandate({}, [perm({ spendTotal: 100n })]),
    call: { amount: 0n },
    expect: 0,
  },
  {
    name: 'limit lowered below spend_total blocks everything but 0',
    mandate: mandate({}, [perm({ spendTotal: 150n })]),
    call: { amount: 1n },
    expect: 9,
  },
  {
    name: 'limited permission: spend_total + amount overflows u64 => 9',
    mandate: mandate({}, [perm({ spendLimit: U64, perTxLimit: 0n, spendTotal: U64 })]),
    call: { amount: 1n },
    expect: 9,
  },
  {
    name: 'limited permission at u64::MAX limit: exactly reaching the limit is ok',
    mandate: mandate({}, [perm({ spendLimit: U64, perTxLimit: 0n, spendTotal: U64 - 5n })]),
    call: { amount: 5n },
    expect: 0,
  },
  {
    name: 'unlimited permission saturates instead of reverting',
    mandate: mandate({}, [perm({ spendLimit: 0n, perTxLimit: 0n, spendTotal: U64 - 1n })]),
    call: { amount: 5n },
    expect: 0,
  },
  {
    name: 'unlimited lifetime with per_tx limit still enforces per_tx',
    mandate: mandate({}, [perm({ spendLimit: 0n })]),
    call: { amount: 41n },
    expect: 8,
  },
]

describe('checkVerify truth table (mirror of idl/core-idl.json verify.checks)', () => {
  it.each(rows)('$name', (row) => {
    const res = checkVerify(row.mandate, call(row.call), {
      now: row.now ?? 500n,
      agentIsSigner: row.signed,
    })
    if (row.expect === 0) {
      expect(
        res.ok,
        JSON.stringify(res, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ).toBe(true)
    } else {
      expect(res.ok).toBe(false)
      const f = res as PreflightFailure
      expect(f.program).toBe('agent_auth')
      expect(f.code).toBe(row.expect)
    }
  })

  it('success reports the booked counters and the remaining budget', () => {
    const res = checkVerify(
      mandate({}, [perm({ spendTotal: 30n, callCount: 2 })]),
      call({ amount: 25n }),
      { now: 1n },
    )
    expect(res).toMatchObject({
      ok: true,
      newSpendTotal: 55n,
      newCallCount: 3,
      remainingSpend: 45n,
      permissionIndex: 0,
    })
  })

  it('saturating counters on an unlimited permission', () => {
    const res = checkVerify(
      mandate({}, [
        perm({ spendLimit: 0n, perTxLimit: 0n, spendTotal: U64 - 1n, callCount: 4_294_967_295 }),
      ]),
      call({ amount: 5n }),
      { now: 1n },
    )
    expect(res).toMatchObject({
      ok: true,
      newSpendTotal: U64,
      newCallCount: 4_294_967_295,
      remainingSpend: null,
    })
  })

  it('now accepts a number and a bigint identically', () => {
    expect(checkVerify(mandate(), call(), { now: 999 }).ok).toBe(true)
    expect(checkVerify(mandate(), call(), { now: 1000 }).ok).toBe(false)
  })

  it('malformed calls throw ValidationError instead of guessing', () => {
    expect(() => checkVerify(mandate(), call({ amount: -1n }), { now: 1n })).toThrow(
      ValidationError,
    )
    expect(() => checkVerify(mandate(), call({ amount: U64 + 1n }), { now: 1n })).toThrow(
      ValidationError,
    )
    expect(() => checkVerify(mandate(), call({ discriminator: '0c' }), { now: 1n })).toThrow(
      ValidationError,
    )
    expect(() =>
      checkVerify(mandate(), call({ discriminator: 'zz00000000000000' }), { now: 1n }),
    ).toThrow(ValidationError)
  })

  it('a failure converts to the same AgentAuthError an on-chain failure produces', () => {
    const res = checkVerify(mandate(), call({ amount: 41n }), { now: 1n }) as PreflightFailure
    const err = preflightFailureToError(res)
    expect(err.program).toBe('agent_auth')
    expect(err.code).toBe(8)
    expect(err.name).toBe('PerTxExceeded')
    expect(err.retryable).toBe(true)
  })

  it('is pure: the mandate is not mutated', () => {
    const m = mandate()
    const before = JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    checkVerify(m, call(), { now: 1n })
    expect(JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before)
  })
})
