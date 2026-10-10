/**
 * pnpm --filter @agentauth-sol/demo scenario [--fast] [--json] [--pause ms] [--transcript file]
 *
 * The full beat sequence of DEMO-SCRIPT.md on a local validator, every outcome asserted (exit
 * code 1 on any deviation). The "compromised agent" is a SCRIPT, labelled as such on every beat.
 * Numbers are DUSD (6 decimals) from the bootstrapped environment; amounts match the script.
 */
import {
  addPermissionIx,
  GATED_ACTION_DISC,
  mandatePda,
  relaySwapIx,
  relayTransferIx,
  removePermissionIx,
  setPausedIx,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  transferCheckedIx,
  updatePermissionIx,
  verifyIx,
  approveIx,
  type Mandate,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner, type Address, type Instruction } from '@solana/kit'
import { fetchTokenAccount, tokenBalance } from '../lib/env'
import { gatedActionIx } from '../lib/instructions'
import {
  bootOrExit,
  DECIMALS,
  dout,
  dusd,
  fmt,
  fundsLostTracker,
  restock,
  units,
  type Ctx,
} from './lib/ctx'
import { INBOX_INVOICE, parseInjection } from './lib/inbox'
import { ammSwapIx, setAccountOwnerIx, withData } from './lib/ix'
import { clearStaleDelegation, onboardBeats, unwindBeat } from './lib/kit'
import { runMain } from './lib/run'
import { c, short, table } from './lib/ui'

const ctx = await bootOrExit('scenario', process.argv.slice(2))
const { run, env, chain, client, signers } = ctx
const A = env.tokenAccounts
const dusdMint = env.mints.dusd.address
const owner = signers.owner

/** Constant-product output of the mock AMM for `amountIn`, from the live vaults (no fee). */
async function quote(amountIn: bigint): Promise<bigint> {
  const [inRes, outRes] = await Promise.all([
    tokenBalance(chain, env.pool.vaultDusd),
    tokenBalance(chain, env.pool.vaultDout),
  ])
  return (amountIn * outRes) / (inRes + amountIn)
}

interface Snap {
  ownerDusd: bigint
  ownerDout: bigint
  acme: bigint
  mallory: bigint
  malloryOut: bigint
  delegated: bigint
  /** Token / mock-AMM / gated-example slot lifetime spend, or null when the slot does not exist. */
  T: bigint | null
  M: bigint | null
  G: bigint | null
}

async function snapshot(mandate: Address): Promise<Snap> {
  const m: Mandate | null = await client.fetchMandate(mandate)
  const spend = (p: Address): bigint | null =>
    m?.permissions.find((x) => x.program === p)?.spendTotal ?? null
  const acct = await fetchTokenAccount(chain, A.ownerDusd)
  return {
    ownerDusd: acct?.amount ?? 0n,
    ownerDout: await tokenBalance(chain, A.ownerDout),
    acme: await tokenBalance(chain, A.recipientDusd),
    mallory: await tokenBalance(chain, A.attackerDusd),
    malloryOut: await tokenBalance(chain, A.attackerDout),
    delegated: acct?.delegate == null ? 0n : acct.delegatedAmount,
    T: spend(TOKEN_PROGRAM_ID),
    M: spend(env.programIds.mockAmm),
    G: spend(env.programIds.gatedExample),
  }
}

const render = (v: bigint | null): string => (v === null ? 'none' : fmt(v))

