import { describe, expect, it } from 'vitest'
import { createNoopSigner, generateKeyPairSigner, type Address } from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  AgentAuthError,
  MOCK_AMM_PROGRAM_ID,
  PlanRefusedError,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  ValidationError,
  assertMandateAuthorises,
  builtinRegistry,
  capacity,
  checkExpiry,
  compileUnsigned,
  createClient,
  createMandateIx,
  decodeMandate,
  decodeTransaction,
  defaultAmmAllowlist,
  estimateTransactionSize,
  expiresIn,
  explainMandate,
  fetchMandate,
  fetchRelayPolicy,
  getActivityPage,
  mandatePda,
  parseExpiry,
  parseLimitInput,
  parseProgramError,
  parseUnits,
  planOnboarding,
  planRevokeDiscriminator,
  planRevokePermission,
  planToJson,
  planToUnsignedTransactions,
  planUnwind,
  relayAuthorityPda,
  relayPolicyPda,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  sendAndConfirmStep,
  simulateStep,
  stripSigners,
  toJsonSafe,
  type AgentAuthRpc,
  type Mandate,
  type OnboardingInput,
  type Plan,
  type RelayPolicy,
} from '../src/index'
import { encodeMandateBytes, fakeAddress, hex, raw, type TestPermission } from './helpers'

const owner = fakeAddress(0x21)
const agent = fakeAddress(0x22)
const mint = fakeAddress(0x26)
const source = fakeAddress(0x27)
const dest = fakeAddress(0x28)
const NOW = 1_800_000_000n
const EXPIRY = NOW + 7n * 86_400n
const MANDATE_ADDR = fakeAddress(0x25)
const AUTHORITY = fakeAddress(0x23)
const BLOCKHASH = {
  blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4',
  lastValidBlockHeight: 99n,
}

const tokenPerm: TestPermission = {
  program: TOKEN_PROGRAM_ID,
  spendLimit: 5_000_000n,
  perTxLimit: 1_000_000n,
  discs: [TRANSFER_CHECKED_DISC],
}

function mandate(
  perms: TestPermission[],
  over: { active?: boolean; expiry?: bigint } = {},
): Mandate {
  return decodeMandate(
    encodeMandateBytes({
      owner,
      agent,
      expiry: over.expiry ?? EXPIRY,
      active: over.active,
      permissions: perms,
    }),
    MANDATE_ADDR,
  )
}

function policy(over: Partial<RelayPolicy> = {}): RelayPolicy {
  return {
    address: fakeAddress(0x24),
    version: 1,
    policyBump: 255,
    authorityBump: 254,
    flags: 2,
    paused: false,
    strictTopLevel: true,
    mandate: MANDATE_ADDR,
    owner,
    agent,
    authority: AUTHORITY,
    mandateExpiry: EXPIRY,
    tokenProgram: TOKEN_PROGRAM_ID,
    budgetMint: mint,
    sourceAccount: source,
    recipients: [dest],
    swap: null,
    ...over,
  }
}

const DELEG = { delegate: AUTHORITY, delegatedAmount: 3_000_000n }

