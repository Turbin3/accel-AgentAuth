import { describe, expect, it } from 'vitest'
import {
  SWAP_BASE_INPUT_DISC,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  checkMint,
  checkRelaySwap,
  checkRelayTransfer,
  checkTokenAccountShape,
  decodeMint,
  decodeMandate,
  decodeTokenAccount,
  type Mandate,
  type PreflightFailure,
  type RawAccount,
  type RelayPolicy,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, raw } from './helpers'
import type { Address } from '@solana/kit'

const owner = fakeAddress(0x01)
const agent = fakeAddress(0x02)
const mandateKey = fakeAddress(0x03)
const authority = fakeAddress(0x04)
const mint = fakeAddress(0x05)
const source = fakeAddress(0x06)
const dest = fakeAddress(0x07)
const amm = fakeAddress(0x08)
const outMint = fakeAddress(0x09)
const outAcc = fakeAddress(0x0a)
const EXPIRY = 5_000n

function tokenAccount(o: {
  mint: Address
  owner: Address
  amount: bigint
  delegate?: Address
  delegated?: bigint
  state?: number
  len?: number
}): Uint8Array {
  const b = new Uint8Array(o.len ?? 165)
  const dv = new DataView(b.buffer)
  b.set(raw(o.mint), 0)
  b.set(raw(o.owner), 32)
  dv.setBigUint64(64, o.amount, true)
  if (o.delegate) {
    dv.setUint32(72, 1, true)
    b.set(raw(o.delegate), 76)
    dv.setBigUint64(121, o.delegated ?? 0n, true)
  }
  b[108] = o.state ?? 1
  if (b.length === 170) {
    b[165] = 2
    b.set([7, 0, 0, 0], 166)
  }
  return b
}
function mintData(decimals = 6, init = 1, len = 82): Uint8Array {
  const b = new Uint8Array(len)
  b[44] = decimals
  b[45] = init
  return b
}
function acct(
  address: Address,
  data: Uint8Array,
  ownerProgram: Address = TOKEN_PROGRAM_ID,
): RawAccount {
  return { address, ownerProgram, data, lamports: 1n, executable: false }
}

const policy: RelayPolicy = {
  address: fakeAddress(0x0b),
  version: 1,
  policyBump: 255,
  authorityBump: 254,
  flags: 2,
  paused: false,
  strictTopLevel: true,
  mandate: mandateKey,
  owner,
  agent,
  authority,
  mandateExpiry: EXPIRY,
  tokenProgram: TOKEN_PROGRAM_ID,
  budgetMint: mint,
  sourceAccount: source,
  recipients: [dest, fakeAddress(0x0c)],
  swap: {
    ammProgram: amm,
    ammAuthority: fakeAddress(0x10),
    ammConfig: fakeAddress(0x11),
    poolState: fakeAddress(0x12),
    inputVault: fakeAddress(0x13),
    outputVault: fakeAddress(0x14),
    observationState: fakeAddress(0x15),
    inMint: mint,
    outMint,
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    inAccount: source,
    outAccount: outAcc,
    floorOut: 95n,
    floorIn: 100n,
    maxDeadlineSlots: 150,
  },
}

function mk(
  over: {
    active?: boolean
    expiry?: bigint
    spendTotal?: bigint
    ammSpent?: bigint
    agentKey?: Address
  } = {},
): Mandate {
  return decodeMandate(
    encodeMandateBytes({
      owner,
      agent: over.agentKey ?? agent,
      expiry: over.expiry ?? EXPIRY,
      active: over.active,
      permissions: [
        {
          program: TOKEN_PROGRAM_ID,
          spendLimit: 10_000_000n,
          perTxLimit: 5_000_000n,
          spendTotal: over.spendTotal ?? 0n,
          discs: [TRANSFER_CHECKED_DISC],
        },
        {
          program: amm,
          spendLimit: 10_000_000n,
          perTxLimit: 5_000_000n,
          spendTotal: over.ammSpent ?? 0n,
          discs: [SWAP_BASE_INPUT_DISC],
        },
      ],
    }),
  )
}

const goodTokens = () => ({
  mint: acct(mint, mintData()),
  source: acct(
    source,
    tokenAccount({ mint, owner, amount: 9_000_000n, delegate: authority, delegated: 6_000_000n }),
  ),
  destination: acct(dest, tokenAccount({ mint, owner: fakeAddress(0x77), amount: 0n })),
})

