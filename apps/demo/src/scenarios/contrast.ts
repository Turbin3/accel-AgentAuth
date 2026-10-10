/**
 * pnpm --filter @agentauth-sol/demo contrast [--fast] [--json] [--transcript file]
 *
 * The SAME injected inbox against two agents:
 *   A. a naive hot-wallet agent: the agent holds the key that holds the funds.
 *   B. the mandate agent: it holds only its own key, no token authority, and acts through the relay.
 * The "agent brain" is a few lines of code that obey the injected text (a script, not an AI).
 */
import {
  associatedTokenAddress,
  relayTransferIx,
  transferCheckedIx,
  approveIx,
  TOKEN_PROGRAM_ID,
} from '@agentauth-sol/sdk'
import { generateKeyPairSigner } from '@solana/kit'
import { fetchTokenAccount, tokenBalance } from '../lib/env'
import { bootOrExit, dusd, fmt, fundsLostTracker, restock, units, DECIMALS } from './lib/ctx'
import { INBOX_INVOICE, parseInjection } from './lib/inbox'
import { setAccountOwnerIx } from './lib/ix'
import { clearStaleDelegation, onboardBeats, unwindBeat } from './lib/kit'
import { runMain } from './lib/run'
import { c, short } from './lib/ui'

const ctx = await bootOrExit('contrast', process.argv.slice(2))
const { run, env, chain, client, signers } = ctx
const dusdMint = env.mints.dusd.address