describe('F01 explainMandate never lists a relay payment under `can` that the relay would reject', () => {
  const canText = (m: Mandate, p: RelayPolicy, delegation: typeof DELEG | null = DELEG) =>
    explainMandate(m, { policy: p, delegation, now: NOW, mandateAddress: MANDATE_ADDR })

  it('baseline: hard payment is listed under can', () => {
    const e = canText(mandate([tokenPerm]), policy())
    expect(e.can.join('\n')).toContain('Pay token')
    expect(e.can.join('\n')).toContain('hard-enforced')
    expect(e.enforcement.some((r) => r.level === 'hard (relay)')).toBe(true)
  })

  it('A: token slot with only legacy Transfer(3) -> cannot (verify 7), no hard row', () => {
    const e = canText(mandate([{ ...tokenPerm, discs: ['0300000000000000'] }]), policy())
    expect(e.can.join('\n')).not.toContain('Pay token')
    expect(e.cannot.join('\n')).toMatch(/Pay token[\s\S]*DiscriminatorNotAllowed \(7\)/)
    expect(e.enforcement.every((r) => r.level !== 'hard (relay)')).toBe(true)
  })

  it('B: no token permission at all -> ProgramNotAllowed (6)', () => {
    const e = canText(mandate([{ ...tokenPerm, program: fakeAddress(0x99) }]), policy())
    expect(e.can.join('\n')).not.toContain('Pay token')
    expect(e.cannot.join('\n')).toMatch(/ProgramNotAllowed \(6\)/)
  })

  it('C: stale policy (expiry differs) -> StalePolicy (118)', () => {
    const e = canText(mandate([tokenPerm]), policy({ mandateExpiry: EXPIRY - 1n }))
    expect(e.can.join('\n')).not.toContain('Pay token')
    expect(e.cannot.join('\n')).toMatch(/StalePolicy \(118\)/)
  })

  it('D: policy bound to another mandate / agent -> AccountMismatch (102)', () => {
    const other = canText(mandate([tokenPerm]), policy({ mandate: fakeAddress(0x77) }))
    expect(other.can.join('\n')).not.toContain('Pay token')
    expect(other.cannot.join('\n')).toMatch(/\(102\)/)
    const otherAgent = canText(mandate([tokenPerm]), policy({ agent: fakeAddress(0x78) }))
    expect(otherAgent.can.join('\n')).not.toContain('Pay token')
    expect(otherAgent.enforcement.every((r) => r.level !== 'hard (relay)')).toBe(true)
  })

  it('E: lifetime budget exhausted -> SpendLimitExceeded (9)', () => {
    const e = canText(mandate([{ ...tokenPerm, spendTotal: 5_000_000n }]), policy())
    expect(e.can.join('\n')).not.toContain('Pay token')
    expect(e.cannot.join('\n')).toMatch(/SpendLimitExceeded \(9\)/)
  })

  it('F: delegation revoked or foreign -> TokenAccountState (105)', () => {
    const revoked = canText(mandate([tokenPerm]), policy(), {
      delegate: null as never,
      delegatedAmount: 0n,
    })
    expect(revoked.can.join('\n')).not.toContain('Pay token')
    expect(revoked.cannot.join('\n')).toMatch(/\(105\)/)
    const foreign = canText(mandate([tokenPerm]), policy(), {
      delegate: fakeAddress(0x55),
      delegatedAmount: 9n,
    })
    expect(foreign.cannot.join('\n')).toMatch(/\(105\)/)
  })

  it('unknown delegation is labelled unverified instead of claimed', () => {
    const e = canText(mandate([tokenPerm]), policy(), null)
    expect(e.can.join('\n')).toContain('unverified: the SPL delegation was not read')
  })

  it('paused relay -> Paused (116)', () => {
    const e = canText(mandate([tokenPerm]), policy({ paused: true }))
    expect(e.cannot.join('\n')).toMatch(/Paused \(116\)/)
  })
})

describe('F02 dusted PDAs are "not created", not errors', () => {
  const dusted = new Set<string>()
  const accounts = new Map<string, { owner: string; data: Uint8Array; lamports: bigint }>()
  const mk = (a: string) => {
    const acc = accounts.get(a)
    return acc
      ? {
          owner: acc.owner,
          data: [Buffer.from(acc.data).toString('base64'), 'base64'],
          lamports: acc.lamports,
          executable: false,
          space: BigInt(acc.data.length),
          rentEpoch: 0n,
        }
      : null
  }
  const rpc = {
    getAccountInfo: (a: string) => ({ send: async () => ({ value: mk(a) }) }),
    getMultipleAccounts: (l: string[]) => ({ send: async () => ({ value: l.map(mk) }) }),
    getProgramAccounts: () => ({ send: async () => [] }),
    getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
    getSlot: () => ({ send: async () => 1n }),
  } as unknown as AgentAuthRpc

  it('fetchMandate / fetchRelayPolicy return null for a system-owned zero-data account', async () => {
    const m = await mandatePda(owner, agent)
    const p = await relayPolicyPda(m.address)
    accounts.set(m.address, {
      owner: SYSTEM_PROGRAM_ID,
      data: new Uint8Array(0),
      lamports: 890_880n,
    })
    accounts.set(p.address, {
      owner: SYSTEM_PROGRAM_ID,
      data: new Uint8Array(0),
      lamports: 5_445_760n,
    })
    dusted.add(m.address)
    expect(await fetchMandate(rpc, m.address)).toBeNull()
    expect(await fetchRelayPolicy(rpc, p.address)).toBeNull()
  })

  it('every client.plan.* path and inspect keep working on a dusted policy PDA', async () => {
    const m = await mandatePda(owner, agent)
    const p = await relayPolicyPda(m.address)
    accounts.clear()
    accounts.set(m.address, {
      owner: AGENT_AUTH_PROGRAM_ID,
      data: encodeMandateBytes({
        owner,
        agent,
        expiry: EXPIRY,
        bump: m.bump,
        permissions: [tokenPerm],
      }),
      lamports: 1n,
    })
    accounts.set(p.address, {
      owner: SYSTEM_PROGRAM_ID,
      data: new Uint8Array(0),
      lamports: 5_445_760n,
    })
    const client = createClient({ rpc })
    const base = { owner, agent }
    expect((await client.plan.unwind(base)).steps.length).toBeGreaterThan(0)
    expect((await client.plan.pause(base)).steps.length).toBe(1)
    expect((await client.plan.resume(base)).steps.length).toBe(1)
    expect(
      (await client.plan.revokePermission({ ...base, program: TOKEN_PROGRAM_ID })).steps.length,
    ).toBe(1)
    expect(
      (
        await client.plan.updateLimits({
          ...base,
          program: TOKEN_PROGRAM_ID,
          spendLimit: 9n,
          perTxLimit: 3n,
        })
      ).steps.length,
    ).toBe(1)
    await expect(client.plan.closePolicy(base)).rejects.toBeInstanceOf(PlanRefusedError)
    expect(await client.fetchPolicy(m.address)).toBeNull()
    expect((await client.inspect(m.address, { now: NOW })).policy).toBeNull()
    // a revoked + dusted mandate is simply missing
    accounts.set(m.address, {
      owner: SYSTEM_PROGRAM_ID,
      data: new Uint8Array(0),
      lamports: 890_880n,
    })
    expect((await client.fetchMandateFor(owner, agent)).mandate).toBeNull()
    expect((await client.inspect(m.address)).mandate).toBeNull()
  })

  it('client.plan.* fails loudly when the mandate cannot be located', async () => {
    const client = createClient({ rpc })
    await expect(client.plan.unwind({ owner })).rejects.toMatchObject({ code: 'MISSING_ADDRESS' })
  })
})