type TOver = Partial<ReturnType<typeof goodTokens>>
function transfer(
  over: {
    policy?: RelayPolicy | null
    mandate?: Mandate | null
    tokens?: TOver
    amount?: bigint
    destination?: Address
    signed?: boolean
    now?: bigint
    stack?: number
    accounts?: object
  } = {},
) {
  return checkRelayTransfer(
    over.policy === undefined ? policy : over.policy,
    over.mandate === undefined ? mk() : over.mandate,
    { ...goodTokens(), ...over.tokens },
    {
      agent,
      amount: over.amount ?? 3_000_000n,
      destination: over.destination ?? dest,
      now: over.now ?? 1_000n,
      agentIsSigner: over.signed,
      stackHeight: over.stack,
      accounts: over.accounts,
    },
  )
}
const fails = (r: { ok: boolean }): PreflightFailure => {
  expect(r.ok).toBe(false)
  return r as PreflightFailure
}

describe('checkRelayTransfer (RELAY-SPEC 7.4 order)', () => {
  it('happy path returns the verify outcome', () => {
    const r = transfer()
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.verify).toMatchObject({ newSpendTotal: 3_000_000n, remainingSpend: 7_000_000n })
  })

  const cases: [
    string,
    () => ReturnType<typeof transfer>,
    'relay' | 'agent_auth' | 'token',
    number,
  ][] = [
    ['zero amount => 100', () => transfer({ amount: 0n }), 'relay', 100],
    ['agent did not sign => 107', () => transfer({ signed: false }), 'relay', 107],
    [
      'wrong agentauth program => 103',
      () => transfer({ accounts: { agentAuthProgram: fakeAddress(0xee) } }),
      'relay',
      103,
    ],
    ['no policy => 101', () => transfer({ policy: null }), 'relay', 101],
    [
      'paused => 116',
      () => transfer({ policy: { ...policy, paused: true, flags: 3 } }),
      'relay',
      116,
    ],
    ['CPI with STRICT_TOP_LEVEL => 115', () => transfer({ stack: 2 }), 'relay', 115],
    [
      'paused beats top-level (116 before 115)',
      () => transfer({ policy: { ...policy, paused: true, flags: 3 }, stack: 2 }),
      'relay',
      116,
    ],
    ['revoked mandate => 117', () => transfer({ mandate: null }), 'relay', 117],
    [
      'mandate for another agent => 117',
      () => transfer({ mandate: mk({ agentKey: fakeAddress(0x66) }) }),
      'relay',
      117,
    ],
    [
      'policy bound to another mandate => 102',
      () => transfer({ accounts: { mandate: fakeAddress(0x99) } }),
      'relay',
      102,
    ],
    [
      'policy authority differs from the one passed => 102',
      () => transfer({ accounts: { authority: fakeAddress(0x98) } }),
      'relay',
      102,
    ],
    [
      'stale policy (expiry differs) => 118',
      () => transfer({ mandate: mk({ expiry: EXPIRY + 1n }) }),
      'relay',
      118,
    ],
    [
      'pinned source differs => 102',
      () => transfer({ accounts: { source: fakeAddress(0x97) } }),
      'relay',
      102,
    ],
    [
      'destination not allowlisted => 104',
      () => transfer({ destination: fakeAddress(0x96) }),
      'relay',
      104,
    ],
    [
      'destination equals source => 104',
      () => transfer({ destination: source, policy: { ...policy, recipients: [source] } }),
      'relay',
      104,
    ],
    [
      'mint not extension-free (len 83) => 103',
      () => transfer({ tokens: { mint: acct(mint, mintData(6, 1, 83)) } }),
      'relay',
      103,
    ],
    [
      'uninitialised mint => 103',
      () => transfer({ tokens: { mint: acct(mint, mintData(6, 0)) } }),
      'relay',
      103,
    ],
    [
      'source owned by another program => 103',
      () =>
        transfer({
          tokens: {
            source: acct(source, tokenAccount({ mint, owner, amount: 1n }), fakeAddress(0xaa)),
          },
        }),
      'relay',
      103,
    ],
    [
      'source frozen => 105',
      () =>
        transfer({
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner,
                amount: 9n,
                delegate: authority,
                delegated: 9_000_000n,
                state: 2,
              }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'source delegate is someone else => 105',
      () =>
        transfer({
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner,
                amount: 9_000_000n,
                delegate: fakeAddress(0x55),
                delegated: 6_000_000n,
              }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'source has no delegate => 105',
      () =>
        transfer({
          tokens: { source: acct(source, tokenAccount({ mint, owner, amount: 9_000_000n })) },
        }),
      'relay',
      105,
    ],
    [
      'delegated_amount < amount => 105',
      () =>
        transfer({
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner,
                amount: 9_000_000n,
                delegate: authority,
                delegated: 2_999_999n,
              }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'source owner field is not the policy owner => 105',
      () =>
        transfer({
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner: fakeAddress(0x55),
                amount: 9_000_000n,
                delegate: authority,
                delegated: 6_000_000n,
              }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'destination wrong mint => 105',
      () =>
        transfer({
          tokens: {
            destination: acct(dest, tokenAccount({ mint: fakeAddress(0x44), owner, amount: 0n })),
          },
        }),
      'relay',
      105,
    ],
    [
      'paused mandate => verify 4',
      () => transfer({ mandate: mk({ active: false }) }),
      'agent_auth',
      4,
    ],
    [
      'expired mandate (policy expiry equal) => verify 5',
      () => transfer({ now: EXPIRY }),
      'agent_auth',
      5,
    ],
    [
      'amount above per_tx => verify 8',
      () =>
        transfer({
          amount: 5_000_001n,
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner,
                amount: 9_000_000n,
                delegate: authority,
                delegated: 9_000_000n,
              }),
            ),
          },
        }),
      'agent_auth',
      8,
    ],
    [
      'lifetime budget used => verify 9',
      () => transfer({ mandate: mk({ spendTotal: 9_000_000n }) }),
      'agent_auth',
      9,
    ],
    [
      'balance too low => token InsufficientFunds (1)',
      () =>
        transfer({
          tokens: {
            source: acct(
              source,
              tokenAccount({
                mint,
                owner,
                amount: 2_999_999n,
                delegate: authority,
                delegated: 6_000_000n,
              }),
            ),
          },
        }),
      'token',
      1,
    ],
  ]
  it.each(cases)('%s', (_name, run, program, code) => {
    const f = fails(run())
    expect([f.program, f.code]).toEqual([program, code])
  })

  it('Token-2022 ImmutableOwner shape (170 bytes) is accepted, other shapes are not', () => {
    const p22: RelayPolicy = { ...policy, tokenProgram: TOKEN_2022_PROGRAM_ID }
    const m22 = decodeMandate(
      encodeMandateBytes({
        owner,
        agent,
        expiry: EXPIRY,
        permissions: [
          {
            program: TOKEN_2022_PROGRAM_ID,
            spendLimit: 9_000_000n,
            perTxLimit: 9_000_000n,
            discs: [TRANSFER_CHECKED_DISC],
          },
        ],
      }),
    )
    const tokens = (len: number) => ({
      mint: acct(mint, mintData(), TOKEN_2022_PROGRAM_ID),
      source: acct(
        source,
        tokenAccount({
          mint,
          owner,
          amount: 9n * 10n ** 6n,
          delegate: authority,
          delegated: 6_000_000n,
          len,
        }),
        TOKEN_2022_PROGRAM_ID,
      ),
      destination: acct(
        dest,
        tokenAccount({ mint, owner: fakeAddress(0x77), amount: 0n, len }),
        TOKEN_2022_PROGRAM_ID,
      ),
    })
    expect(transfer({ policy: p22, mandate: m22, tokens: tokens(170) }).ok).toBe(true)
    expect(transfer({ policy: p22, mandate: m22, tokens: tokens(165) }).ok).toBe(true)
    expect(fails(transfer({ policy: p22, mandate: m22, tokens: tokens(171) })).code).toBe(105)
    // 170 bytes is only legal for Token-2022
    const classic = acct(source, tokenAccount({ mint, owner, amount: 1n, len: 170 }))
    expect(checkTokenAccountShape(classic, TOKEN_PROGRAM_ID)).toEqual({ ok: false, code: 105 })
  })
})

