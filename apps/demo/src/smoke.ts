/**
 * Smoke check of the local environment: proves the four programs respond and the bootstrapped
 * fixtures (mints, pool, gated-example config) work. Run after `scripts/localnet.sh start` and
 * `bootstrap`:
 *
 *   pnpm --filter @agentauth-sol/demo smoke            core + gated-example round trips
 *   pnpm --filter @agentauth-sol/demo smoke --relay    plus relay transfer, a refused transfer, a swap and the unwind
 *
 * It uses throwaway keypairs generated in memory (never written to disk) and leaves the demo
 * wallets' balances untouched. `--relay` swaps a few DUSD through the shared mock pool, which moves
 * its reserves slightly (`bootstrap --refill` restores them).
 */
import {
  addPermissionIx,
  associatedTokenAddress,
  createAtaIdempotentIx,
  createMandateIx,
  GATED_ACTION_DISC,
  mandatePda,
  parseUnits,
  relaySwapIx,
  relayTransferIx,
  revokeMandateIx,
  SWAP_BASE_INPUT_DISC,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  verifyIx,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner } from '@solana/kit'
import { connect, TxFailedError, type DemoChain } from './lib/chain'
import {
  checkDemoEnv,
  demoClient,
  demoSwapConfig,
  fetchTokenAccount,
  loadDemoEnv,
  loadDemoSigners,
  tokenBalance,
  type DemoEnv,
} from './lib/env'
import { gatedActionIx, mintToCheckedIx } from './lib/instructions'

const SOL = 1_000_000_000n
const withRelay = process.argv.includes('--relay')

let passed = 0
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    const out = await fn()
    passed++
    console.log(`  ok   ${name} (${Date.now() - started} ms)`)
    return out
  } catch (error) {
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** The transaction must fail with exactly this program error (program, code, name). */
async function expectProgramError(
  fn: () => Promise<unknown>,
  want: { program: string; code: number; name: string },
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const pe = error instanceof TxFailedError ? error.programError : null
    if (pe && pe.program === want.program && pe.code === want.code && pe.name === want.name) return
    throw new Error(
      `expected ${want.program} ${want.name} (${want.code}) but got ${
        pe
          ? `${pe.program} ${pe.name} (${pe.code})`
          : error instanceof Error
            ? error.message
            : String(error)
      }`,
    )
  }
  throw new Error(
    `expected ${want.program} ${want.name} (${want.code}) but the transaction succeeded`,
  )
}

const expiryIn = (seconds: bigint): bigint => BigInt(Math.floor(Date.now() / 1000)) + seconds

/** Core: create_mandate, add_permission, verify (ok), verify over the per-call cap (error 8), revoke. */
async function coreRoundTrip(chain: DemoChain, env: DemoEnv): Promise<void> {
  const client = demoClient(env)
  const owner = await generateKeyPairSigner()
  const agent = await generateKeyPairSigner()
  await chain.airdrop(owner.address, 2n * SOL)
  await chain.airdrop(agent.address, SOL / 10n)

  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address
  const target = env.programIds.gatedExample

  await step('core: create_mandate + add_permission', async () => {
    await chain.send(
      [
        await createMandateIx({ owner, agent: agent.address, expiry: expiryIn(3600n) }),
        await addPermissionIx({
          owner,
          agent: agent.address,
          program: target,
          spendLimit: 100n,
          perTxLimit: 10n,
          discriminators: [GATED_ACTION_DISC],
        }),
      ],
      owner,
    )
    const { mandate: m } = await client.fetchMandateFor(owner.address, agent.address)
    assert(m !== null, 'mandate exists after create_mandate')
    assert(
      m.permissions.length === 1 && m.permissions[0]?.program === target,
      'one permission for gated-example',
    )
  })

  await step('core: verify(4) passes and books the spend', async () => {
    await chain.send(
      [
        await verifyIx({
          mandate,
          owner: owner.address,
          agent,
          targetProgram: target,
          discriminator: GATED_ACTION_DISC,
          amount: 4n,
        }),
      ],
      agent,
    )
    const m = await client.fetchMandate(mandate)
    assert(
      m?.permissions[0]?.spendTotal === 4n && m.permissions[0].callCount === 1,
      'spend_total 4, call_count 1',
    )
  })

  await step('core: verify(11) is refused with AgentAuth 8 PerTxExceeded', () =>
    expectProgramError(
      async () =>
        chain.send(
          [
            await verifyIx({
              mandate,
              owner: owner.address,
              agent,
              targetProgram: target,
              discriminator: GATED_ACTION_DISC,
              amount: 11n,
            }),
          ],
          agent,
        ),
      { program: 'agent_auth', code: 8, name: 'PerTxExceeded' },
    ),
  )

  await step('core: revoke_mandate closes the mandate', async () => {
    await chain.send([await revokeMandateIx({ owner, agent: agent.address })], owner)
    assert((await client.fetchMandate(mandate)) === null, 'mandate gone after revoke')
  })
}