const tokenAccountView = (delegate: Address | null) => ({
  mint,
  owner,
  amount: 1n,
  delegate,
  state: 1,
  delegatedAmount: 5n,
  closeAuthority: null,
})

function onboarding(over: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    owner,
    agent,
    expiry: EXPIRY,
    now: NOW,
    fundAgentLamports: 10_000_000n,
    token: { mint, source, delegateCap: 5_000_000n },
    permissions: [
      {
        program: TOKEN_PROGRAM_ID,
        spendLimit: 5_000_000n,
        perTxLimit: 1_000_000n,
        discriminators: [TRANSFER_CHECKED_DISC],
      },
    ],
    recipients: [dest],
    ...over,
  }
}
const refusal = async (p: Promise<Plan>): Promise<string> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(PlanRefusedError)
    return (e as PlanRefusedError).reasons.join(' | ')
  }
  throw new Error('not refused')
}

describe('F04 expiry unit trap', () => {
  it('milliseconds are refused by plans and builders', async () => {
    expect(
      await refusal(planOnboarding(onboarding({ expiry: NOW * 1000n + 86_400_000n }))),
    ).toMatch(/MILLISECONDS/)
    await expect(createMandateIx({ owner, agent, expiry: NOW * 1000n })).rejects.toMatchObject({
      code: 'BAD_EXPIRY',
    })
  })
  it('huge expiries do not crash with RangeError', async () => {
    for (const expiry of [2n ** 62n, 2n ** 63n - 1n, 9_000_000_000_000n]) {
      expect(await refusal(planOnboarding(onboarding({ expiry })))).toMatch(/MILLISECONDS|2100/)
    }
  })
  it('more than a year needs allowLongExpiry (and never beyond 2100)', async () => {
    const far = NOW + 2n * 365n * 86_400n
    expect(await refusal(planOnboarding(onboarding({ expiry: far })))).toMatch(/more than one year/)
    const plan = await planOnboarding(onboarding({ expiry: far, allowLongExpiry: true }))
    expect(plan.summary).toMatch(/expires 20\d\d-/)
    expect(
      await refusal(planOnboarding(onboarding({ expiry: 5_000_000_000n, allowLongExpiry: true }))),
    ).toMatch(/2100/)
  })
  it('expiresIn / parseExpiry / checkExpiry', () => {
    expect(expiresIn('7d', NOW)).toBe(NOW + 604_800n)
    expect(expiresIn(90, NOW)).toBe(NOW + 90n)
    expect(expiresIn('2w', NOW)).toBe(NOW + 1_209_600n)
    expect(() => expiresIn('7 days')).toThrow(ValidationError)
    expect(() => expiresIn(-5)).toThrow(ValidationError)
    expect(parseExpiry('2030-01-01T00:00:00Z')).toBe(1_893_456_000n)
    expect(parseExpiry('1900000000')).toBe(1_900_000_000n)
    expect(() => parseExpiry('1900000000000')).toThrow(/MILLISECONDS/)
    expect(() => parseExpiry('tomorrow')).toThrow(ValidationError)
    expect(checkExpiry(NOW - 1n, { now: NOW })[0]).toMatch(/after now/)
    expect(checkExpiry(EXPIRY, { now: NOW })).toEqual([])
  })
})