await runMain(run, async () => {
  run.banner('AgentAuth demo scenario: owner, mandate, relay, a fooled agent', [
    'Local validator only. Unaudited devnet prototype. Hard enforcement exists only for the relay transfer and the pinned swap; everything else a mandate lists is advisory unless the program calls verify.',
    'The compromised agent and MALLORY are SCRIPTS (labelled on every beat), not an AI. Failed transactions are landed on purpose (skipPreflight) so the failure is recorded on chain and visible in an explorer.',
    'We do not stop the prompt injection. We cap what a fooled agent can do, on-chain.',
    'Pool: a MOCK AMM speaking the Raydium CP-Swap ABI (test/demo program, not Raydium).',
  ])

  // ------------------------------------------------------------------------------------------
  // Setup (DEMO-SCRIPT section 1)
  // ------------------------------------------------------------------------------------------
  run.heading('Setup: the cast', [
    'OWNER (Alice) owns the funds and signs onboarding, revokes and the unwind. AGENT is a fresh throwaway key with fee SOL only. ACME is the one allowlisted payee. MALLORY is the scripted attacker. HOT is a naive agent whose own wallet holds funds (the control).',
  ])
  const agent = await generateKeyPairSigner()
  const restockedOwner = await restock(ctx, A.ownerDusd, units(300))
  const restockedHot = await restock(ctx, A.hotDusd, units(50))
  const restockedSearcher = await restock(ctx, A.harnessDusd, units(1000))
  if (restockedOwner + restockedHot + restockedSearcher > 0n) {
    run.fact(
      `harness restocked demo wallets (owner +${fmt(restockedOwner)}, hot +${fmt(restockedHot)}, searcher +${fmt(restockedSearcher)} DUSD): setup, not part of the story`,
    )
  }
  const start0 = await tokenBalance(chain, A.ownerDusd)
  run.fact(`OWNER ${short(owner.address)} holds ${dusd(start0)} in ${short(A.ownerDusd)}`)
  run.fact(`AGENT ${agent.address} (throwaway key, printed on purpose)`)
  run.fact(
    `ACME ${short(A.recipientDusd)} | MALLORY ${short(A.attackerDusd)} / ${short(A.attackerDout)} | pool ${short(env.pool.state)} (mock AMM)`,
  )

  // ------------------------------------------------------------------------------------------
  // Beat 1: control
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 1: control, the same injection against a hot-wallet agent', [
    'HOT is a normal agent keypair that holds 50 DUSD in its own token account. The injected invoice (below) tells it to pay MALLORY.',
  ])
  const injection = parseInjection(INBOX_INVOICE)
  for (const line of INBOX_INVOICE.trimEnd().split('\n')) run.out(`  | ${line}`)
  const lostA = await fundsLostTracker(ctx, [A.attackerDusdB])
  const boardA = run.newBoard('hot-wallet agent', lostA)
  const hotBalance = await tokenBalance(chain, A.hotDusd)
  await run.attempt({
    id: '1.1',
    title: 'Obey the injection with the key that holds the funds',
    doing: `TransferChecked ${dusd(hotBalance)} from HOT to MALLORY (${short(A.attackerDusdB)}) in one transaction`,
    who: `HOT key ${short(signers.hot.address)} (agent = wallet owner)`,
    actor: 'hot',
    scripted: true,
    signers: [signers.hot],
    build: () => [
      transferCheckedIx({
        source: A.hotDusd,
        mint: dusdMint,
        destination: A.attackerDusdB,
        authority: signers.hot,
        amount: hotBalance,
        decimals: DECIMALS,
      }),
    ],
    expect: { ok: true },
    why: 'a key that holds funds loses everything it can reach',
    board: boardA,
  })

  // ------------------------------------------------------------------------------------------
  // Onboarding (S1, S2)
  // ------------------------------------------------------------------------------------------
  run.heading('Onboarding: the owner gives AGENT a mandate (2 transactions)', [
    'Mandate: Token program / TransferChecked up to 20 DUSD (5 per call); mock AMM / swap up to 10 DUSD (5 per call); gated-example / gated_action up to 100 points (10 per call). One bounded 50 DUSD SPL delegation to the relay authority PDA. Relay policy: pay only ACME, swap only on the pinned pool with a 95-out-per-100-in floor.',
  ])
  await clearStaleDelegation(ctx, owner, A.ownerDusd)
  const { mandate, policy } = await onboardBeats(
    ctx,
    {
      owner,
      agent: agent.address,
      source: A.ownerDusd,
      out: A.ownerDout,
      recipients: [A.recipientDusd],
      gated: true,
    },
    'S',
  )
  const authority = policy.authority
  run.fact(`agent key ${short(agent.address)} owns 0 token accounts; it holds fee SOL only`)
  const afterOnboard = await fetchTokenAccount(chain, A.ownerDusd)
  if (afterOnboard?.delegate !== authority || afterOnboard.delegatedAmount !== units(50)) {
    throw new Error('the owner account should delegate exactly 50 DUSD to the relay authority')
  }
  run.fact(
    `OWNER DUSD account: owner ${short(afterOnboard.owner)}, delegate ${short(authority)} (relay authority PDA), delegated ${dusd(afterOnboard.delegatedAmount)}`,
  )

  const lostB = await fundsLostTracker(ctx, [A.attackerDusd, A.attackerDout])
  const board = run.newBoard('mandate agent', lostB)
  const model: Snap = await snapshot(mandate)
  const start = { ...model }
  const bump = (
    k: 'ownerDusd' | 'ownerDout' | 'acme' | 'mallory' | 'malloryOut' | 'delegated',
    d: bigint,
  ) => {
    model[k] += d
  }
  const spend = (k: 'T' | 'M' | 'G', d: bigint) => {
    model[k] = (model[k] ?? 0n) + d
  }
  const verifyLedger = async (label: string): Promise<void> => {
    const now = await snapshot(mandate)
    for (const k of Object.keys(model) as (keyof Snap)[]) {
      if (now[k] !== model[k]) {
        throw new Error(
          `ledger mismatch after ${label}: ${k} is ${render(now[k])}, expected ${render(model[k])}`,
        )
      }
    }
  }
  const panel = async (title: string): Promise<void> => {
    const now = await snapshot(mandate)
    run.out()
    run.out(c.bold(`  Balance panel: ${title}`))
    const rows: string[][] = [
      ['OWNER DUSD', fmt(now.ownerDusd), fmt(now.ownerDusd - start.ownerDusd)],
      ['OWNER DOUT', fmt(now.ownerDout), fmt(now.ownerDout - start.ownerDout)],
      ['ACME DUSD', fmt(now.acme), fmt(now.acme - start.acme)],
      ['MALLORY DUSD', fmt(now.mallory), fmt(now.mallory - start.mallory)],
      ['MALLORY DOUT', fmt(now.malloryOut), fmt(now.malloryOut - start.malloryOut)],
      ['SPL delegation left', fmt(now.delegated), ''],
      ['Token slot spend', render(now.T), ''],
      ['AMM slot spend', render(now.M), ''],
      ['gated slot spend (points)', now.G === null ? 'none' : now.G.toString(), ''],
    ]
    for (const l of table(['account', 'now', 'change since onboarding'], rows)) run.out(`    ${l}`)
  }

  const pay = async (destination: Address, amount: bigint): Promise<Instruction> =>
    relayTransferIx({ agent, policy, destination, amount })
  const swapIx = async (amountIn: bigint, minOut: bigint): Promise<Instruction> => {
    const slot = await chain.rpc.getSlot({ commitment: 'confirmed' }).send()
    return relaySwapIx({ agent, policy, amountIn, minOut, deadlineSlot: BigInt(slot) + 100n })
  }
  const agentWho = `AGENT ${short(agent.address)} (its own key, no token authority)`

  // ------------------------------------------------------------------------------------------
  // Beat 2: normal work
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 2: normal work', [
    'Inner instructions on an explorer: relay -> AgentAuth.verify -> Token.TransferChecked. The relay emits TransferExecuted / SwapExecuted events.',
  ])
  await run.attempt({
    id: '2.1',
    title: 'Pay the invoice: pay(ACME, 3 DUSD)',
    doing: 'relay transfer of 3 DUSD to the allowlisted payee ACME',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(3))],
    expect: { ok: true },
    board,
  })
  bump('ownerDusd', -units(3))
  bump('acme', units(3))
  bump('delegated', -units(3))
  spend('T', units(3))
  await verifyLedger('2.1')

  const out22 = await quote(units(5))
  await run.attempt({
    id: '2.2',
    title: 'Swap on the pinned pool: swap(5 DUSD, min_out 0)',
    doing: `relay swap of 5 DUSD for DOUT on the MOCK AMM pool; the pool alone would give ${dout(out22)}, the relay floor (95 out per 100 in) is ${dout((units(5) * 95n) / 100n)}`,
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await swapIx(units(5), 0n)],
    expect: { ok: true },
    why: 'min_out 0 from the agent is raised to the owner-set floor by the relay; the output lands in the OWNER account',
    board,
  })
  bump('ownerDusd', -units(5))
  bump('ownerDout', out22)
  bump('delegated', -units(5))
  spend('M', units(5))
  await verifyLedger('2.2')
  await panel('after normal work')

  // ------------------------------------------------------------------------------------------
  // Beat 3: the prompt injection
  // ------------------------------------------------------------------------------------------
  run.heading(
    'Beat 3: the prompt injection (SCRIPTED compromised agent). Every step must fail; nothing moves.',
    [
      `The inbox text above makes the agent attempt: pay ${injection.payee} ${injection.amount} DUSD, then take over the owner's account. Each attack is a real transaction landed on chain.`,
    ],
  )
  const attack = (spec: Parameters<typeof run.attempt>[0]) =>
    run.attempt({ ...spec, scripted: true, board })

  await attack({
    id: '3.1',
    title: `Drain to the attacker: pay MALLORY ${injection.amount} DUSD`,
    doing: `relay transfer of ${injection.amount} DUSD, destination = MALLORY ${short(A.attackerDusd)}`,
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.attackerDusd, units(injection.amount.toString()))],
    expect: { ok: false, program: 'relay', code: 104, name: 'RecipientNotAllowed' },
    why: 'the destination is not in the owner-pinned allowlist',
  })
  await attack({
    id: '3.2',
    title: 'Pay the allowed payee far above the per-call cap',
    doing:
      'relay transfer of 40 DUSD to ACME (the SPL delegation still has 42, so the relay passes and verify is the blocker)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(40))],
    expect: { ok: false, program: 'agent_auth', code: 8, name: 'PerTxExceeded' },
    why: 'per_tx_limit is 5 DUSD',
  })
  await attack({
    id: '3.3',
    title: 'Pay more than the whole delegation',
    doing: 'relay transfer of 90 DUSD to ACME (delegated amount left: 42)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(90))],
    expect: { ok: false, program: 'relay', code: 105, name: 'TokenAccountState' },
    why: 'the SPL delegation is an independent hard cap enforced by the Token program',
  })
  await attack({
    id: '3.4',
    title: 'Split the drain across five instructions in ONE transaction',
    doing:
      'five relay transfers of 5 DUSD each to ACME in a single transaction (3 already spent + 4 x 5 = 23 > the 20 DUSD lifetime limit)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => {
      const ixs: Instruction[] = []
      for (let i = 0; i < 5; i++) ixs.push(await pay(A.recipientDusd, units(5)))
      return ixs
    },
    expect: { ok: false, program: 'agent_auth', code: 9, name: 'SpendLimitExceeded' },
    why: 'the lifetime cap bites at the 4th instruction and the whole transaction reverts, so nothing lands. Disclosed limit L4: per_tx_limit is per verify call, so splitting inside a transaction is bounded by the lifetime cap, not by per_tx.',
  })
  await verifyLedger('3.4')
  await attack({
    id: '3.5',
    title: 'Raw SPL TransferChecked signed by the agent',
    doing: 'TransferChecked 40 DUSD from the OWNER account to MALLORY, no relay',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: () => [
      transferCheckedIx({
        source: A.ownerDusd,
        mint: dusdMint,
        destination: A.attackerDusd,
        authority: agent,
        amount: units(40),
        decimals: DECIMALS,
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'raised by the TOKEN program: the agent key is neither the owner nor the delegate',
  })
  await attack({
    id: '3.6',
    title: 'Authority change on the program the agent is otherwise allowed to use: Approve',
    doing: 'raw Token.Approve(delegate = MALLORY, 1000 DUSD) on the OWNER account',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [
      await approveIx({
        source: A.ownerDusd,
        owner: agent,
        delegate: signers.attacker.address,
        amount: units(1000),
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'Token validates Approve against the account owner (any wallet behaves like this)',
  })
  await attack({
    id: '3.7',
    title: 'Authority change: SetAuthority',
    doing: 'raw Token.SetAuthority(AccountOwner -> MALLORY) on the OWNER account',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: () => [
      setAccountOwnerIx({
        account: A.ownerDusd,
        current: agent,
        newAuthority: signers.attacker.address,
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'same check, same Token program error',
  })
  await attack({
    id: '3.8',
    title: 'Approve through the relay',
    doing: 'relay instruction with tag 5 (the relay has no authority-changing instruction)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [withData(await pay(A.recipientDusd, units(1)), new Uint8Array([5]))],
    expect: { ok: false, program: 'relay', code: 100, name: 'InvalidInstructionData' },
    why: 'unknown tag',
  })
  await attack({
    id: '3.9',
    title: "Swap output into the attacker's account",
    doing: 'relay swap with out_account = MALLORY DOUT',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => {
      const slot = await chain.rpc.getSlot({ commitment: 'confirmed' }).send()
      return [
        await relaySwapIx({
          agent,
          policy,
          amountIn: units(5),
          minOut: 0n,
          deadlineSlot: BigInt(slot) + 100n,
          accountOverrides: { outAccount: A.attackerDout },
        }),
      ]
    },
    expect: { ok: false, program: 'relay', code: 102, name: 'AccountMismatch' },
    why: 'out_account is pinned in the policy',
  })
  await attack({
    id: '3.10',
    title: 'Ask the mandate itself whether Approve is allowed',
    doing: 'direct AgentAuth.verify(Token, Approve discriminator [4,0,0,0,0,0,0,0], 0)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: () => [
      verifyIx({
        mandate,
        owner: owner.address,
        agent,
        targetProgram: TOKEN_PROGRAM_ID,
        discriminator: new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0]),
        amount: 0n,
      }),
    ],
    expect: { ok: false, program: 'agent_auth', code: 7, name: 'DiscriminatorNotAllowed' },
    why: 'the mandate gates by (program, instruction): TransferChecked yes, Approve no. This is the standard any wallet or program can call; it is not what stopped the attacks above.',
  })
  await verifyLedger('beat 3')
  await panel('after the injection (ten attacks, all failed)')
  run.say(
    'Raw SPL attempts (3.5-3.7): Token OwnerMismatch x3, any wallet does this. The relay and AgentAuth blocked the rest.',
  )

  // ------------------------------------------------------------------------------------------
  // Beat 4: second integrator
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 4: the second integrator', [
    'gated-example is a ~100 line program with nothing to do with the relay. It calls AgentAuth.verify itself, so the same mandate gates it. Units are "points".',
  ])
  await run.attempt({
    id: '4.1',
    title: 'gated_action(4)',
    doing: 'gated-example gated_action with amount 4 (limit per call 10)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await gatedActionIx({ agent, mandate, owner: owner.address, amount: 4n })],
    expect: { ok: true },
    board,
  })
  spend('G', 4n)
  await run.attempt({
    id: '4.2',
    title: 'gated_action(11)',
    doing: 'gated-example gated_action with amount 11',
    who: agentWho,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: async () => [await gatedActionIx({ agent, mandate, owner: owner.address, amount: 11n })],
    expect: { ok: false, program: 'agent_auth', code: 8, name: 'PerTxExceeded' },
    why: 'same mandate, a program that has nothing to do with the relay, enforced by one CPI',
    board,
  })
  await verifyLedger('beat 4')

  // ------------------------------------------------------------------------------------------
  // Beat 5: live per-instruction revoke
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 5: per-instruction control by the owner, live', [
    'The owner edits the mandate while the agent is running. remove_permission deletes a program slot; re-adding it with a different discriminator list changes which INSTRUCTIONS of that program are allowed.',
  ])
  await run.attempt({
    id: '5.1',
    title: 'Owner removes the Token permission',
    doing:
      'AgentAuth remove_permission(Token program): the whole Token slot goes; the AMM and gated slots stay',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [
      await removePermissionIx({ owner, agent: agent.address, program: TOKEN_PROGRAM_ID }),
    ],
    expect: { ok: true },
  })
  model.T = null
  await run.attempt({
    id: '5.2',
    title: 'The agent tries to pay ACME 1 DUSD',
    doing: 'relay transfer of 1 DUSD to ACME',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(1))],
    expect: { ok: false, program: 'agent_auth', code: 6, name: 'ProgramNotAllowed' },
    why: 'the whole Token slot is gone (error 6, not 7: the program is not allowed at all)',
    board,
  })
  const out53 = await quote(units(5))
  await run.attempt({
    id: '5.3',
    title: 'The swap still works on the same mandate',
    doing: 'relay swap of 5 DUSD (the AMM slot is untouched)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await swapIx(units(5), 0n)],
    expect: { ok: true },
    board,
  })
  bump('ownerDusd', -units(5))
  bump('ownerDout', out53)
  bump('delegated', -units(5))
  spend('M', units(5))
  await verifyLedger('5.3')
  await run.attempt({
    id: '5.4',
    title: 'Owner re-adds Token with a DIFFERENT instruction list',
    doing:
      'AgentAuth add_permission(Token, 20 DUSD, 5 per call, discriminators [3,0,0,0,0,0,0,0] = the legacy unchecked Transfer only)',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [
      await addPermissionIx({
        owner,
        agent: agent.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: units(20),
        perTxLimit: units(5),
        discriminators: [new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0])],
      }),
    ],
    expect: { ok: true },
  })
  model.T = 0n
  await run.attempt({
    id: '5.5',
    title: 'The agent tries to pay ACME 1 DUSD again',
    doing: 'relay transfer of 1 DUSD to ACME (the relay asks verify for TransferChecked)',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(1))],
    expect: { ok: false, program: 'agent_auth', code: 7, name: 'DiscriminatorNotAllowed' },
    why: 'same program (Token), different instruction: the slot now allows only discriminator 3',
    board,
  })
  await run.attempt({
    id: '5.6',
    title: 'Owner restores the TransferChecked permission',
    doing:
      'remove_permission(Token) then add_permission(Token, 20 DUSD, 5 per call, [TransferChecked]) in one transaction (counters restart at 0 by core design)',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [
      await removePermissionIx({ owner, agent: agent.address, program: TOKEN_PROGRAM_ID }),
      await addPermissionIx({
        owner,
        agent: agent.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: units(20),
        perTxLimit: units(5),
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ],
    expect: { ok: true },
  })
  model.T = 0n
  await run.attempt({
    id: '5.7',
    title: 'One more swap exhausts the AMM lifetime limit',
    doing: 'relay swap of 5 DUSD (AMM slot spend 10 of 10)',
    who: agentWho,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: async () => [await swapIx(units(5), 0n)],
    expect: { ok: false, program: 'agent_auth', code: 9, name: 'SpendLimitExceeded' },
    why: 'lifetime limit reached',
    board,
  })
  await verifyLedger('beat 5')

  // ------------------------------------------------------------------------------------------
  // Beat 6: pause / resume
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 6: the reversible kill switch')
  await run.attempt({
    id: '6.1a',
    title: 'Owner pauses the relay policy',
    doing: 'relay set_paused(1)',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [await setPausedIx({ owner, agent: agent.address, paused: true })],
    expect: { ok: true },
  })
  await run.attempt({
    id: '6.1b',
    title: 'The agent tries to pay while paused',
    doing: 'relay transfer of 1 DUSD to ACME',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(1))],
    expect: { ok: false, program: 'relay', code: 116, name: 'Paused' },
    board,
  })
  await run.attempt({
    id: '6.2a',
    title: 'Owner resumes',
    doing: 'relay set_paused(0)',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [await setPausedIx({ owner, agent: agent.address, paused: false })],
    expect: { ok: true },
  })
  await run.attempt({
    id: '6.2b',
    title: 'The agent pays again',
    doing: 'relay transfer of 1 DUSD to ACME',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(1))],
    expect: { ok: true },
    board,
  })
  bump('ownerDusd', -units(1))
  bump('acme', units(1))
  bump('delegated', -units(1))
  spend('T', units(1))
  await verifyLedger('beat 6')

  // ------------------------------------------------------------------------------------------
  // Beat 7: price floor (mock only)
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 7: the static price floor (MOCK pool only)', [
    'A searcher account moves the pool price first; the relay passes its own floor (not the agent min_out of 0) to the AMM. Static price guard, not MEV protection: a swap that lands inside the floor can still lose up to 5%.',
  ])
  await run.attempt({
    id: '7.0',
    title: 'Owner raises the AMM lifetime limit so the agent can try again',
    doing: 'AgentAuth update_permission(mock AMM, 30 DUSD lifetime, 5 per call); counters are kept',
    who: `OWNER ${short(owner.address)}`,
    actor: 'owner',
    signers: [owner],
    build: async () => [
      await updatePermissionIx({
        owner,
        agent: agent.address,
        program: env.programIds.mockAmm,
        spendLimit: units(30),
        perTxLimit: units(5),
      }),
    ],
    expect: { ok: true },
  })
  const searcherIn = ((await tokenBalance(chain, env.pool.vaultDusd)) * 6n) / 100n
  const searcherOutBefore = await tokenBalance(chain, A.harnessDout)
  const poolBefore = [
    await tokenBalance(chain, env.pool.vaultDusd),
    await tokenBalance(chain, env.pool.vaultDout),
  ]
  const swapFor = (payerIn: 'dusd' | 'dout', amountIn: bigint): Instruction =>
    ammSwapIx({
      programId: env.programIds.mockAmm,
      payer: signers.harness,
      authority: env.pool.authority,
      config: env.pool.config,
      pool: env.pool.state,
      inAccount: payerIn === 'dusd' ? A.harnessDusd : A.harnessDout,
      outAccount: payerIn === 'dusd' ? A.harnessDout : A.harnessDusd,
      inVault: payerIn === 'dusd' ? env.pool.vaultDusd : env.pool.vaultDout,
      outVault: payerIn === 'dusd' ? env.pool.vaultDout : env.pool.vaultDusd,
      inMint: payerIn === 'dusd' ? dusdMint : env.mints.dout.address,
      outMint: payerIn === 'dusd' ? env.mints.dout.address : dusdMint,
      observation: env.pool.observation,
      amountIn,
      minOut: 0n,
    })
  await run.attempt({
    id: '7.1',
    title: 'A "searcher" moves the pool price',
    doing: `harness account swaps ${dusd(searcherIn)} DUSD for DOUT directly on the mock pool (not the agent, no relay)`,
    who: `SEARCHER (harness) ${short(signers.harness.address)}`,
    actor: 'harness',
    signers: [signers.harness],
    build: () => [swapFor('dusd', searcherIn)],
    expect: { ok: true },
  })
  const searcherGot = (await tokenBalance(chain, A.harnessDout)) - searcherOutBefore
  const agentWouldGet = await quote(units(5))
  await run.attempt({
    id: '7.2',
    title: 'The agent swaps 5 DUSD at the distorted price',
    doing: `relay swap(5 DUSD, min_out 0); the pool would now pay only ${dout(agentWouldGet)} (floor ${dout((units(5) * 95n) / 100n)})`,
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await swapIx(units(5), 0n)],
    expect: { ok: false, program: 'mock_amm', code: 7001, name: 'ExceededSlippage' },
    why: "the relay passed eff_min = max(agent min_out, floor) to the AMM, which refused; nothing moves. With the real Raydium CPMM the AMM's own slippage error replaces mock 7001. A static price guard, not MEV protection.",
    board,
  })
  await run.attempt({
    id: '7.3',
    title: 'Housekeeping: the searcher swaps back so the shared pool is restored',
    doing: `harness swaps ${dout(searcherGot)} back to DUSD`,
    who: `SEARCHER (harness) ${short(signers.harness.address)}`,
    actor: 'harness',
    signers: [signers.harness],
    build: () => [swapFor('dout', searcherGot)],
    expect: { ok: true },
  })
  const poolAfter = [
    await tokenBalance(chain, env.pool.vaultDusd),
    await tokenBalance(chain, env.pool.vaultDout),
  ]
  run.fact(
    `pool reserves before ${fmt(poolBefore[0] ?? 0n)} / ${fmt(poolBefore[1] ?? 0n)}, after the round trip ${fmt(poolAfter[0] ?? 0n)} / ${fmt(poolAfter[1] ?? 0n)} (rounding only)`,
  )
  await verifyLedger('beat 7')

  // ------------------------------------------------------------------------------------------
  // Beat 8: unwind and the failed follow-up
  // ------------------------------------------------------------------------------------------
  run.heading('Beat 8: one-transaction unwind, then the agent tries again')
  const rentMandate = await chain.balance(mandate)
  const rentPolicy = await chain.balance(policy.address as Address)
  const ownerSolBefore = await chain.balance(owner.address)
  await unwindBeat(ctx, owner, agent.address, '8.1')
  const ownerSolAfter = await chain.balance(owner.address)
  const returned = ownerSolAfter - ownerSolBefore
  const rents = rentMandate + rentPolicy
  if (returned > rents || returned < rents - 20_000n) {
    throw new Error(`rent returned ${returned} lamports, expected about ${rents} minus the fee`)
  }
  run.fact(
    `rent returned to the owner: mandate ${rentMandate} + policy ${rentPolicy} lamports (owner balance +${returned} after the fee)`,
  )
  const after = await fetchTokenAccount(chain, A.ownerDusd)
  if (
    after === null ||
    after.delegate !== null ||
    after.delegatedAmount !== 0n ||
    after.amount !== model.ownerDusd
  ) {
    throw new Error(
      'after the unwind the owner account must have no delegate and an intact balance',
    )
  }
  run.fact(`8.2 OWNER DUSD account: delegate none, balance ${dusd(after.amount)} (intact)`)
  await run.attempt({
    id: '8.3',
    title: 'The agent retries the legitimate payment',
    doing: 'relay transfer of 1 DUSD to ACME after the unwind',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    build: async () => [await pay(A.recipientDusd, units(1))],
    expect: { ok: false, program: 'relay', code: 101, name: 'InvalidPolicy' },
    why: 'the policy is closed',
    board,
  })
  if (
    (await client.fetchMandate(mandate)) !== null ||
    (await client.fetchPolicy(mandate)) !== null
  ) {
    throw new Error('mandate and policy should be gone after the unwind')
  }

  // ------------------------------------------------------------------------------------------
  run.heading('Result')
  const a = await boardA.snapshot()
  const b = await board.snapshot()
  for (const l of table(
    ['phase', 'attempted', 'blocked', 'allowed', 'funds lost'],
    [a, b].map((s) => [
      s.title,
      String(s.attempted),
      String(s.blocked),
      String(s.allowed),
      s.fundsLost,
    ]),
  ))
    run.out(`  ${l}`)
  if (a.fundsLost !== `${fmt(hotBalance)} DUSD/DOUT`)
    throw new Error(`the control should lose ${fmt(hotBalance)}, lost ${a.fundsLost}`)
  if (b.fundsLost !== `${fmt(0n)} DUSD/DOUT`)
    throw new Error(`the mandate agent lost funds: ${b.fundsLost}`)
  const now = await snapshot(mandate)
  if (now.mallory - start.mallory !== 0n || now.malloryOut - start.malloryOut !== 0n) {
    throw new Error('MALLORY holds funds')
  }
  run.say(
    'Honest limits: the agent could still move money to its pinned payee and into in-bounds swaps, up to the budget (the blast radius). AgentAuth is the authorization standard; the relay is its first integrator and makes it binding for two actions. Unaudited devnet prototype; this ran on a local validator with a mock AMM.',
  )
})
