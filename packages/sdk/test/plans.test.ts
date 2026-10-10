import { describe, expect, it } from 'vitest'
import {
  compileTransaction,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit'
import {
  AGENT_AUTH_PROGRAM_ID,
  MAX_TRANSACTION_SIZE,
  MOCK_AMM_PROGRAM_ID,
  PlanRefusedError,
  RELAY_PROGRAM_ID,
  SWAP_BASE_INPUT_DISC,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  decodeMandate,
  estimateTransactionSize,
  mandatePda,
  planClosePolicy,
  planOnboarding,
  planPause,
  planReinitPolicy,
  planResume,
  planRevokePermission,
  planUnwind,
  planUpdateLimits,
  relayAuthorityPda,
  relayPolicyPda,
  type OnboardingInput,
  type Plan,
  type RelayPolicy,
} from '../src/index'
import {
  encodeMandateBytes,
  fakeAddress,
  hex,
  noopSigner,
  raw,
  type TestPermission,
} from './helpers'

const owner = fakeAddress(0xa1)
const agent = fakeAddress(0xa2)
const mint = fakeAddress(0xa3)
const source = fakeAddress(0xa4)
const recipient = fakeAddress(0xa5)
const OWNER = noopSigner(owner)
const NOW = 1_800_000_000n
const EXPIRY = NOW + 7n * 86_400n

const tokenPerm = {
  program: TOKEN_PROGRAM_ID,
  spendLimit: 5_000_000n,
  perTxLimit: 1_000_000n,
  discriminators: [TRANSFER_CHECKED_DISC],
}
const ammPerm = {
  program: MOCK_AMM_PROGRAM_ID,
  spendLimit: 5_000_000n,
  perTxLimit: 5_000_000n,
  discriminators: [SWAP_BASE_INPUT_DISC],
}
const swapCfg = {
  ammProgram: MOCK_AMM_PROGRAM_ID,
  ammAuthority: fakeAddress(0xb1),
  ammConfig: fakeAddress(0xb2),
  poolState: fakeAddress(0xb3),
  inputVault: fakeAddress(0xb4),
  outputVault: fakeAddress(0xb5),
  observationState: fakeAddress(0xb6),
  inMint: mint,
  outMint: fakeAddress(0xb7),
  inTokenProgram: TOKEN_PROGRAM_ID,
  outTokenProgram: TOKEN_PROGRAM_ID,
  inAccount: source,
  outAccount: fakeAddress(0xb8),
  floorOut: 95n,
  floorIn: 100n,
  maxDeadlineSlots: 150,
}

function onboarding(over: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    owner: OWNER,
    agent,
    expiry: EXPIRY,
    now: NOW,
    fundAgentLamports: 10_000_000n,
    token: { mint, source, delegateCap: 5_000_000n },
    permissions: [tokenPerm],
    recipients: [recipient],
    ...over,
  }
}
const withSwap = (over: Partial<OnboardingInput> = {}): OnboardingInput =>
  onboarding({
    permissions: [tokenPerm, ammPerm],
    swap: swapCfg,
    validation: { ammAllowlist: [MOCK_AMM_PROGRAM_ID] },
    ...over,
  })

const refused = async (p: Promise<Plan>): Promise<string[]> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(PlanRefusedError)
    return [...(e as PlanRefusedError).reasons]
  }
  throw new Error('plan was not refused')
}
const programs = (plan: Plan): string[][] =>
  plan.steps.map((s) => s.instructions.map((i) => i.programAddress))
const tags = (plan: Plan): number[][] =>
  plan.steps.map((s) => s.instructions.map((i) => i.data[0] as number))

function compiledSize(ixs: Plan['steps'][number]['instructions'], feePayer: Address): number {
  const msg = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never,
          lastValidBlockHeight: 1n,
        },
        m,
      ),
  )
  return getTransactionEncoder().encode(compileTransaction(msg)).length
}