describe('F06 unwind never lets the cleanup revert the kill switch', () => {
  it('unknown chain state: kill switch alone first, cleanup second', async () => {
    const plan = await planUnwind({ owner, agent, tokenAccounts: [{ address: source }] })
    expect(plan.steps.map((s) => s.instructions.map((i) => i.data[0]))).toEqual([[4], [5, 2]])
  })
  it('skips Revoke when the current delegate is another mandate authority', async () => {
    const m = await mandatePda(owner, agent)
    const authority = (await relayAuthorityPda(m.address)).address
    const other = fakeAddress(0x66)
    const plan = await planUnwind({
      owner,
      agent,
      tokenAccounts: [{ address: source }, { address: other }, { address: dest }],
      chainState: {
        mandate: mandate([tokenPerm]),
        policy: null,
        tokenAccounts: {
          [source]: tokenAccountView(authority),
          [other]: tokenAccountView(fakeAddress(0x67)),
          [dest]: tokenAccountView(null),
        },
      },
    })
    const tags = plan.steps.flatMap((s) => s.instructions.map((i) => i.data[0]))
    expect(tags.filter((t) => t === 5)).toHaveLength(1) // exactly one SPL Revoke (tag 5)
    expect(plan.warnings.join(' ')).toMatch(/not to this mandate's relay authority/)
  })
})

describe('F07/F08 error attribution and runtime errors', () => {
  const RAYDIUM = 'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW'
  it('a foreign origin whose code collides with a relay code is not shown as a relay error', () => {
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${RAYDIUM} invoke [2]`,
      `Program ${RAYDIUM} failed: custom program error: 0x66`,
      `Program ${RELAY_PROGRAM_ID} failed: custom program error: 0x66`,
    ]
    const e = parseProgramError(logs)!
    expect(e.program).toBe('unknown')
    expect(e.programId).toBe(RAYDIUM)
    expect(e.code).toBe(102)
  })
  it('no-logs 100..103 is ambiguous (Anchor), 104..119 is relay', () => {
    expect(parseProgramError({ InstructionError: [0, { Custom: 102 }] })!.program).toBe('unknown')
    expect(parseProgramError({ InstructionError: [0, { Custom: 104 }] })!.program).toBe('relay')
  })
  it('runtime failures return an explained error', () => {
    const cases: [unknown, string][] = [
      [{ InstructionError: [0, 'NotEnoughAccountKeys'] }, 'NotEnoughAccountKeys'],
      [{ InstructionError: [0, 'InvalidAccountData'] }, 'InvalidAccountData'],
      [{ InstructionError: [0, 'MissingRequiredSignature'] }, 'MissingRequiredSignature'],
      ['AccountNotFound', 'AccountNotFound'],
      ['BlockhashNotFound', 'BlockhashNotFound'],
      [['Program X failed: exceeded CUs meter at BPF instruction'], 'ComputationalBudgetExceeded'],
      [['Attempt to debit an account but found no record of a prior credit.'], 'AccountNotFound'],
    ]
    for (const [input, name] of cases) {
      const e = parseProgramError(input)!
      expect(e).toBeInstanceOf(AgentAuthError)
      expect(e.program).toBe('runtime')
      expect(e.name).toBe(name)
      expect(e.hint.length).toBeGreaterThan(5)
    }
    expect(parseProgramError(['Program log: ok'])).toBeNull()
  })
})

describe('F10/F11 risky plan inputs', () => {
  const perm = (disc: string, over: Partial<{ spendLimit: bigint; perTxLimit: bigint }> = {}) => ({
    program: TOKEN_PROGRAM_ID,
    spendLimit: 5_000_000n,
    perTxLimit: 1_000_000n,
    discriminators: [TRANSFER_CHECKED_DISC, disc],
    ...over,
  })
  it('SPL MintTo / Freeze / Thaw / MintToChecked are default-deny now', async () => {
    for (const disc of [
      '0700000000000000',
      '0a00000000000000',
      '0b00000000000000',
      '0e00000000000000',
    ]) {
      expect(await refusal(planOnboarding(onboarding({ permissions: [perm(disc)] })))).toMatch(
        /default-deny/,
      )
    }
  })
  it('System assign/allocate are default-deny; unknown instructions warn or refuse', async () => {
    const sys = (d: string) => ({
      program: SYSTEM_PROGRAM_ID,
      spendLimit: 1n,
      perTxLimit: 1n,
      discriminators: [d],
    })
    const tokenOnly = onboarding().permissions[0]!
    expect(
      await refusal(
        planOnboarding(onboarding({ permissions: [tokenOnly, sys('0100000000000000')] })),
      ),
    ).toMatch(/default-deny/)
    const unknown = onboarding({ permissions: [tokenOnly, sys('ee00000000000000')] })
    const plan = await planOnboarding(unknown)
    expect(plan.warnings.join(' ')).toMatch(/no registry knows/)
    expect(await refusal(planOnboarding({ ...unknown, requireKnownInstructions: true }))).toMatch(
      /no registry knows/,
    )
  })
  it('limits of 2^63 or more are effectively unlimited', async () => {
    const huge = 2n ** 64n - 1n
    const reason = await refusal(
      planOnboarding(
        onboarding({
          permissions: [perm('0c00000000000000', { spendLimit: huge, perTxLimit: huge })],
          token: { mint, source, delegateCap: huge },
        }),
      ),
    )
    expect(reason).toMatch(/effectively unlimited/)
  })
  it('warns when perTx > spend, caps fundAgentLamports, flags empty relays', async () => {
    const plan = await planOnboarding(
      onboarding({
        permissions: [
          {
            program: TOKEN_PROGRAM_ID,
            spendLimit: 1_000n,
            perTxLimit: 5_000n,
            discriminators: [TRANSFER_CHECKED_DISC],
          },
        ],
        token: { mint, source, delegateCap: 1_000n },
      }),
    )
    expect(plan.warnings.join(' ')).toMatch(/per-call limit is larger/)
    expect(await refusal(planOnboarding(onboarding({ fundAgentLamports: 10n ** 18n })))).toMatch(
      /more than 1 SOL/,
    )
    expect(
      (await planOnboarding(onboarding({ fundAgentLamports: 10n ** 18n, allowLargeFunding: true })))
        .steps.length,
    ).toBe(2)
    const empty = await planOnboarding(onboarding({ recipients: [] }))
    expect(empty.warnings.join(' ')).toMatch(/No recipients and no swap/)
  })
  it('refuses to silently replace an existing SPL delegate', async () => {
    const chainState = {
      mandate: null,
      policy: null,
      tokenAccounts: { [source]: tokenAccountView(fakeAddress(0x66)) },
    }
    expect(await refusal(planOnboarding(onboarding({ chainState })))).toMatch(/REPLACE/)
    const plan = await planOnboarding(onboarding({ chainState, allowReplaceDelegate: true }))
    expect(plan.warnings.join(' ')).toMatch(/allowReplaceDelegate/)
  })
  it('replaceWith may not widen a permission; revokeDiscriminator computes the kept list', async () => {
    const m = mandate([{ ...tokenPerm, discs: [TRANSFER_CHECKED_DISC, '0300000000000000'] }])
    const chainState = { mandate: m, policy: null }
    await expect(
      planRevokePermission({
        owner,
        agent,
        program: TOKEN_PROGRAM_ID,
        chainState,
        replaceWith: { discriminators: [TRANSFER_CHECKED_DISC, '0900000000000000'] },
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
    const narrowed = await planRevokeDiscriminator({
      owner,
      agent,
      program: TOKEN_PROGRAM_ID,
      discriminators: ['0300000000000000'],
      chainState,
    })
    // remove_permission (2) then add_permission (1) with only transfer_checked kept
    expect(narrowed.steps[0]!.instructions.map((i) => i.data[0])).toEqual([2, 1])
    const addData = hex(narrowed.steps[0]!.instructions[1]!.data)
    expect(addData).toContain(TRANSFER_CHECKED_DISC)
    expect(addData).not.toContain('0300000000000000')
    // removing the only discriminator becomes a plain remove_permission
    const only = mandate([tokenPerm])
    const plain = await planRevokeDiscriminator({
      owner,
      agent,
      program: TOKEN_PROGRAM_ID,
      discriminators: [TRANSFER_CHECKED_DISC],
      chainState: { mandate: only, policy: null },
    })
    expect(plain.steps[0]!.instructions.map((i) => i.data[0])).toEqual([2])
    await expect(
      planRevokeDiscriminator({
        owner,
        agent,
        program: TOKEN_PROGRAM_ID,
        discriminators: ['0900000000000000'],
        chainState,
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
})

describe('F14 step metadata and size options', () => {
  it('onboarding step 2 depends on step 1 and step 1 awaits confirmation', async () => {
    const plan = await planOnboarding(onboarding())
    expect(plan.steps[0]).toMatchObject({ dependsOn: [], awaitConfirmation: true })
    expect(plan.steps[1]).toMatchObject({ dependsOn: [0], awaitConfirmation: false })
  })
  it('worst case = v0 + compute budget, and equals the Kit encoder', async () => {
    const plan = await planOnboarding(onboarding())
    for (const s of plan.steps) {
      expect(s.worstCaseSizeBytes).toBe(
        estimateTransactionSize(s.instructions, owner, { version: 0, computeBudget: true }),
      )
      expect(s.worstCaseSizeBytes).toBe(s.estimatedSizeBytes + 2 + 52)
      const real = compileUnsigned(s, {
        feePayer: owner,
        blockhash: BLOCKHASH,
        computeUnitLimit: 300_000,
        microLamportsPerCu: 1n,
      })
      expect(real.sizeBytes).toBe(s.worstCaseSizeBytes)
    }
  })
})

describe('F03 transaction assembly', () => {
  it('compute budget instruction bytes', () => {
    expect(hex(setComputeUnitLimitIx(200_000).data)).toBe('02400d0300')
    expect(hex(setComputeUnitPriceIx(5n).data)).toBe('030500000000000000')
  })
  it('compileUnsigned / planToUnsignedTransactions produce wire transactions with the right signers', async () => {
    const plan = await planOnboarding(onboarding())
    const txs = planToUnsignedTransactions(plan, { feePayer: owner, blockhash: BLOCKHASH })
    expect(txs).toHaveLength(2)
    expect(txs[0]!.requiredSigners[0]).toBe(owner)
    expect(txs[1]!.dependsOn).toEqual([0])
    expect(Buffer.from(txs[0]!.base64, 'base64').length).toBe(txs[0]!.sizeBytes)
    const legacy = compileUnsigned(plan.steps[0]!, {
      feePayer: owner,
      blockhash: BLOCKHASH,
      version: 'legacy',
    })
    expect(legacy.sizeBytes).toBe(plan.steps[0]!.estimatedSizeBytes)
  })
  it('stripSigners removes signer objects (F16)', async () => {
    const signer = await generateKeyPairSigner()
    const plan = await planOnboarding(onboarding({ owner: signer, expiry: EXPIRY }))
    expect(JSON.stringify(plan.steps[0]!.instructions[0]!.accounts)).toContain('keyPair')
    const clean = stripSigners(plan)
    expect(JSON.stringify(clean)).not.toContain('keyPair')
    expect(clean.steps[0]!.instructions[0]!.accounts[0]!.address).toBe(signer.address)
  })
  it('simulateStep runs unsigned and decodes the error', async () => {
    const seen: unknown[] = []
    const rpc = {
      simulateTransaction: (tx: string, cfg: unknown) => ({
        send: async () => {
          seen.push([tx, cfg])
          return {
            value: {
              err: { InstructionError: [0, { Custom: 9 }] },
              logs: [
                `Program ${AGENT_AUTH_PROGRAM_ID} invoke [1]`,
                `Program ${AGENT_AUTH_PROGRAM_ID} failed: custom program error: 0x9`,
              ],
              unitsConsumed: 1234n,
            },
          }
        },
      }),
    } as unknown as AgentAuthRpc
    const plan = await planOnboarding(onboarding())
    const r = await simulateStep(rpc, plan.steps[1]!, { feePayer: owner })
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ program: 'agent_auth', name: 'SpendLimitExceeded' })
    expect(r.unitsConsumed).toBe(1234n)
    expect(seen[0]).toMatchObject([
      expect.any(String),
      { sigVerify: false, replaceRecentBlockhash: true },
    ])
  })
})

describe('F05 JSON', () => {
  it('bigint -> decimal string, bytes -> hex, errors -> objects, signers dropped', async () => {
    const m = mandate([tokenPerm])
    const j = JSON.parse(JSON.stringify(toJsonSafe(m)))
    expect(j.expiry).toBe(EXPIRY.toString())
    expect(j.permissions[0].spendLimit).toBe('5000000')
    expect(j.permissions[0].discriminators).toEqual([TRANSFER_CHECKED_DISC])
    const e = parseProgramError([
      `Program ${AGENT_AUTH_PROGRAM_ID} failed: custom program error: 0x9`,
    ])
    expect(toJsonSafe(e)).toMatchObject({
      name: 'SpendLimitExceeded',
      program: 'agent_auth',
      code: 9,
    })
    expect(toJsonSafe({ a: undefined, b: 2n, c: new Uint8Array([1, 255]) })).toEqual({
      b: '2',
      c: '01ff',
    })
    const plan = await planOnboarding(onboarding({ owner: createNoopSigner(owner) }))
    const pj = JSON.stringify(planToJson(plan))
    expect(pj).not.toContain('"signer"')
    expect(JSON.parse(pj).steps[0].instructions[0]).toHaveProperty('dataHex')
  })
  it('explanations are serializable', () => {
    const e = explainMandate(mandate([tokenPerm]), { policy: policy(), now: NOW })
    expect(() => JSON.stringify(toJsonSafe(e))).not.toThrow()
  })
})

describe('F12 seller helper', () => {
  const m = mandate([tokenPerm])
  const call = {
    agent,
    targetProgram: TOKEN_PROGRAM_ID,
    discriminator: TRANSFER_CHECKED_DISC,
    amount: 5n,
    now: NOW,
  }
  it('accepts the trusted owner and rejects a mandate by a stranger', () => {
    expect(assertMandateAuthorises(m, { ...call, expectedOwner: owner }).ok).toBe(true)
    const r = assertMandateAuthorises(m, { ...call, expectedOwner: fakeAddress(0x42) })
    expect(r).toMatchObject({ ok: false, advisory: true })
    if (!r.ok) expect(r.error.name).toBe('NotOwner')
    expect(() => assertMandateAuthorises(m, { ...call, expectedOwner: '' as Address })).toThrow()
  })
  it('fetchMandatesByAgent owner filter and limit', async () => {
    const other = fakeAddress(0x43)
    const mA = await mandatePda(owner, agent)
    const mB = await mandatePda(other, agent)
    const rows = [
      { pubkey: mA.address, owner: owner, bump: mA.bump },
      { pubkey: mB.address, owner: other, bump: mB.bump },
    ]
    let filters: unknown
    const rpc = {
      getProgramAccounts: (_p: string, cfg: { filters: unknown }) => ({
        send: async () => {
          filters = cfg.filters
          return rows.map((r) => ({
            pubkey: r.pubkey,
            account: {
              owner: AGENT_AUTH_PROGRAM_ID,
              lamports: 1n,
              executable: false,
              data: [
                Buffer.from(
                  encodeMandateBytes({
                    owner: r.owner,
                    agent,
                    expiry: EXPIRY,
                    bump: r.bump,
                    permissions: [],
                  }),
                ).toString('base64'),
                'base64',
              ],
            },
          }))
        },
      }),
    } as unknown as AgentAuthRpc
    const client = createClient({ rpc })
    expect(await client.mandatesByAgent(agent)).toHaveLength(2)
    expect(await client.mandatesByAgent(agent, { limit: 1 })).toHaveLength(1)
    const trusted = await client.mandatesByAgent(agent, { owners: [owner] })
    expect(trusted.map((x) => x.owner)).toEqual([owner])
    expect(JSON.stringify(filters, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).toContain(
      '"offset":1',
    )
  })
})

describe('capacity (structured agent status)', () => {
  const m = mandate([{ ...tokenPerm, spendTotal: 1_200_000n }])
  it('min of per-call, remaining budget, delegation and balance', () => {
    const c = capacity(m, policy(), { delegation: DELEG, balance: 10_000_000n, now: NOW })
    expect(c.maxSpendNow).toBe(1_000_000n)
    expect(c.limitedBy).toEqual(['per_call_limit'])
    expect(c.partial).toBe(false)
    const low = capacity(m, policy(), {
      delegation: { ...DELEG, delegatedAmount: 400_000n },
      balance: 9n ** 9n,
      now: NOW,
    })
    expect(low.maxSpendNow).toBe(400_000n)
    expect(low.limitedBy).toEqual(['delegation'])
    expect(capacity(m, policy(), { delegation: DELEG, balance: 50n, now: NOW }).limitedBy).toEqual([
      'balance',
    ])
  })
  it('blocked states carry the error', () => {
    expect(
      capacity(m, policy({ paused: true }), { delegation: DELEG, now: NOW }).blockedBy,
    ).toMatchObject({ code: 116 })
    expect(capacity(m, null, { now: NOW }).blockedBy).toMatchObject({ code: 101 })
    expect(capacity(m, policy(), { delegation: DELEG, now: EXPIRY }).blockedBy).toMatchObject({
      code: 5,
    })
    expect(
      capacity(mandate([tokenPerm], { active: false }), policy(), { now: NOW }).blockedBy,
    ).toMatchObject({ code: 4 })
    expect(capacity(m, policy({ recipients: [] }), { now: NOW }).blockedBy).toMatchObject({
      code: 104,
    })
    expect(capacity(m, policy(), { now: NOW }).partial).toBe(true)
  })
})

describe('F09 activity', () => {
  const sigs = ['5'.repeat(88), '6'.repeat(88), '7'.repeat(88)]
  function txRpc(failOn: string[] = [], onFetch?: (s: string) => void) {
    return {
      getSignaturesForAddress: () => ({
        send: async () =>
          sigs.map((signature, i) => ({
            signature,
            slot: BigInt(100 - i),
            blockTime: 1n,
            err: null,
          })),
      }),
      getTransaction: (s: string) => ({
        send: async () => {
          onFetch?.(s)
          if (failOn.includes(s)) throw new Error('HTTP error (429): Too Many Requests')
          return {
            slot: 100n,
            blockTime: 1n,
            meta: { err: null, logMessages: [], innerInstructions: [] },
            transaction: {
              message: {
                accountKeys: [owner, agent],
                header: { numRequiredSignatures: 1 },
                instructions: [],
              },
            },
          }
        },
      }),
    } as unknown as AgentAuthRpc
  }
  it('one failing getTransaction does not lose the feed; cache avoids refetching', async () => {
    const fetched: string[] = []
    const cache = new Map()
    const rpc = txRpc([sigs[1]!], (s) => fetched.push(s))
    const page = await getActivityPage(rpc, { mandate: MANDATE_ADDR, limit: 10, retries: 0, cache })
    expect(page.items).toHaveLength(3)
    expect(page.items.find((i) => i.signature === sigs[1])?.fetchError).toMatch(/429/)
    expect(page.items[0]).toMatchObject({ feePayer: owner, signers: [owner] })
    expect(page.nextBefore).toBeNull()
    expect(cache.size).toBe(2) // failures are not cached
    fetched.length = 0
    await getActivityPage(rpc, { mandate: MANDATE_ADDR, limit: 10, retries: 0, cache })
    expect(fetched).toEqual([sigs[1]])
  })
  it('nextBefore appears when the page is full', async () => {
    const page = await getActivityPage(txRpc(), { mandate: MANDATE_ADDR, limit: 3 })
    expect(page.nextBefore).toBe(sigs[2])
  })
  it('decodes CPI verify calls from inner instructions with viaProgram', () => {
    const keys = [agent, MANDATE_ADDR, owner, AGENT_AUTH_PROGRAM_ID, fakeAddress(0x90)]
    // verify: tag 3 + target[32] + disc[8] + amount u64
    const data = new Uint8Array(49)
    data[0] = 3
    data.set(raw(TOKEN_PROGRAM_ID), 1)
    data.set(Uint8Array.from([12, 0, 0, 0, 0, 0, 0, 0]), 33)
    data[41] = 7
    const b58 = (b: Uint8Array) => {
      const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
      let n = 0n
      for (const x of b) n = (n << 8n) | BigInt(x)
      let s = ''
      while (n > 0n) {
        s = A[Number(n % 58n)] + s
        n /= 58n
      }
      return '1'.repeat(b.findIndex((x) => x !== 0)) + s
    }
    const items = decodeTransaction(
      {
        signature: 'sig',
        slot: 1n,
        blockTime: null,
        err: null,
        logs: [],
        accountKeys: keys,
        numRequiredSignatures: 1,
        instructions: [{ programIdIndex: 4, accounts: [1, 2, 0], data: '1' }],
        innerInstructions: [
          { index: 0, instructions: [{ programIdIndex: 3, accounts: [1, 2, 0], data: b58(data) }] },
        ],
      },
      { mandate: MANDATE_ADDR },
    )
    const verify = items.find((i) => i.kind === 'verify')!
    expect(verify).toMatchObject({
      viaProgram: keys[4],
      amount: 7n,
      program: TOKEN_PROGRAM_ID,
      feePayer: agent,
    })
  })
})

describe('misc fixes', () => {
  it('F17 prototype keys are not programs', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(builtinRegistry.getProgramById(k)).toBeNull()
    }
  })
  it('F18 parseUnits rejects hostile lengths quickly', () => {
    const t = Date.now()
    expect(() => parseUnits('9'.repeat(5_000_000), 6)).toThrow(ValidationError)
    expect(Date.now() - t).toBeLessThan(50)
    expect(parseUnits('18446744073709.551615', 6)).toBe(2n ** 64n - 1n)
  })
  it('F19 mainnet needs an acknowledgement; allowlists per cluster', () => {
    expect(() => createClient({ cluster: 'mainnet-beta', rpc: {} as AgentAuthRpc })).toThrow(
      /not deployed/,
    )
    expect(
      createClient({ cluster: 'mainnet-beta', acknowledgeNoMainnet: true, rpc: {} as AgentAuthRpc })
        .cluster,
    ).toBe('mainnet-beta')
    expect(defaultAmmAllowlist('devnet')).toHaveLength(1)
    expect(defaultAmmAllowlist('localnet')).toContain(MOCK_AMM_PROGRAM_ID)
    expect(defaultAmmAllowlist('mainnet-beta')).not.toContain(MOCK_AMM_PROGRAM_ID)
  })
  it('F22 parseLimitInput', () => {
    expect(parseLimitInput('unlimited', 6)).toBe('unlimited')
    expect(parseLimitInput('0.25', 6)).toBe(250_000n)
    expect(() => parseLimitInput('0', 6)).toThrow(/ambiguous/)
    expect(() => parseLimitInput('Unlimited', 6)).toThrow(ValidationError)
  })
  it('swap amounts unused import guard', () => {
    expect(SWAP_BASE_INPUT_DISC).toHaveLength(16)
    expect(RELAY_PROGRAM_ID).toBeTruthy()
  })
})

describe('F03 sendAndConfirmStep', () => {
  function sendRpc(status: { err: unknown } | null, logs: string[] = []) {
    const sent: unknown[] = []
    const rpc = {
      getLatestBlockhash: () => ({ send: async () => ({ value: BLOCKHASH }) }),
      sendTransaction: (tx: string, cfg: unknown) => ({
        send: async () => {
          sent.push([tx, cfg])
          return 'sig'
        },
      }),
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [status ? { slot: 77n, confirmationStatus: 'confirmed', err: status.err } : null],
        }),
      }),
      getBlockHeight: () => ({ send: async () => 1000n }),
      getTransaction: () => ({ send: async () => ({ meta: { logMessages: logs } }) }),
    } as unknown as AgentAuthRpc
    return { rpc, sent }
  }
  it('signs, sends with skipPreflight, and reports success', async () => {
    const owner = await generateKeyPairSigner()
    const plan = await planOnboarding(onboarding({ owner: owner.address }))
    const { rpc, sent } = sendRpc({ err: null })
    const r = await sendAndConfirmStep(rpc, plan.steps[0]!, {
      signers: [owner],
      skipPreflight: true,
    })
    expect(r).toMatchObject({ ok: true, slot: 77n })
    expect(sent[0]).toMatchObject([expect.any(String), { skipPreflight: true, encoding: 'base64' }])
  })
  it('a landed failure returns the decoded error instead of throwing', async () => {
    const owner = await generateKeyPairSigner()
    const plan = await planOnboarding(onboarding({ owner: owner.address }))
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${RELAY_PROGRAM_ID} failed: custom program error: 0x68`,
    ]
    const { rpc } = sendRpc({ err: { InstructionError: [0, { Custom: 104 }] } }, logs)
    const r = await sendAndConfirmStep(rpc, plan.steps[0]!, { signers: [owner] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ program: 'relay', name: 'RecipientNotAllowed' })
  })
  it('expired blockhash throws TX_EXPIRED', async () => {
    const owner = await generateKeyPairSigner()
    const plan = await planOnboarding(onboarding({ owner: owner.address }))
    const { rpc } = sendRpc(null)
    await expect(
      sendAndConfirmStep(rpc, plan.steps[0]!, { signers: [owner] }),
    ).rejects.toMatchObject({
      code: 'TX_EXPIRED',
    })
  })
})