/** gated-example: the second integrator, bound to the demo OWNER wallet by `bootstrap`. */
async function gatedRoundTrip(chain: DemoChain, env: DemoEnv): Promise<void> {
  const signers = await loadDemoSigners(env)
  const owner = signers.owner
  const agent = await generateKeyPairSigner()
  await chain.airdrop(agent.address, SOL / 10n)
  const client = demoClient(env)
  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address

  await step('gated-example: mandate by the demo owner, gated_action(4) passes', async () => {
    await chain.send(
      [
        await createMandateIx({ owner, agent: agent.address, expiry: expiryIn(3600n) }),
        await addPermissionIx({
          owner,
          agent: agent.address,
          program: env.programIds.gatedExample,
          spendLimit: 100n,
          perTxLimit: 10n,
          discriminators: [GATED_ACTION_DISC],
        }),
      ],
      owner,
    )
    await chain.send(
      [await gatedActionIx({ agent, mandate, owner: owner.address, amount: 4n })],
      agent,
    )
    const m = await client.fetchMandate(mandate)
    assert(m?.permissions[0]?.spendTotal === 4n, 'gated spend_total 4 booked by the verify CPI')
  })

  await step('gated-example: gated_action(11) is refused with AgentAuth 8 PerTxExceeded', () =>
    expectProgramError(
      async () =>
        chain.send(
          [await gatedActionIx({ agent, mandate, owner: owner.address, amount: 11n })],
          agent,
        ),
      { program: 'agent_auth', code: 8, name: 'PerTxExceeded' },
    ),
  )

  await step('gated-example: cleanup (revoke_mandate)', async () => {
    await chain.send([await revokeMandateIx({ owner, agent: agent.address })], owner)
  })
}