describe('planOnboarding (RELAY-SPEC 12.1)', () => {
  it('transfer-only: tx1 = [fund, create_mandate, add_permission(token), Approve], tx2 = init_policy', async () => {
    const plan = await planOnboarding(onboarding())
    expect(plan.steps).toHaveLength(2)
    expect(programs(plan)).toEqual([
      [SYSTEM_PROGRAM_ID, AGENT_AUTH_PROGRAM_ID, AGENT_AUTH_PROGRAM_ID, TOKEN_PROGRAM_ID],
      [RELAY_PROGRAM_ID],
    ])
    expect(tags(plan)).toEqual([[2, 0, 1, 4], [0]])
    expect(plan.steps.every((s) => s.fitsInOneTx)).toBe(true)
  })

  it('with swap: tx1 = [fund, create, add(token), add(amm), Approve], tx2 = init_policy; one Approve when in_account == source', async () => {
    const plan = await planOnboarding(withSwap())
    expect(tags(plan)).toEqual([[2, 0, 1, 1, 4], [0]])
    const tx1 = plan.steps[0]!.instructions
    expect(hex(tx1[2]!.data.subarray(1, 33))).toBe(hex(raw(TOKEN_PROGRAM_ID)))
    expect(hex(tx1[3]!.data.subarray(1, 33))).toBe(hex(raw(MOCK_AMM_PROGRAM_ID)))
  })

  it('a separate swap input account gets its own Approve with its own cap', async () => {
    const inAcc = fakeAddress(0xc1)
    const plan = await planOnboarding(
      withSwap({ swap: { ...swapCfg, inAccount: inAcc, delegateCap: 4_000_000n } }),
    )
    expect(tags(plan)[0]).toEqual([2, 0, 1, 1, 4, 4])
    const approves = plan.steps[0]!.instructions.slice(-2)
    expect(approves.map((a) => a.accounts[0]?.address)).toEqual([source, inAcc])
    expect(hex(approves[1]!.data)).toBe('04' + '00093d0000000000')
  })

  it('Approve delegates to the relay authority PDA of the mandate, for exactly delegateCap', async () => {
    const mandate = (await mandatePda(owner, agent)).address
    const authority = (await relayAuthorityPda(mandate)).address
    const plan = await planOnboarding(onboarding())
    const approve = plan.steps[0]!.instructions[3]!
    expect(approve.accounts.map((a) => a.address)).toEqual([source, authority, owner])
    expect(hex(approve.data)).toBe(
      '04' + hex(new Uint8Array(new BigUint64Array([5_000_000n]).buffer)),
    )
    const init = plan.steps[1]!.instructions[0]!
    expect(init.accounts[1]?.address).toBe(mandate)
    expect(init.accounts[2]?.address).toBe((await relayPolicyPda(mandate)).address)
  })

  it('every signer is the owner; the agent never signs', async () => {
    const plan = await planOnboarding(onboarding())
    for (const s of plan.steps) expect(s.signers).toEqual([owner])
  })

  it('a separate fee payer is listed as signer', async () => {
    const fp = fakeAddress(0xd1)
    const plan = await planOnboarding(onboarding({ feePayer: fp }))
    for (const s of plan.steps) expect(s.signers).toEqual([fp, owner])
  })

  it('size budgets: estimates equal the size Kit really encodes, and stay under the spec figures', async () => {
    const plan = await planOnboarding(withSwap())
    for (const step of plan.steps) {
      expect(step.estimatedSizeBytes).toBe(compiledSize(step.instructions, owner))
      expect(step.estimatedSizeBytes).toBe(estimateTransactionSize(step.instructions, owner))
    }
    // spec 11: onboarding tx 1 about 562 B + about 70 B per extra permission; init_policy 1072 B.
    expect(plan.steps[0]!.estimatedSizeBytes).toBeLessThanOrEqual(562 + 70 + 80)
    expect(plan.steps[1]!.estimatedSizeBytes).toBeLessThanOrEqual(1072 + 40)
    expect(plan.steps[1]!.estimatedSizeBytes).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE)
  })

  it('many permissions are split into several transactions, each within 1232 bytes, order preserved', async () => {
    const extra = Array.from({ length: 12 }, (_, i) => ({
      program: fakeAddress(0xe0 + i),
      spendLimit: 1_000n,
      perTxLimit: 100n,
      discriminators: Array.from({ length: 8 }, (_, j) => `0${j}0${i.toString(16)}000000000000`),
    }))
    const plan = await planOnboarding(onboarding({ permissions: [tokenPerm, ...extra] }))
    expect(plan.steps.length).toBeGreaterThan(2)
    for (const s of plan.steps)
      expect(s.estimatedSizeBytes).toBeLessThanOrEqual(MAX_TRANSACTION_SIZE)
    const flat = plan.steps.flatMap((s) =>
      s.instructions.map((i) => `${i.programAddress}:${i.data[0]}`),
    )
    expect(flat[0]).toBe(`${SYSTEM_PROGRAM_ID}:2`)
    expect(flat[1]).toBe(`${AGENT_AUTH_PROGRAM_ID}:0`)
    expect(flat.at(-1)).toBe(`${RELAY_PROGRAM_ID}:0`)
    expect(plan.warnings.join(' ')).toMatch(/transactions/)
  })

  it('carries the honesty warnings', async () => {
    const plan = await planOnboarding(onboarding())
    const w = plan.warnings.join('\n')
    expect(w).toMatch(/unaudited/i)
    expect(w).toMatch(/REPLACES/)
    expect(w).toMatch(/token accounts, not wallets/)
    expect(w).toMatch(/Chain state was not checked/)
  })

  it('merges a preset in front of the explicit permissions', async () => {
    const plan = await planOnboarding(
      onboarding({ permissions: [], preset: { permissions: [tokenPerm] } }),
    )
    expect(tags(plan)[0]).toEqual([2, 0, 1, 4])
  })

  it('skips the funding transfer when fundAgentLamports is 0 and says so', async () => {
    const plan = await planOnboarding(onboarding({ fundAgentLamports: 0n }))
    expect(tags(plan)[0]).toEqual([0, 1, 4])
    expect(plan.warnings.join(' ')).toMatch(/needs SOL/)
  })

  describe('refusals', () => {
    it('unlimited limits, unless allowUnlimited', async () => {
      const unl = { ...tokenPerm, spendLimit: 'unlimited' as const }
      expect((await refused(planOnboarding(onboarding({ permissions: [unl] })))).join()).toMatch(
        /unlimited/,
      )
      const ok = await planOnboarding(onboarding({ permissions: [unl], allowUnlimited: true }))
      expect(ok.warnings.join(' ')).toMatch(/UNLIMITED/)
      const perTx = { ...tokenPerm, perTxLimit: 'unlimited' as const }
      await refused(planOnboarding(onboarding({ permissions: [perTx] })))
    })
    it('a bare 0n limit is refused as ambiguous', async () => {
      expect(
        (
          await refused(
            planOnboarding(onboarding({ permissions: [{ ...tokenPerm, spendLimit: 0n }] })),
          )
        ).join(),
      ).toMatch(/UNLIMITED/)
    })
    it('delegateCap above the smallest lifetime limit, unless allowOverride', async () => {
      const big = { ...onboarding().token, delegateCap: 5_000_001n }
      expect((await refused(planOnboarding(onboarding({ token: big })))).join()).toMatch(
        /exceeds the smallest lifetime limit/,
      )
      const ok = await planOnboarding(onboarding({ token: big, allowOverride: true }))
      expect(ok.warnings.join(' ')).toMatch(/allowOverride/)
    })
    it('delegateCap uses the minimum over token AND swap permissions when they share the account', async () => {
      const small = { ...ammPerm, spendLimit: 2_000_000n }
      const r = await refused(planOnboarding(withSwap({ permissions: [tokenPerm, small] })))
      expect(r.join()).toMatch(/2000000/)
    })
    it('delegateCap of zero or beyond u64', async () => {
      await refused(
        planOnboarding(onboarding({ token: { ...onboarding().token, delegateCap: 0n } })),
      )
      await refused(
        planOnboarding(onboarding({ token: { ...onboarding().token, delegateCap: 2n ** 64n } })),
      )
    })
    it('an existing policy or mandate', async () => {
      const policy = { mandate: fakeAddress(1) } as RelayPolicy
      expect(
        (await refused(planOnboarding(onboarding({ chainState: { policy } })))).join(),
      ).toMatch(/relay policy already exists/)
      const mandate = decodeMandate(
        encodeMandateBytes({ owner, agent, expiry: EXPIRY, permissions: [] }),
      )
      expect(
        (await refused(planOnboarding(onboarding({ chainState: { mandate } })))).join(),
      ).toMatch(/mandate for this \(owner, agent\) already exists/)
    })
    it('recipients without a TransferChecked permission', async () => {
      expect((await refused(planOnboarding(onboarding({ permissions: [] })))).join()).toMatch(
        /no permission exists for the Token program/,
      )
      const noDisc = { ...tokenPerm, discriminators: ['0300000000000000'] }
      expect((await refused(planOnboarding(onboarding({ permissions: [noDisc] })))).join()).toMatch(
        /must include TransferChecked/,
      )
    })
    it('swap without an AMM permission / without swap_base_input', async () => {
      expect(
        (await refused(planOnboarding(withSwap({ permissions: [tokenPerm] })))).join(),
      ).toMatch(/no permission exists for the AMM/)
      expect(
        (
          await refused(
            planOnboarding(
              withSwap({
                permissions: [tokenPerm, { ...ammPerm, discriminators: ['0100000000000000'] }],
              }),
            ),
          )
        ).join(),
      ).toMatch(/must include swap_base_input/)
    })
    it('default-deny instructions (SPL Approve / SetAuthority) unless allowDefaultDeny', async () => {
      const risky = {
        ...tokenPerm,
        discriminators: [TRANSFER_CHECKED_DISC, '0400000000000000', '0600000000000000'],
      }
      const r = await refused(planOnboarding(onboarding({ permissions: [risky] })))
      expect(r.join()).toMatch(/default-deny/)
      const ok = await planOnboarding(onboarding({ permissions: [risky], allowDefaultDeny: true }))
      expect(ok.warnings.join(' ')).toMatch(/Default-deny instruction allowed/)
    })
    it('expiry in the past or equal to now; agent == owner; duplicate program; too many permissions', async () => {
      expect((await refused(planOnboarding(onboarding({ expiry: NOW })))).join()).toMatch(
        /InvalidExpiry/,
      )
      expect((await refused(planOnboarding(onboarding({ expiry: NOW - 1n })))).join()).toMatch(
        /InvalidExpiry/,
      )
      expect((await refused(planOnboarding(onboarding({ agent: owner })))).join()).toMatch(
        /agent must differ/,
      )
      expect(
        (await refused(planOnboarding(onboarding({ permissions: [tokenPerm, tokenPerm] })))).join(),
      ).toMatch(/one slot per program/)
      const many = Array.from({ length: 16 }, (_, i) => ({
        ...tokenPerm,
        program: fakeAddress(0xf0 + (i % 8) + (i >= 8 ? 0x10 : 0)),
      }))
      expect(
        (await refused(planOnboarding(onboarding({ permissions: [tokenPerm, ...many] })))).join(),
      ).toMatch(/at most 16/)
    })
    it('invalid relay policy config: 9 recipients, recipient == source, aliasing', async () => {
      const nine = Array.from({ length: 9 }, (_, i) => fakeAddress(0x20 + i))
      expect((await refused(planOnboarding(onboarding({ recipients: nine })))).join()).toMatch(
        /at most 8 recipients/,
      )
      expect((await refused(planOnboarding(onboarding({ recipients: [source] })))).join()).toMatch(
        /sourceAccount/,
      )
      expect((await refused(planOnboarding(onboarding({ recipients: [owner] })))).join()).toMatch(
        /different accounts/,
      )
    })
    it('reports every reason at once', async () => {
      const r = await refused(
        planOnboarding(
          onboarding({ expiry: NOW, permissions: [{ ...tokenPerm, spendLimit: 'unlimited' }] }),
        ),
      )
      expect(r.length).toBeGreaterThanOrEqual(2)
    })
    it('swap on a pool with an AMM outside the allowlist', async () => {
      const r = await refused(
        planOnboarding(withSwap({ validation: { ammAllowlist: [fakeAddress(1)] } })),
      )
      expect(r.join()).toMatch(/allowlist/)
    })
  })
})