describe('checkRelaySwap (RELAY-SPEC 7.5 order)', () => {
  const swapTokens = () => ({
    inMint: acct(mint, mintData()),
    outMint: acct(outMint, mintData(9)),
    inAccount: acct(
      source,
      tokenAccount({ mint, owner, amount: 9_000_000n, delegate: authority, delegated: 6_000_000n }),
    ),
    outAccount: acct(outAcc, tokenAccount({ mint: outMint, owner, amount: 0n })),
  })
  function swap(
    over: {
      policy?: RelayPolicy | null
      mandate?: Mandate | null
      tokens?: Partial<ReturnType<typeof swapTokens>>
      amountIn?: bigint
      minOut?: bigint
      deadline?: bigint
      slot?: bigint
      allow?: Address[]
      accounts?: object
    } = {},
  ) {
    return checkRelaySwap(
      over.policy === undefined ? policy : over.policy,
      over.mandate === undefined ? mk() : over.mandate,
      { ...swapTokens(), ...over.tokens },
      {
        agent,
        amountIn: over.amountIn ?? 5_000_000n,
        minOut: over.minOut ?? 0n,
        deadlineSlot: over.deadline ?? 1_100n,
        currentSlot: over.slot ?? 1_000n,
        now: 1_000n,
        ammAllowlist: over.allow ?? [amm],
        accounts: over.accounts,
      },
    )
  }

  it('happy path computes the floor: ceil(5_000_000 * 95 / 100) = 4_750_000', () => {
    const r = swap()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.requiredMinOut).toBe(4_750_000n)
      expect(r.effectiveMinOut).toBe(4_750_000n)
    }
  })
  it('agent min_out above the floor wins; below the floor is raised to it', () => {
    const hi = swap({ minOut: 4_900_000n })
    if (hi.ok) expect(hi.effectiveMinOut).toBe(4_900_000n)
    const lo = swap({ minOut: 1n })
    if (lo.ok) expect(lo.effectiveMinOut).toBe(4_750_000n)
  })
  it('floor is rounded UP', () => {
    const r = swap({
      amountIn: 1n,
      policy: { ...policy, swap: { ...policy.swap!, floorOut: 1n, floorIn: 3n } },
    })
    if (r.ok) expect(r.requiredMinOut).toBe(1n)
    else throw new Error('expected ok')
  })

  const cases: [string, () => ReturnType<typeof swap>, 'relay' | 'agent_auth', number][] = [
    ['zero amount_in => 100', () => swap({ amountIn: 0n }), 'relay', 100],
    ['swap disabled => 110', () => swap({ policy: { ...policy, swap: null } }), 'relay', 110],
    ['deadline in the past => 111', () => swap({ deadline: 999n }), 'relay', 111],
    ['deadline = current slot is fine', () => swap({ deadline: 1_000n }), 'relay', 0],
    ['deadline beyond window => 111', () => swap({ deadline: 1_151n }), 'relay', 111],
    ['deadline at the window edge is fine', () => swap({ deadline: 1_150n }), 'relay', 0],
    ['amm not in allowlist => 103', () => swap({ allow: [fakeAddress(0xdd)] }), 'relay', 103],
    [
      'pinned pool differs => 102',
      () => swap({ accounts: { poolState: fakeAddress(0xdd) } }),
      'relay',
      102,
    ],
    [
      'out mint not extension-free => 103',
      () => swap({ tokens: { outMint: acct(outMint, mintData(9, 1, 100)) } }),
      'relay',
      103,
    ],
    [
      'output account not owned by the owner => 105 (output must land in the owner account)',
      () =>
        swap({
          tokens: {
            outAccount: acct(
              outAcc,
              tokenAccount({ mint: outMint, owner: fakeAddress(0x33), amount: 0n }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'input balance below amount_in => 105',
      () =>
        swap({
          tokens: {
            inAccount: acct(
              source,
              tokenAccount({ mint, owner, amount: 1n, delegate: authority, delegated: 6_000_000n }),
            ),
          },
        }),
      'relay',
      105,
    ],
    [
      'floor overflow => 114',
      () =>
        swap({
          policy: { ...policy, swap: { ...policy.swap!, floorOut: 2n ** 64n - 1n, floorIn: 1n } },
        }),
      'relay',
      114,
    ],
    [
      'lifetime budget used => verify 9',
      () => swap({ mandate: mk({ ammSpent: 6_000_000n }) }),
      'agent_auth',
      9,
    ],
  ]
  it.each(cases)('%s', (_name, run, program, code) => {
    const r = run()
    if (code === 0) {
      expect(r.ok).toBe(true)
      return
    }
    const f = fails(r)
    expect([f.program, f.code]).toEqual([program, code])
  })
})

describe('token state helpers', () => {
  it('decodeTokenAccount / decodeMint read the SPL offsets', () => {
    const t = decodeTokenAccount(
      tokenAccount({ mint, owner, amount: 42n, delegate: authority, delegated: 7n, state: 2 }),
    )
    expect(t).toMatchObject({
      mint,
      owner,
      amount: 42n,
      delegate: authority,
      delegatedAmount: 7n,
      state: 2,
      closeAuthority: null,
    })
    expect(() => decodeTokenAccount(new Uint8Array(164))).toThrow(/165/)
    const m = decodeMint(mintData(9))
    expect(m).toMatchObject({
      decimals: 9,
      isInitialized: true,
      mintAuthority: null,
      freezeAuthority: null,
    })
    expect(() => decodeMint(new Uint8Array(81))).toThrow(/82/)
  })
  it('checkMint', () => {
    expect(checkMint(acct(mint, mintData()), TOKEN_PROGRAM_ID)).toEqual({ ok: true })
    expect(checkMint(null, TOKEN_PROGRAM_ID)).toEqual({ ok: false, code: 103 })
    expect(checkMint(acct(mint, mintData(), TOKEN_2022_PROGRAM_ID), TOKEN_PROGRAM_ID)).toEqual({
      ok: false,
      code: 103,
    })
  })
})