await runMain(run, async () => {
  run.banner('AgentAuth contrast: the same prompt injection, two agents', [
    'Local validator only. Unaudited devnet prototype. The attacker (MALLORY) and both agent brains are SCRIPTS, not AI.',
    'We do not stop the prompt injection. We cap what a fooled agent can do, on-chain.',
  ])

  const injection = parseInjection(INBOX_INVOICE)
  run.heading('The injected inbox (identical for both agents)')
  for (const line of INBOX_INVOICE.trimEnd().split('\n')) run.out(`  | ${line}`)
  run.say(
    `A fooled agent will therefore try to: pay ${injection.payee} ${injection.amount} DUSD, then take over the owner's account (approve a delegate, change the owner).`,
  )

  // ------------------------------------------------------------------------------------------
  run.heading('A. The naive hot-wallet agent', [
    'The agent runs with the key of the wallet that holds the funds. Whatever the injected text asks, the key can do.',
  ])
  const restocked = await restock(ctx, env.tokenAccounts.hotDusd, units(50))
  if (restocked > 0n)
    run.fact(
      `harness restocked the HOT account with ${dusd(restocked)} (setup, not part of the demo)`,
    )
  const hotBalance = await tokenBalance(chain, env.tokenAccounts.hotDusd)
  const lostA = await fundsLostTracker(ctx, [env.tokenAccounts.attackerDusdB])
  const boardA = run.newBoard('A: hot-wallet agent', lostA)
  run.fact(
    `HOT agent key ${short(signers.hot.address)} holds ${dusd(hotBalance)} in ${short(env.tokenAccounts.hotDusd)}`,
  )
  await run.attempt({
    id: 'A.1',
    title: 'Obey the injection: sweep everything to MALLORY in one transaction',
    doing: `TransferChecked of the whole balance (${dusd(hotBalance)}) from the HOT account to MALLORY ${short(env.tokenAccounts.attackerDusdB)}`,
    who: `HOT key ${short(signers.hot.address)} (the agent IS the wallet owner)`,
    actor: 'hot',
    scripted: true,
    signers: [signers.hot],
    build: () => [
      transferCheckedIx({
        source: env.tokenAccounts.hotDusd,
        mint: dusdMint,
        destination: env.tokenAccounts.attackerDusdB,
        authority: signers.hot,
        amount: hotBalance,
        decimals: DECIMALS,
      }),
    ],
    expect: { ok: true },
    why: 'nothing sits between a key that holds funds and the transfer: the loss is the whole balance',
    board: boardA,
  })
  const hotAfter = await tokenBalance(chain, env.tokenAccounts.hotDusd)
  if (hotAfter !== 0n) throw new Error(`the hot account should be empty, holds ${hotAfter}`)
  run.fact(`HOT account now ${dusd(hotAfter)}; MALLORY gained ${dusd(hotBalance)}`)

  // ------------------------------------------------------------------------------------------
  run.heading('B. The mandate agent', [
    'The owner keeps the funds and gives the agent a mandate: pay only the allowlisted payee, at most 5 DUSD per call and 20 DUSD in total, through the relay. The owner delegates a bounded 50 DUSD allowance to a PDA that only the relay can sign for.',
  ])
  const agent = await generateKeyPairSigner()
  const owner = signers.owner
  await restock(ctx, env.tokenAccounts.ownerDusd, units(100))
  await clearStaleDelegation(ctx, owner, env.tokenAccounts.ownerDusd)
  const { policy } = await onboardBeats(ctx, {
    owner,
    agent: agent.address,
    source: env.tokenAccounts.ownerDusd,
    out: env.tokenAccounts.ownerDout,
    recipients: [env.tokenAccounts.recipientDusd],
  })

  const ownerAcct = await fetchTokenAccount(chain, env.tokenAccounts.ownerDusd)
  if (ownerAcct === null) throw new Error('owner token account missing')
  const agentTokenAccounts = await chain.rpc
    .getTokenAccountsByOwner(agent.address, { programId: TOKEN_PROGRAM_ID }, { encoding: 'base64' })
    .send()
  const agentAta = (await associatedTokenAddress(agent.address, dusdMint)).address
  run.out()
  run.fact(`AGENT key (printed, throwaway): ${agent.address}`)
  run.fact(
    `the agent owns ${agentTokenAccounts.value.length} token accounts and its ATA ${short(agentAta)} does not exist; it holds fee SOL only`,
  )
  run.fact(
    `owner DUSD account ${short(env.tokenAccounts.ownerDusd)} is owned by OWNER ${short(ownerAcct.owner)}, delegate ${ownerAcct.delegate === null ? 'none' : short(ownerAcct.delegate)} (the relay authority PDA), delegated ${dusd(ownerAcct.delegatedAmount)}`,
  )
  if (ownerAcct.owner === agent.address || ownerAcct.delegate === agent.address) {
    throw new Error('the agent key must be neither owner nor delegate of the owner account')
  }

  const lostB = await fundsLostTracker(ctx, [
    env.tokenAccounts.attackerDusd,
    env.tokenAccounts.attackerDusdB,
    env.tokenAccounts.attackerDout,
  ])
  const boardB = run.newBoard('B: mandate agent', lostB)
  const ownerBefore = await tokenBalance(chain, env.tokenAccounts.ownerDusd)
  const attackerAcct = env.tokenAccounts.attackerDusd

  await run.attempt({
    id: 'B.1',
    title: `Obey the injection: pay ${injection.payee} ${injection.amount} DUSD through the relay`,
    doing: `relay transfer of ${injection.amount} DUSD to MALLORY ${short(attackerAcct)}`,
    who: `AGENT ${short(agent.address)} (its own key; no token authority)`,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: async () => [
      await relayTransferIx({
        agent,
        policy,
        destination: attackerAcct,
        amount: units(injection.amount.toString()),
      }),
    ],
    expect: { ok: false, program: 'relay', code: 104, name: 'RecipientNotAllowed' },
    why: 'the destination is not on the owner-pinned allowlist',
    board: boardB,
  })
  await run.attempt({
    id: 'B.2',
    title: 'Bypass the relay: raw SPL transfer of the whole owner balance, signed by the agent key',
    doing: `TransferChecked ${dusd(ownerBefore)} from the OWNER account to MALLORY ${short(attackerAcct)}`,
    who: `AGENT ${short(agent.address)}`,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: () => [
      transferCheckedIx({
        source: env.tokenAccounts.ownerDusd,
        mint: dusdMint,
        destination: attackerAcct,
        authority: agent,
        amount: ownerBefore,
        decimals: DECIMALS,
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'raised by the TOKEN program, not by AgentAuth or the relay: the agent key is neither the owner nor the delegate of the account',
    board: boardB,
  })
  await run.attempt({
    id: 'B.3',
    title: "Take over: approve MALLORY as delegate on the owner's account",
    doing: 'SPL Approve(delegate = MALLORY, 1000 DUSD) on the owner account',
    who: `AGENT ${short(agent.address)}`,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: async () => [
      await approveIx({
        source: env.tokenAccounts.ownerDusd,
        owner: agent,
        delegate: signers.attacker.address,
        amount: units(1000),
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'the Token program validates Approve against the account owner',
    board: boardB,
  })
  await run.attempt({
    id: 'B.4',
    title: "Take over: set MALLORY as the owner of the owner's account",
    doing: 'SPL SetAuthority(AccountOwner -> MALLORY) on the owner account',
    who: `AGENT ${short(agent.address)}`,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: () => [
      setAccountOwnerIx({
        account: env.tokenAccounts.ownerDusd,
        current: agent,
        newAuthority: signers.attacker.address,
      }),
    ],
    expect: { ok: false, program: 'token', code: 4, name: 'OwnerMismatch' },
    why: 'same: authority changes are checked by the Token program against the real owner',
    board: boardB,
  })
  await run.attempt({
    id: 'B.5',
    title: 'The legitimate invoice still works',
    doing: 'relay transfer of 3 DUSD to the allowlisted payee (ACME)',
    who: `AGENT ${short(agent.address)}`,
    actor: 'agent',
    signers: [agent],
    build: async () => [
      await relayTransferIx({
        agent,
        policy,
        destination: env.tokenAccounts.recipientDusd,
        amount: units(3),
      }),
    ],
    expect: { ok: true },
    board: boardB,
  })
  const ownerAfter = await tokenBalance(chain, env.tokenAccounts.ownerDusd)
  if (ownerBefore - ownerAfter !== units(3))
    throw new Error('the owner should be exactly 3 DUSD down')
  await unwindBeat(ctx, owner, agent.address, 'B.6')

  // ------------------------------------------------------------------------------------------
  run.heading('Result')
  const a = await boardA.snapshot()
  const b = await boardB.snapshot()
  const rows = [
    ['agent', 'attempted', 'blocked', 'allowed', 'funds lost to the attacker'],
    ['A hot-wallet agent', String(a.attempted), String(a.blocked), String(a.allowed), a.fundsLost],
    ['B mandate agent', String(b.attempted), String(b.blocked), String(b.allowed), b.fundsLost],
  ]
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
  for (const r of rows) run.out(`  ${r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`)
  if (a.fundsLost !== `${fmt(hotBalance)} DUSD/DOUT`) throw new Error(`side A lost ${a.fundsLost}`)
  if (b.fundsLost !== `${fmt(0n)} DUSD/DOUT`) throw new Error(`side B lost ${b.fundsLost}`)
  run.say(
    c.bold(
      'The key that holds funds lost everything. The mandate agent lost nothing: its only moves are to the pinned payee, up to the budget, and that budget is the blast radius.',
    ),
  )
  run.say(
    'Honest limits: the mandate agent can still pay the allowlisted payee and swap inside the pinned bounds up to the budget. Unaudited devnet prototype; local validator.',
  )
})