// ---------------------------------------------------------------------------------------------

const prog = fakeAddress(0x31)
function chain(over: { active?: boolean; perms?: TestPermission[] } = {}) {
  return {
    mandate: decodeMandate(
      encodeMandateBytes({
        owner,
        agent,
        expiry: EXPIRY,
        active: over.active,
        permissions: over.perms ?? [
          {
            program: TOKEN_PROGRAM_ID,
            spendLimit: 5_000_000n,
            perTxLimit: 1_000_000n,
            spendTotal: 1_200_000n,
            discs: [TRANSFER_CHECKED_DISC, '0300000000000000'],
          },
          { program: prog, spendLimit: 0n, perTxLimit: 0n, discs: ['0100000000000000'] },
        ],
      }),
    ),
    policy: {
      agent,
      sourceAccount: source,
      tokenProgram: TOKEN_PROGRAM_ID,
      swap: null,
    } as unknown as RelayPolicy,
  }
}

describe('planUnwind (RELAY-SPEC 12.3)', () => {
  it('one transaction: Revoke(source), revoke_mandate, close_policy', async () => {
    const plan = await planUnwind({ owner: OWNER, agent, chainState: chain(), now: NOW })
    expect(plan.steps).toHaveLength(1)
    expect(programs(plan)[0]).toEqual([TOKEN_PROGRAM_ID, AGENT_AUTH_PROGRAM_ID, RELAY_PROGRAM_ID])
    expect(tags(plan)[0]).toEqual([5, 4, 2])
    expect(plan.steps[0]!.fitsInOneTx).toBe(true)
    // spec 12.3 measured 383 B with two accounts; allow a small margin for one extra signer meta
    expect(plan.steps[0]!.estimatedSizeBytes).toBeLessThanOrEqual(383 + 40)
    expect(plan.steps[0]!.estimatedSizeBytes).toBe(compiledSize(plan.steps[0]!.instructions, owner))
  })

  it('a second Revoke for a separate swap input account', async () => {
    const c = chain()
    const inAcc = fakeAddress(0x41)
    const policy = {
      ...c.policy,
      swap: { inAccount: inAcc, inTokenProgram: TOKEN_PROGRAM_ID },
    } as unknown as RelayPolicy
    const plan = await planUnwind({ owner: OWNER, agent, chainState: { ...c, policy } })
    expect(tags(plan)[0]).toEqual([5, 5, 4, 2])
    expect(plan.steps[0]!.instructions.map((i) => i.accounts[0]?.address).slice(0, 2)).toEqual([
      source,
      inAcc,
    ])
  })

  it('skips instructions for things that no longer exist', async () => {
    const onlyPolicy = await planUnwind({
      owner: OWNER,
      agent,
      chainState: { mandate: null, policy: chain().policy },
    })
    expect(tags(onlyPolicy)[0]).toEqual([5, 2])
    const onlyMandate = await planUnwind({
      owner: OWNER,
      agent,
      chainState: { mandate: chain().mandate, policy: null },
      tokenAccounts: [{ address: source }],
    })
    expect(tags(onlyMandate)[0]).toEqual([5, 4])
    await expect(
      planUnwind({ owner: OWNER, agent, chainState: { mandate: null, policy: null } }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })

  it('explicit token accounts and Token-2022', async () => {
    const plan = await planUnwind({
      owner: OWNER,
      agent,
      tokenAccounts: [{ address: source }, { address: fakeAddress(0x42) }],
    })
    // Unknown chain state: kill switch alone first, best-effort cleanup second.
    expect(tags(plan)).toEqual([[4], [5, 5, 2]])
    expect(plan.warnings.join(' ')).toMatch(/Chain state was not checked/)
  })

  it('warns when nothing is known about delegations', async () => {
    const plan = await planUnwind({ owner: OWNER, agent })
    expect(plan.warnings.join(' ')).toMatch(/No token accounts to revoke/)
    expect(tags(plan)).toEqual([[4], [2]])
  })

  it('splits with the kill switch first when the set does not fit', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ address: fakeAddress(0x50 + i) }))
    const plan = await planUnwind({ owner: OWNER, agent, tokenAccounts: many })
    expect(plan.steps.length).toBeGreaterThan(2)
    expect(tags(plan)[0]).toEqual([4])
    for (const s of plan.steps) expect(s.fitsInOneTx).toBe(true)
    // With the chain state known the kill switch also comes first inside a split plan.
    const known = await planUnwind({
      owner: OWNER,
      agent,
      tokenAccounts: many,
      chainState: chain(),
    })
    expect(tags(known)[0]!.slice(0, 2)).toEqual([4, 2])
    for (const s of known.steps) expect(s.fitsInOneTx).toBe(true)
  })
})