/** Relay: onboarding, transfer, refused transfer, swap, unwind. Throwaway owner, shared mints and pool. */
async function relayRoundTrip(chain: DemoChain, env: DemoEnv): Promise<void> {
  const client = demoClient(env)
  const signers = await loadDemoSigners(env)
  const harness = signers.harness
  const owner = await generateKeyPairSigner()
  const agent = await generateKeyPairSigner()
  await chain.airdrop(owner.address, 2n * SOL)

  const dusd = env.mints.dusd.address
  const dout = env.mints.dout.address
  const ownerDusd = (await associatedTokenAddress(owner.address, dusd)).address
  const ownerDout = (await associatedTokenAddress(owner.address, dout)).address
  const mandate = (await mandatePda(owner.address, agent.address, env.programIds.agentAuth)).address

  await step('relay: fixture token accounts (throwaway owner, 10 DUSD)', async () => {
    await chain.send(
      [
        await createAtaIdempotentIx({ payer: harness, owner: owner.address, mint: dusd }),
        await createAtaIdempotentIx({ payer: harness, owner: owner.address, mint: dout }),
        mintToCheckedIx({
          mint: dusd,
          destination: ownerDusd,
          authority: harness,
          amount: parseUnits('10', 6),
          decimals: 6,
        }),
      ],
      harness,
    )
  })

  await step('relay: onboarding plan (2 transactions) lands', async () => {
    const plan = await client.plan.onboarding({
      owner,
      agent: agent.address,
      expiry: expiryIn(3600n),
      fundAgentLamports: 20_000_000n,
      token: { mint: dusd, source: ownerDusd, delegateCap: parseUnits('5', 6) },
      permissions: [
        {
          program: TOKEN_PROGRAM_ID,
          spendLimit: parseUnits('5', 6),
          perTxLimit: parseUnits('2', 6),
          discriminators: [TRANSFER_CHECKED_DISC],
        },
        {
          program: env.programIds.mockAmm,
          spendLimit: parseUnits('5', 6),
          perTxLimit: parseUnits('3', 6),
          discriminators: [SWAP_BASE_INPUT_DISC],
        },
      ],
      recipients: [env.tokenAccounts.harnessDusd],
      swap: { ...demoSwapConfig(env), inAccount: ownerDusd, outAccount: ownerDout },
    })
    assert(
      plan.steps.length === 2 && plan.steps.every((s) => s.fitsInOneTx),
      'two steps that each fit one transaction',
    )
    for (const s of plan.steps) await chain.send(s.instructions, owner)
    const view = await client.inspect(mandate, { budgetDecimals: 6 })
    assert(view.mandate !== null && view.policy !== null, 'mandate and relay policy exist')
    const acct = await fetchTokenAccount(chain, ownerDusd)
    assert(acct?.delegatedAmount === parseUnits('5', 6), 'SPL delegation is exactly the 5 DUSD cap')
  })

  const policy = await client.fetchPolicy(mandate)
  assert(policy !== null, 'policy readable')

  await step('relay: agent pays 1 DUSD to the allowlisted account', async () => {
    const before = await tokenBalance(chain, env.tokenAccounts.harnessDusd)
    await chain.send(
      [
        await relayTransferIx({
          agent,
          amount: parseUnits('1', 6),
          destination: env.tokenAccounts.harnessDusd,
          policy,
        }),
      ],
      agent,
    )
    assert(
      (await tokenBalance(chain, env.tokenAccounts.harnessDusd)) - before === parseUnits('1', 6),
      'recipient +1 DUSD',
    )
  })

  await step(
    'relay: a transfer to the attacker account is refused with relay 104 RecipientNotAllowed',
    () =>
      expectProgramError(
        async () =>
          chain.send(
            [
              await relayTransferIx({
                agent,
                amount: parseUnits('1', 6),
                destination: env.tokenAccounts.attackerDusd,
                policy,
              }),
            ],
            agent,
          ),
        { program: 'relay', code: 104, name: 'RecipientNotAllowed' },
      ),
  )

  await step('relay: pinned swap of 2 DUSD through the mock AMM pool', async () => {
    const [inRes, outRes] = await Promise.all([
      tokenBalance(chain, env.pool.vaultDusd),
      tokenBalance(chain, env.pool.vaultDout),
    ])
    const amountIn = parseUnits('2', 6)
    const expectedOut = (amountIn * outRes) / (inRes + amountIn)
    const slot = await chain.rpc.getSlot({ commitment: 'confirmed' }).send()
    await chain.send(
      [
        await relaySwapIx({
          agent,
          amountIn,
          minOut: 0n,
          deadlineSlot: BigInt(slot) + 100n,
          policy,
        }),
      ],
      agent,
    )
    const got = await tokenBalance(chain, ownerDout)
    assert(
      got === expectedOut && got >= (amountIn * 95n) / 100n,
      `swap output ${got} equals the constant-product ${expectedOut}`,
    )
  })

  await step(
    'relay: unwind in one transaction (Revoke, revoke_mandate, close_policy)',
    async () => {
      const plan = await client.plan.unwind({ owner, agent: agent.address })
      assert(plan.steps.length === 1, 'unwind is a single transaction')
      for (const s of plan.steps) await chain.send(s.instructions, owner)
      assert(
        (await client.fetchMandate(mandate)) === null &&
          (await client.fetchPolicy(mandate)) === null,
        'mandate and policy closed',
      )
      const acct = await fetchTokenAccount(chain, ownerDusd)
      assert(acct !== null && acct.delegate === null, 'SPL delegation cleared')
    },
  )
}

async function main(): Promise<void> {
  const started = Date.now()
  const env = await loadDemoEnv()
  const chain = connect({ rpcUrl: env.rpcUrl, wsUrl: env.wsUrl })
  console.log(`smoke against ${env.rpcUrl}${withRelay ? ' (--relay)' : ''}`)
  await step('environment matches the chain (genesis, programs, mints, pool)', async () => {
    const problems = await checkDemoEnv(env, chain)
    if (problems.length > 0) throw new Error(problems.join('; '))
  })
  await coreRoundTrip(chain, env)
  await gatedRoundTrip(chain, env)
  if (withRelay) await relayRoundTrip(chain, env)
  console.log(`smoke passed: ${passed} checks in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