describe('pause / resume', () => {
  it('both: relay set_paused then core set_active', async () => {
    const pause = await planPause({ owner: OWNER, agent, chainState: chain() })
    expect(programs(pause)[0]).toEqual([RELAY_PROGRAM_ID, AGENT_AUTH_PROGRAM_ID])
    expect(pause.steps[0]!.instructions.map((i) => hex(i.data))).toEqual(['0101', '0500'])
    const resume = await planResume({ owner: OWNER, agent, chainState: chain({ active: false }) })
    expect(resume.steps[0]!.instructions.map((i) => hex(i.data))).toEqual(['0100', '0501'])
  })
  it('scopes', async () => {
    expect(tags(await planPause({ owner: OWNER, agent, scope: 'relay' }))[0]).toEqual([1])
    expect(tags(await planPause({ owner: OWNER, agent, scope: 'mandate' }))[0]).toEqual([5])
  })
  it('skips set_paused when no policy exists', async () => {
    const plan = await planPause({
      owner: OWNER,
      agent,
      chainState: { policy: null, mandate: chain().mandate },
    })
    expect(tags(plan)[0]).toEqual([5])
    expect(plan.warnings.join(' ')).toMatch(/set_paused was skipped/)
    await expect(
      planPause({ owner: OWNER, agent, scope: 'relay', chainState: { policy: null } }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
  it('warns that pausing does not revoke the delegation, and that resuming an expired mandate is useless', async () => {
    const pause = await planPause({ owner: OWNER, agent })
    expect(pause.warnings.join(' ')).toMatch(/does not revoke the SPL delegation/)
    const resume = await planResume({ owner: OWNER, agent, chainState: chain(), now: EXPIRY })
    expect(resume.warnings.join(' ')).toMatch(/expired/)
  })
})

describe('planRevokePermission (live per-instruction revoke)', () => {
  it('removes the whole slot', async () => {
    const plan = await planRevokePermission({
      owner: OWNER,
      agent,
      program: prog,
      chainState: chain(),
    })
    expect(tags(plan)[0]).toEqual([2])
    expect(plan.steps[0]!.expectedOutcome).toMatch(/ProgramNotAllowed \(6\)/)
    expect(plan.warnings.join(' ')).toMatch(/WHOLE slot/)
  })
  it('refuses a program that has no slot', async () => {
    await expect(
      planRevokePermission({
        owner: OWNER,
        agent,
        program: fakeAddress(0x99),
        chainState: chain(),
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
  it('replaceWith re-adds a narrower slot carrying over the remaining budget', async () => {
    const plan = await planRevokePermission({
      owner: OWNER,
      agent,
      program: TOKEN_PROGRAM_ID,
      chainState: chain(),
      replaceWith: { discriminators: [TRANSFER_CHECKED_DISC] },
    })
    expect(tags(plan)[0]).toEqual([2, 1])
    const add = plan.steps[0]!.instructions[1]!
    // remaining = 5_000_000 - 1_200_000 = 3_800_000; per_tx kept at 1_000_000; one discriminator
    const dv = new DataView(add.data.buffer, add.data.byteOffset)
    expect(dv.getBigUint64(33, true)).toBe(3_800_000n)
    expect(dv.getBigUint64(41, true)).toBe(1_000_000n)
    expect(add.data[49]).toBe(1)
    expect(plan.steps[0]!.expectedOutcome).toMatch(/DiscriminatorNotAllowed \(7\)/)
  })
  it('replaceWith needs chain state, and refuses unlimited slots / used-up budgets unless allowed', async () => {
    await expect(
      planRevokePermission({
        owner: OWNER,
        agent,
        program: prog,
        replaceWith: { discriminators: ['0100000000000000'] },
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
    await expect(
      planRevokePermission({
        owner: OWNER,
        agent,
        program: prog,
        chainState: chain(),
        replaceWith: { discriminators: ['0100000000000000'] },
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
    const ok = await planRevokePermission({
      owner: OWNER,
      agent,
      program: prog,
      chainState: chain(),
      replaceWith: { discriminators: ['0100000000000000'] },
      allowUnlimited: true,
    })
    expect(tags(ok)[0]).toEqual([2, 1])
    const used = chain({
      perms: [
        {
          program: prog,
          spendLimit: 10n,
          perTxLimit: 10n,
          spendTotal: 10n,
          discs: ['0100000000000000'],
        },
      ],
    })
    await expect(
      planRevokePermission({
        owner: OWNER,
        agent,
        program: prog,
        chainState: used,
        replaceWith: { discriminators: ['0100000000000000'] },
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
  it('on a paused mandate the edit is wrapped: resume, edit, pause again, in ONE transaction', async () => {
    const plan = await planRevokePermission({
      owner: OWNER,
      agent,
      program: prog,
      chainState: chain({ active: false }),
    })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.instructions.map((i) => hex(i.data.subarray(0, 2)))).toEqual([
      '0501',
      '02' + hex(raw(prog)).slice(0, 2),
      '0500',
    ])
  })
})

describe('planUpdateLimits', () => {
  it('builds update_permission and keeps counters (documented in warnings)', async () => {
    const plan = await planUpdateLimits({
      owner: OWNER,
      agent,
      program: TOKEN_PROGRAM_ID,
      spendLimit: 9_000_000n,
      perTxLimit: 2_000_000n,
      chainState: chain(),
    })
    expect(tags(plan)[0]).toEqual([6])
    expect(plan.steps[0]!.instructions[0]!.data.length).toBe(49)
    expect(plan.warnings.join(' ')).toMatch(/Counters are preserved/)
  })
  it('warns when the new limit does not exceed what is already spent', async () => {
    const plan = await planUpdateLimits({
      owner: OWNER,
      agent,
      program: TOKEN_PROGRAM_ID,
      spendLimit: 1_000_000n,
      perTxLimit: 100n,
      chainState: chain(),
    })
    expect(plan.warnings.join(' ')).toMatch(/blocked until the limit is raised/)
  })
  it('refuses unlimited unless allowUnlimited, 0n, and unknown programs', async () => {
    await expect(
      planUpdateLimits({
        owner: OWNER,
        agent,
        program: prog,
        spendLimit: 'unlimited',
        perTxLimit: 1n,
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
    expect(
      (
        await planUpdateLimits({
          owner: OWNER,
          agent,
          program: prog,
          spendLimit: 'unlimited',
          perTxLimit: 1n,
          allowUnlimited: true,
        })
      ).warnings.join(' '),
    ).toMatch(/UNLIMITED/)
    await expect(
      planUpdateLimits({ owner: OWNER, agent, program: prog, spendLimit: 0n, perTxLimit: 1n }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
    await expect(
      planUpdateLimits({
        owner: OWNER,
        agent,
        program: fakeAddress(0x98),
        spendLimit: 1n,
        perTxLimit: 1n,
        chainState: chain(),
      }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
  it('resumes and re-pauses around the edit on a paused mandate', async () => {
    const plan = await planUpdateLimits({
      owner: OWNER,
      agent,
      program: TOKEN_PROGRAM_ID,
      spendLimit: 9n,
      perTxLimit: 1n,
      chainState: chain({ active: false }),
    })
    expect(tags(plan)[0]).toEqual([5, 6, 5])
  })
})

describe('policy lifecycle plans', () => {
  it('planClosePolicy: one close_policy, warns the delegation stays', async () => {
    const plan = await planClosePolicy({ owner: OWNER, agent })
    expect(programs(plan)).toEqual([[RELAY_PROGRAM_ID]])
    expect(tags(plan)).toEqual([[2]])
    expect(plan.warnings.join(' ')).toMatch(/NOT revoked/)
    await expect(
      planClosePolicy({ owner: OWNER, agent, chainState: { policy: null } }),
    ).rejects.toBeInstanceOf(PlanRefusedError)
  })
  it('planReinitPolicy: close then init in TWO transactions', async () => {
    const config = {
      tokenProgram: TOKEN_PROGRAM_ID,
      budgetMint: mint,
      sourceAccount: source,
      recipients: [recipient],
      swap: null,
    }
    const plan = await planReinitPolicy({ owner: OWNER, agent, config })
    expect(tags(plan)).toEqual([[2], [0]])
    const skip = await planReinitPolicy({
      owner: OWNER,
      agent,
      config,
      chainState: { policy: null },
    })
    expect(tags(skip)).toEqual([[0]])
    const paused = await planReinitPolicy({
      owner: OWNER,
      agent,
      config,
      chainState: { mandate: chain({ active: false }).mandate },
    })
    expect(paused.warnings.join(' ')).toMatch(/mandate is paused/)
  })
  it('planReinitPolicy validates the config', async () => {
    const bad = {
      tokenProgram: TOKEN_PROGRAM_ID,
      budgetMint: mint,
      sourceAccount: source,
      recipients: [source],
      swap: null,
    }
    await expect(planReinitPolicy({ owner: OWNER, agent, config: bad })).rejects.toMatchObject({
      relayCode: 113,
    })
  })
})

describe('plans never sign or send', () => {
  it('a plan is plain data: instructions + metadata only', async () => {
    const plan = await planOnboarding(onboarding())
    for (const s of plan.steps) {
      expect(Object.keys(s).sort()).toEqual([
        'awaitConfirmation',
        'dependsOn',
        'description',
        'estimatedSizeBytes',
        'expectedOutcome',
        'fitsInOneTx',
        'instructions',
        'label',
        'signers',
        'worstCaseSizeBytes',
      ])
    }
    expect(plan.summary).toMatch(/unsigned/)
  })
})
