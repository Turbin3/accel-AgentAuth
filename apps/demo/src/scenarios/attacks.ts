/**
 * pnpm --filter @agentauth-sol/demo attacks [--fast] [--json] [--transcript file]
 *
 * SCRIPTED compromised agent: a deterministic attack suite. Every attack is a real transaction
 * landed on a local validator with only what an agent key (or a stranger's key) can sign through
 * the real instructions. Each must end in its documented outcome, and after every attack the
 * balances, the SPL delegation, the pool reserves and the mandate counters must be exactly as
 * before. References (A01...) are the threat IDs of RELAY-SPEC section 15.
 */
import {
  addPermissionIx,
  approveIx,
  closePolicyIx,
  createMandateIx,
  initPolicyIx,
  mandatePda,
  parseProgramError,
  relayPolicyPda,
  relaySwapIx,
  relayTransferIx,
  revokeDelegateIx,
  revokeMandateIx,
  setActiveIx,
  setPausedIx,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
  transferCheckedIx,
  updatePermissionIx,
  verifyIx,
  systemTransferIx,
  type RelayPolicy,
} from '@agentauth-sol/sdk'
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import { fetchTokenAccount, tokenBalance } from '../lib/env'
import {
  bootOrExit,
  DECIMALS,
  dusd,
  fundsLostTracker,
  makeVictim,
  units,
  type Ctx,
} from './lib/ctx'
import {
  appendAccount,
  closeAccountIx,
  dropAccount,
  proxyIx,
  replaceAccount,
  setAccountOwnerIx,
  unsign,
  withData,
} from './lib/ix'
import { onboardQuiet, unwindBeat } from './lib/kit'
import { runMain, type Expect, type SendOutcome } from './lib/run'
import { c, short, sleep, table } from './lib/ui'

const ctx = await bootOrExit('attacks', process.argv.slice(2))
const { run, env, chain, client, signers } = ctx
const A = env.tokenAccounts
const dusdMint = env.mints.dusd.address
const doutMint = env.mints.dout.address

type Klass = 'BLOCKED' | 'NEUTRALISED' | 'ACCEPTED LIMIT'
interface Row {
  id: string
  ref: string
  title: string
  klass: Klass
  outcome: string
  unchanged: boolean
}
const rows: Row[] = []

/** Everything an attack must not change. */
async function stateOf(
  victim: { dusd: Address; dout: Address },
  mandate: Address,
): Promise<string> {
  const accounts: Record<string, Address> = {
    victimDusd: victim.dusd,
    victimDout: victim.dout,
    acme: A.recipientDusd,
    malloryDusd: A.attackerDusd,
    malloryDout: A.attackerDout,
    malloryDusdB: A.attackerDusdB,
    vaultDusd: env.pool.vaultDusd,
    vaultDout: env.pool.vaultDout,
  }
  const entries: string[] = []
  for (const [k, a] of Object.entries(accounts))
    entries.push(`${k}=${await tokenBalance(chain, a)}`)
  const t = await fetchTokenAccount(chain, victim.dusd)
  entries.push(`delegate=${t?.delegate ?? 'none'}`, `delegated=${t?.delegatedAmount ?? 0n}`)
  const m = await client.fetchMandate(mandate)
  entries.push(
    `mandate=${m === null ? 'none' : m.permissions.map((p) => `${p.program}:${p.spendTotal}:${p.callCount}`).join(',')}`,
  )
  return entries.join(' ')
}

await runMain(run, async () => {
  run.banner('AgentAuth attack suite: SCRIPTED compromised agent', [
    'Local validator only. Unaudited devnet prototype. Every attacker below is a SCRIPT. Each attack is landed on chain (skipPreflight) with only keys an agent or stranger could hold, through the real instructions.',
    'Pass criteria: the documented error, and afterwards balances, SPL delegation, pool reserves and mandate counters are exactly as before. Hard enforcement exists only for the relay transfer and the pinned swap; the other rejections come from AgentAuth itself, the Token program, the runtime or the mock AMM, and are named as such.',
  ])

  // ---------------------------------------------------------------------------------------
  // Fixture: a throwaway victim so the demo wallets never drift.
  // ---------------------------------------------------------------------------------------
  run.heading('Fixture: a fresh victim, a fresh agent, one mandate with a relay policy')
  const victim = await makeVictim(ctx, units(200))
  const agent = await generateKeyPairSigner()
  const attackerWallet = signers.attacker
  const { mandate, policy } = await onboardQuiet(ctx, {
    owner: victim.owner,
    agent: agent.address,
    source: victim.dusd,
    out: victim.dout,
    recipients: [A.recipientDusd],
  })
  run.fact(
    `victim OWNER ${short(victim.owner.address)} holds ${dusd(await tokenBalance(chain, victim.dusd))}; delegated 50 DUSD to the relay authority ${short(policy.authority)}`,
  )
  run.fact(`AGENT ${agent.address} (the compromised key, throwaway)`)
  run.fact(
    'mandate: Token/TransferChecked 20 DUSD lifetime, 5 per call; mock AMM/swap 10 / 5; relay policy pays only ACME and swaps only on the pinned pool',
  )

  const lost = await fundsLostTracker(ctx, [A.attackerDusd, A.attackerDout, A.attackerDusdB])
  const board = run.newBoard('attack suite', lost)
  let baseline = await stateOf(victim, mandate)
  const rebase = async (): Promise<void> => {
    baseline = await stateOf(victim, mandate)
  }

  const pay1 = async (): Promise<Instruction> =>
    relayTransferIx({ agent, policy, destination: A.recipientDusd, amount: units(1) })
  const swap5 = async (
    overrides?: Parameters<typeof relaySwapIx>[0]['accountOverrides'],
    deadline?: bigint,
  ) => {
    const slot = BigInt(await chain.rpc.getSlot({ commitment: 'confirmed' }).send())
    return relaySwapIx({
      agent,
      policy,
      amountIn: units(5),
      minOut: 0n,
      deadlineSlot: deadline ?? slot + 100n,
      ...(overrides !== undefined ? { accountOverrides: overrides } : {}),
    })
  }

  let n = 0
  interface AttackDef {
    ref: string
    title: string
    doing: string
    why: string
    build: () => Promise<readonly Instruction[]> | readonly Instruction[]
    expect: Expect
    /** Default: the agent signs and pays. */
    signers?: readonly TransactionSigner[]
    who?: string
    actor?: 'agent' | 'attacker'
    klass?: Klass
    /** The attack is meant to change state (a documented acceptance); skip the unchanged check. */
    changes?: boolean
  }
  const agentWho = `AGENT ${short(agent.address)} (compromised key)`
  const attack = async (d: AttackDef): Promise<void> => {
    n++
    const id = `AT-${String(n).padStart(2, '0')}`
    const rec = await run.attempt({
      id,
      title: `${d.ref}  ${d.title}`,
      doing: d.doing,
      who: d.who ?? agentWho,
      actor: d.actor ?? 'agent',
      scripted: true,
      signers: d.signers ?? [agent],
      build: d.build,
      expect: d.expect,
      why: d.why,
      board,
    })
    let unchanged = true
    if (d.changes !== true) {
      const now = await stateOf(victim, mandate)
      unchanged = now === baseline
      if (!unchanged)
        throw new Error(`${id} changed protected state:\n  before ${baseline}\n  after  ${now}`)
      run.out(
        `  state     balances, delegation, pool and mandate counters unchanged ${c.green('(verified)')}`,
      )
    } else {
      await rebase()
    }
    rows.push({
      id,
      ref: d.ref,
      title: d.title,
      klass: d.klass ?? 'BLOCKED',
      outcome: rec.error
        ? `${rec.error.program} ${rec.error.code} ${rec.error.name}`
        : d.expect.ok
          ? 'succeeded'
          : 'rejected',
      unchanged,
    })
  }

  const rel = (program: 'relay', code: number, name: string): Expect => ({
    ok: false,
    program,
    code,
    name,
  })
  const core = (code: number, name: string): Expect => ({
    ok: false,
    program: 'agent_auth',
    code,
    name,
  })
  const tok = (code: number, name: string): Expect => ({ ok: false, program: 'token', code, name })

  // ---------------------------------------------------------------------------------------
  run.heading('Group 1: account substitution and confused deputy (relay transfer, RELAY-SPEC 15.1)')
  const base = await pay1()
  if ((base.accounts ?? []).length !== 10)
    throw new Error('relay transfer should carry 10 accounts')
  // account order: 0 agent, 1 mandate, 2 owner, 3 policy, 4 authority, 5 source, 6 destination, 7 mint, 8 token program, 9 agentauth
  const policyAddr = policy.address as Address
  const attackerOwner = await generateKeyPairSigner()
  const agent2 = await generateKeyPairSigner()
  await chain.airdrop(attackerOwner.address, 1_000_000_000n)
  await chain.airdrop(agent2.address, 100_000_000n)

  await attack({
    ref: 'A01',
    title: 'fake mandate: a token account in the mandate slot',
    doing: 'relay transfer whose mandate account is a Token-program account the attacker controls',
    build: () => [replaceAccount(base, 1, A.attackerDusd)],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: 'the mandate must be owned by AgentAuth, 2136 bytes, with the right discriminator',
  })
  await attack({
    ref: 'A01',
    title: 'fake mandate: a system account in the mandate slot',
    doing: "relay transfer whose mandate account is the attacker's wallet",
    build: () => [replaceAccount(base, 1, attackerWallet.address)],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: 'same check, different fake',
  })
  await attack({
    ref: 'A02',
    title: 'fake AgentAuth program',
    doing:
      'relay transfer whose agentauth_program account is the mock AMM (a program that would answer Ok)',
    build: () => [replaceAccount(base, 9, env.programIds.mockAmm)],
    expect: rel('relay', 103, 'WrongProgram'),
    why: 'the relay CPIs to its compiled AgentAuth id and refuses any other account in that slot',
  })
  await attack({
    ref: 'A03',
    title: 'fake Token program',
    doing: 'relay transfer whose token_program account is the mock AMM',
    build: () => [replaceAccount(base, 8, env.programIds.mockAmm)],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'token_program is pinned in the policy',
  })
  await attack({
    ref: 'A04',
    title: 'fake policy: the mandate account in the policy slot',
    doing: 'relay transfer whose policy account is the (AgentAuth-owned) mandate',
    build: () => [replaceAccount(base, 3, mandate)],
    expect: rel('relay', 101, 'InvalidPolicy'),
    why: 'the policy must be owned by the relay with the right length, discriminator and version',
  })
  // The attacker's own mandate + policy (a real, valid pair) for the cross-mandate attacks.
  const mandate2 = (
    await mandatePda(attackerOwner.address, agent2.address, env.programIds.agentAuth)
  ).address
  const policy2Addr = (await relayPolicyPda(mandate2, env.programIds.relay)).address
  await run.attempt({
    id: 'AT-setup',
    title:
      "The attacker builds a REAL mandate + relay policy of their own that names the victim's token account as source",
    doing:
      'create_mandate, add_permission(Token, unlimited), init_policy(source = victim DUSD account, recipients = [MALLORY]) signed by a fresh attacker-owned wallet',
    who: `ATTACKER OWNER ${short(attackerOwner.address)} (a stranger; allowed to create mandates of its own)`,
    actor: 'harness',
    scripted: true,
    signers: [attackerOwner],
    build: async () => [
      await createMandateIx({
        owner: attackerOwner,
        agent: agent2.address,
        expiry: (await client.getClusterTime()) + 3600n,
      }),
      await addPermissionIx({
        owner: attackerOwner,
        agent: agent2.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: 'unlimited',
        perTxLimit: 'unlimited',
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ],
    expect: { ok: true },
  })
  await run.attempt({
    id: 'AT-setup',
    title: 'Attacker policy: init_policy pinning the victim account as source',
    doing:
      'relay init_policy by the attacker owner (the relay does not know whose token account it is)',
    who: `ATTACKER OWNER ${short(attackerOwner.address)}`,
    actor: 'harness',
    scripted: true,
    signers: [attackerOwner],
    build: async () => [
      await initPolicyIx({
        owner: attackerOwner,
        agent: agent2.address,
        config: {
          tokenProgram: TOKEN_PROGRAM_ID,
          budgetMint: dusdMint,
          sourceAccount: victim.dusd,
          recipients: [A.attackerDusd],
          swap: null,
        },
      }),
    ],
    expect: { ok: true },
  })
  const policy2 = await client.fetchPolicy(mandate2)
  if (policy2 === null) throw new Error('attacker policy missing')
  await attack({
    ref: 'A05',
    title: 'cross-mandate mixing: the attacker mandate and policy under the victim agent key',
    doing:
      "agent key signs a relay transfer whose mandate, policy and authority are the ATTACKER's",
    build: () => [
      replaceAccount(
        replaceAccount(replaceAccount(base, 1, mandate2), 3, policy2Addr),
        4,
        policy2.authority,
      ),
    ],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: "the mandate's agent field is not the signer",
  })
  await attack({
    ref: 'A06',
    title: "attacker mandate + policy pinning the VICTIM's source account",
    doing:
      "the attacker's own agent key calls relay transfer 5 DUSD from the victim account to MALLORY under the attacker's own, valid mandate",
    signers: [agent2],
    who: `ATTACKER AGENT ${short(agent2.address)} (valid agent of the attacker's own mandate)`,
    actor: 'attacker',
    build: async () => [
      await relayTransferIx({
        agent: agent2,
        policy: policy2,
        destination: A.attackerDusd,
        amount: units(5),
      }),
    ],
    expect: rel('relay', 105, 'TokenAccountState'),
    why: "the victim never delegated to the attacker mandate's authority PDA: the source delegate is not that PDA",
  })
  await attack({
    ref: 'A07',
    title: 'source substitution within the same owner',
    doing: "relay transfer with the owner's DOUT account as source",
    build: () => [replaceAccount(base, 5, victim.dout)],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'source is pinned in the policy',
  })
  await attack({
    ref: 'A08',
    title: 'mint substitution',
    doing: 'relay transfer with the DOUT mint in the mint slot',
    build: () => [replaceAccount(base, 7, doutMint)],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'budget_mint is pinned in the policy',
  })
  await attack({
    ref: 'A09',
    title: 'authority PDA substitution',
    doing: "relay transfer with the agent's own address as the authority",
    build: () => [replaceAccount(base, 4, agent.address)],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'authority is pinned and derived from the mandate: a wrong PDA cannot be signed for',
  })
  await attack({
    ref: 'A10',
    title: 'aliasing: mandate == policy',
    doing: 'relay transfer where the mandate slot holds the policy address',
    build: () => [replaceAccount(base, 1, policyAddr)],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: 'a relay-owned account is not a mandate',
  })
  await attack({
    ref: 'A10',
    title: 'aliasing: owner == agent',
    doing: "relay transfer where the owner slot holds the agent's own address",
    build: () => [replaceAccount(base, 2, agent.address)],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: 'the mandate names a different owner',
  })
  await attack({
    ref: 'A10',
    title: 'aliasing: destination == source',
    doing: "relay transfer whose destination is the owner's own source account",
    build: () => [replaceAccount(base, 6, victim.dusd)],
    expect: rel('relay', 104, 'RecipientNotAllowed'),
    why: 'destination must be an allowlisted account and never the source',
  })
  await attack({
    ref: 'A11',
    title: 'missing account',
    doing: 'relay transfer with the last account (agentauth_program) left out',
    build: () => [dropAccount(base, 9)],
    expect: { ok: false, program: 'runtime', code: -1, name: 'NotEnoughAccountKeys' },
    why: 'exact account count: the relay refuses any count other than 10 with the standard NotEnoughAccountKeys error',
  })
  await attack({
    ref: 'A11',
    title: 'extra account',
    doing: 'relay transfer with one account too many',
    build: () => [appendAccount(base, attackerWallet.address)],
    expect: { ok: false, program: 'runtime', code: -1, name: 'NotEnoughAccountKeys' },
    why: 'exact account count: 11 accounts are refused like 9 (the relay does not tolerate extra accounts)',
  })
  await attack({
    ref: 'C-sig',
    title: 'call the relay without signing as the agent',
    doing:
      "a stranger submits the agent's relay transfer with the signer flag removed, paying the fee itself",
    signers: [attackerWallet],
    who: `STRANGER ${short(attackerWallet.address)} (no agent key)`,
    actor: 'attacker',
    build: () => [unsign(base, 0)],
    expect: rel('relay', 107, 'AgentNotSigner'),
    why: 'the agent account must sign',
  })
  await attack({
    ref: 'A05',
    title: "a stranger's key in the agent slot",
    doing: "a stranger signs as 'agent' of the victim's mandate and policy",
    signers: [attackerWallet],
    who: `STRANGER ${short(attackerWallet.address)}`,
    actor: 'attacker',
    build: async () => [
      await relayTransferIx({
        agent: attackerWallet,
        policy,
        destination: A.recipientDusd,
        amount: units(1),
      }),
    ],
    expect: rel('relay', 117, 'InvalidMandate'),
    why: 'the signer is not the mandate agent',
  })

  // ---------------------------------------------------------------------------------------
  run.heading('Group 2: destination, swap pins, parameters (RELAY-SPEC 15.2)')
  await attack({
    ref: 'B01',
    title: "pay the attacker's token account",
    doing: 'relay transfer of 5 DUSD to MALLORY',
    build: async () => [
      await relayTransferIx({ agent, policy, destination: A.attackerDusd, amount: units(5) }),
    ],
    expect: rel('relay', 104, 'RecipientNotAllowed'),
    why: 'recipient allowlist of exact token accounts',
  })
  await attack({
    ref: 'E02',
    title: 'zero amount',
    doing: 'relay transfer with amount 0 (hand-built data)',
    build: () => [withData(base, new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]))],
    expect: rel('relay', 100, 'InvalidInstructionData'),
    why: 'amount must be positive',
  })
  await attack({
    ref: 'A11',
    title: 'truncated instruction data',
    doing: 'relay transfer with 4 data bytes',
    build: () => [withData(base, new Uint8Array([3, 1, 0, 0]))],
    expect: rel('relay', 100, 'InvalidInstructionData'),
    why: 'data must be exactly 9 bytes',
  })
  await attack({
    ref: 'B07',
    title: 'a relay tag that does not exist (Approve through the relay)',
    doing: 'relay instruction tag 5',
    build: () => [withData(base, new Uint8Array([5]))],
    expect: rel('relay', 100, 'InvalidInstructionData'),
    why: 'the relay has no authority-changing instruction',
  })
  await attack({
    ref: 'B03',
    title: 'swap output into the attacker account',
    doing: 'relay swap with out_account = MALLORY DOUT',
    build: async () => [await swap5({ outAccount: A.attackerDout })],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'out_account is pinned',
  })
  await attack({
    ref: 'B04',
    title: 'look-alike pool: another pool_state',
    doing: 'relay swap with an attacker-chosen pool_state account',
    build: async () => [await swap5({ poolState: A.attackerDout })],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'pool, vaults, config, observation and authority are all pinned',
  })
  await attack({
    ref: 'B04',
    title: 'look-alike AMM program',
    doing: 'relay swap with the Token program in the amm_program slot',
    build: async () => [await swap5({ ammProgram: TOKEN_PROGRAM_ID })],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'amm_program is pinned (and must also be in the relay compiled allowlist)',
  })
  await attack({
    ref: 'B05',
    title: 'wrong direction',
    doing: 'relay swap with the input and output mints swapped',
    build: async () => [await swap5({ inMint: doutMint, outMint: dusdMint })],
    expect: rel('relay', 102, 'AccountMismatch'),
    why: 'mints and vaults are pinned: one direction only',
  })
  await attack({
    ref: 'E02',
    title: 'swap deadline in the past',
    doing: 'relay swap with deadline_slot = current slot - 1',
    build: async () => {
      const slot = BigInt(await chain.rpc.getSlot({ commitment: 'confirmed' }).send())
      return [await swap5(undefined, slot - 1n)]
    },
    expect: rel('relay', 111, 'DeadlineExpired'),
    why: 'a stale signed swap cannot be executed later',
  })
  await attack({
    ref: 'E02',
    title: 'swap deadline far in the future',
    doing: 'relay swap with deadline_slot = current slot + 5000 (the policy allows 150)',
    build: async () => {
      const slot = BigInt(await chain.rpc.getSlot({ commitment: 'confirmed' }).send())
      return [await swap5(undefined, slot + 5000n)]
    },
    expect: rel('relay', 111, 'DeadlineExpired'),
    why: 'max_deadline_slots bounds how long a signed swap stays valid',
  })

  // ---------------------------------------------------------------------------------------
  run.heading("Group 3: the agent key against the owner's token account (RELAY-SPEC 15.2 B06/B07)")
  await attack({
    ref: 'B06',
    title: 'use the delegation directly with the agent key',
    doing:
      'raw TransferChecked of 40 DUSD from the victim account to MALLORY, authority = the agent key',
    build: () => [
      transferCheckedIx({
        source: victim.dusd,
        mint: dusdMint,
        destination: A.attackerDusd,
        authority: agent,
        amount: units(40),
        decimals: DECIMALS,
      }),
    ],
    expect: tok(4, 'OwnerMismatch'),
    why: 'raised by the TOKEN program: the delegate is a PDA only the relay can sign for, and the agent is not the owner',
  })
  await attack({
    ref: 'B07',
    title: 'Approve: make MALLORY a delegate',
    doing: 'raw Token.Approve(delegate = MALLORY, 1000 DUSD) on the victim account',
    build: async () => [
      await approveIx({
        source: victim.dusd,
        owner: agent,
        delegate: attackerWallet.address,
        amount: units(1000),
      }),
    ],
    expect: tok(4, 'OwnerMismatch'),
    why: 'Token validates Approve against the account owner',
  })
  await attack({
    ref: 'B07',
    title: 'SetAuthority: hand the account to MALLORY',
    doing: 'raw Token.SetAuthority(AccountOwner -> MALLORY)',
    build: () => [
      setAccountOwnerIx({
        account: victim.dusd,
        current: agent,
        newAuthority: attackerWallet.address,
      }),
    ],
    expect: tok(4, 'OwnerMismatch'),
    why: 'same check',
  })
  await attack({
    ref: 'B07',
    title: 'Revoke: strip the relay delegation',
    doing: 'raw Token.Revoke on the victim account signed by the agent',
    build: () => [revokeDelegateIx({ source: victim.dusd, owner: agent })],
    expect: tok(4, 'OwnerMismatch'),
    why: 'only the owner can revoke',
  })
  await attack({
    ref: 'B07',
    title: 'CloseAccount: close the empty DOUT account to the agent',
    doing: 'raw Token.CloseAccount(victim DOUT -> agent) signed by the agent',
    build: () => [
      closeAccountIx({ account: victim.dout, destination: agent.address, owner: agent }),
    ],
    expect: tok(4, 'OwnerMismatch'),
    why: 'only the owner (or close authority) can close',
  })

  // ---------------------------------------------------------------------------------------
  run.heading('Group 4: AgentAuth itself and owner-only instructions')
  await attack({
    ref: 'C-core',
    title: 'ask the mandate about an instruction it does not list',
    doing: 'AgentAuth.verify(Token, Approve discriminator, 0)',
    build: () => [
      verifyIx({
        mandate,
        owner: victim.owner.address,
        agent,
        targetProgram: TOKEN_PROGRAM_ID,
        discriminator: new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0]),
        amount: 0n,
      }),
    ],
    expect: core(7, 'DiscriminatorNotAllowed'),
    why: 'the mandate gates by (program, instruction); this is the standard other programs call, not what protects the Token program',
  })
  await attack({
    ref: 'C-core',
    title: 'ask the mandate about a program it does not list',
    doing: 'AgentAuth.verify(system-owned random program id, any discriminator, 0)',
    build: () => [
      verifyIx({
        mandate,
        owner: victim.owner.address,
        agent,
        targetProgram: attackerWallet.address,
        discriminator: new Uint8Array(8),
        amount: 0n,
      }),
    ],
    expect: core(6, 'ProgramNotAllowed'),
    why: 'no permission slot for that program',
  })
  await attack({
    ref: 'C-core',
    title: 'a stranger calls verify on the victim mandate',
    doing: 'AgentAuth.verify signed by a key that is not the mandate agent',
    signers: [attackerWallet],
    who: `STRANGER ${short(attackerWallet.address)}`,
    actor: 'attacker',
    build: () => [
      verifyIx({
        mandate,
        owner: victim.owner.address,
        agent: attackerWallet,
        targetProgram: TOKEN_PROGRAM_ID,
        discriminator: TRANSFER_CHECKED_DISC,
        amount: 1n,
      }),
    ],
    expect: core(17, 'UnknownAgent'),
    why: 'verify requires the mandate agent to sign',
  })
  await attack({
    ref: 'B07',
    title: 'the agent widens its own mandate',
    doing:
      'AgentAuth.add_permission(Token, unlimited, [Approve]) on the victim mandate, signed by the agent as if it were the owner',
    build: async () => [
      await addPermissionIx({
        owner: agent,
        mandate,
        agent: agent.address,
        program: env.programIds.gatedExample,
        spendLimit: 'unlimited',
        perTxLimit: 'unlimited',
        discriminators: [new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0])],
      }),
    ],
    expect: core(2, 'NotOwner'),
    why: 'only the mandate owner can change permissions',
  })
  await attack({
    ref: 'B07',
    title: 'the agent raises its own limits',
    doing: 'AgentAuth.update_permission(Token, lifetime 1000000 DUSD) signed by the agent',
    build: async () => [
      await updatePermissionIx({
        owner: agent,
        mandate,
        agent: agent.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: units(1_000_000),
        perTxLimit: units(1_000_000),
      }),
    ],
    expect: core(2, 'NotOwner'),
    why: 'owner-only',
  })
  await attack({
    ref: 'B07',
    title: 'the agent reactivates / pauses the mandate',
    doing: 'AgentAuth.set_active(true) signed by the agent',
    build: async () => [
      await setActiveIx({ owner: agent, mandate, agent: agent.address, active: true }),
    ],
    expect: core(2, 'NotOwner'),
    why: 'owner-only',
  })
  await attack({
    ref: 'B07',
    title: 'the agent revokes the mandate (denial of service on itself and the owner)',
    doing: 'AgentAuth.revoke_mandate signed by the agent',
    build: async () => [await revokeMandateIx({ owner: agent, mandate, agent: agent.address })],
    expect: core(2, 'NotOwner'),
    why: 'owner-only',
  })
  await attack({
    ref: 'B07',
    title: 'the agent un-pauses the relay',
    doing: 'relay set_paused(0) signed by the agent',
    build: async () => [
      await setPausedIx({ owner: agent, mandate, agent: agent.address, paused: false }),
    ],
    expect: rel('relay', 109, 'NotPolicyOwner'),
    why: 'only the policy owner can pause or resume',
  })
  await attack({
    ref: 'B07',
    title: 'the agent closes the policy',
    doing: 'relay close_policy signed by the agent',
    build: async () => [await closePolicyIx({ owner: agent, mandate, agent: agent.address })],
    expect: rel('relay', 109, 'NotPolicyOwner'),
    why: 'only the policy owner can close it',
  })
  await attack({
    ref: 'E11',
    title: 'the agent re-initialises the policy with its own recipients',
    doing: 'relay init_policy (recipients = [MALLORY]) signed by the agent for the victim mandate',
    build: async () => [
      await initPolicyIx({
        owner: agent,
        mandate,
        config: {
          tokenProgram: TOKEN_PROGRAM_ID,
          budgetMint: dusdMint,
          sourceAccount: victim.dusd,
          recipients: [A.attackerDusd],
          swap: null,
        },
      }),
    ],
    expect: rel('relay', 109, 'NotPolicyOwner'),
    why: 'the signer is not the mandate owner (and the policy already exists: config is immutable)',
  })

  // ---------------------------------------------------------------------------------------
  run.heading('Group 5: CPI depth, accounting, replay (RELAY-SPEC 15.3 / 15.5)')
  await attack({
    ref: 'C04',
    title: 'wrap the relay transfer in a CPI (call depth)',
    doing: 'mock AMM proxy instruction forwarding a relay transfer: the relay runs one level deep',
    build: () => [proxyIx(env.programIds.mockAmm, base)],
    expect: rel('relay', 115, 'NotTopLevel'),
    why: 'the policy sets STRICT_TOP_LEVEL, so the relay refuses to run inside another program',
  })
  await attack({
    ref: 'E08',
    title: 'over-budget split in ONE transaction',
    doing:
      'five relay transfers of 5 DUSD to ACME in one transaction (25 > the 20 DUSD lifetime limit)',
    build: async () => {
      const ixs: Instruction[] = []
      for (let i = 0; i < 5; i++)
        ixs.push(
          await relayTransferIx({ agent, policy, destination: A.recipientDusd, amount: units(5) }),
        )
      return ixs
    },
    expect: core(9, 'SpendLimitExceeded'),
    why: 'lifetime cap bites at the fifth instruction (index 4) and the whole transaction reverts: nothing lands',
  })

  // Replay: a legitimate payment, then the very same signed transaction again.
  run.heading('Replay of a captured transaction (E05)')
  const payIx = await pay1()
  const { value: blockhash } = await chain.rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send()
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayerSigner(agent, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([payIx], m),
    ),
  )
  const wire = getBase64EncodedWireTransaction(signed)
  const sig = getSignatureFromTransaction(signed)
  const replaySteps = {
    async first(): Promise<SendOutcome> {
      await chain.rpc
        .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send()
      for (let i = 0; i < 60; i++) {
        const st = (await chain.rpc.getSignatureStatuses([sig]).send()).value[0]
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
          return { signature: sig, ok: st.err === null, error: null, message: null, err: st.err }
        }
        await sleep(250)
      }
      throw new Error('the first payment did not confirm')
    },
    async replay(): Promise<SendOutcome> {
      try {
        await chain.rpc
          .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
          .send()
      } catch (error) {
        const message = describeError(error)
        return { signature: sig, ok: false, error: parseProgramError(error), message, err: null }
      }
      return { signature: sig, ok: true, error: null, message: null, err: null }
    },
  }
  const victimBefore = await tokenBalance(chain, victim.dusd)
  await run.attempt({
    id: 'AT-replay-1',
    title: 'E05  The legitimate payment (the transaction an attacker will capture)',
    doing: 'relay transfer of 1 DUSD to ACME, signed once',
    who: agentWho,
    actor: 'agent',
    signers: [agent],
    execute: () => replaySteps.first(),
    expect: { ok: true },
    board,
  })
  const afterFirst = await stateOf(victim, mandate)
  n++
  const replayRec = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'E05  Replay the identical signed transaction',
    doing: 'the same wire bytes submitted again',
    who: 'ANYONE who captured the transaction (no key needed)',
    actor: 'attacker',
    scripted: true,
    signers: [agent],
    execute: () => replaySteps.replay(),
    expect: { ok: false, message: 'already been processed' },
    why: 'the cluster rejects a duplicate signature; swaps additionally carry a deadline',
    board,
  })
  const afterReplay = await stateOf(victim, mandate)
  if (afterReplay !== afterFirst) throw new Error('the replay changed state')
  if ((await tokenBalance(chain, victim.dusd)) !== victimBefore - units(1))
    throw new Error('exactly one payment should have landed')
  run.out(
    `  state     exactly one 1 DUSD payment landed; the replay changed nothing ${c.green('(verified)')}`,
  )
  rows.push({
    id: replayRec.id,
    ref: 'E05',
    title: 'replay of a captured transaction',
    klass: 'BLOCKED',
    outcome: 'runtime: already processed',
    unchanged: true,
  })
  await rebase()

  // ---------------------------------------------------------------------------------------
  run.heading(
    'Group 6: owner controls the attacks must respect (state changes by the OWNER, then the agent tries)',
  )
  const ownerAdmin = async (
    id: string,
    title: string,
    doing: string,
    ixs: () => Promise<readonly Instruction[]> | readonly Instruction[],
  ) =>
    run.attempt({
      id,
      title,
      doing,
      who: `OWNER ${short(victim.owner.address)}`,
      actor: 'owner',
      signers: [victim.owner],
      build: ixs,
      expect: { ok: true },
    })

  await ownerAdmin('AT-own-1', 'Owner pauses the relay policy', 'relay set_paused(1)', async () => [
    await setPausedIx({ owner: victim.owner, agent: agent.address, paused: true }),
  ])
  await attack({
    ref: 'D-ctl',
    title: 'pay while the relay policy is paused',
    doing: 'relay transfer of 1 DUSD to ACME',
    build: async () => [await pay1()],
    expect: rel('relay', 116, 'Paused'),
    why: 'reversible kill switch',
  })
  await ownerAdmin(
    'AT-own-2',
    'Owner resumes the relay policy',
    'relay set_paused(0)',
    async () => [await setPausedIx({ owner: victim.owner, agent: agent.address, paused: false })],
  )
  await ownerAdmin(
    'AT-own-3',
    'Owner deactivates the mandate (core kill switch)',
    'AgentAuth set_active(false)',
    async () => [await setActiveIx({ owner: victim.owner, agent: agent.address, active: false })],
  )
  await attack({
    ref: 'D-ctl',
    title: 'pay while the mandate is inactive',
    doing: 'relay transfer of 1 DUSD to ACME',
    build: async () => [await pay1()],
    expect: core(4, 'NotActive'),
    why: 'the core mandate is paused',
  })
  await ownerAdmin(
    'AT-own-4',
    'Owner reactivates the mandate',
    'AgentAuth set_active(true)',
    async () => [await setActiveIx({ owner: victim.owner, agent: agent.address, active: true })],
  )
  await ownerAdmin(
    'AT-own-5',
    'Owner revokes ONLY the SPL delegation',
    'Token.Revoke on the source account (mandate and policy untouched)',
    () => [revokeDelegateIx({ source: victim.dusd, owner: victim.owner })],
  )
  await rebase()
  await attack({
    ref: 'B10',
    title: 'pay after only the delegation was revoked',
    doing: 'relay transfer of 1 DUSD to ACME',
    build: async () => [await pay1()],
    expect: rel('relay', 105, 'TokenAccountState'),
    why: 'either half alone (mandate or delegation) kills the agent',
  })
  await ownerAdmin(
    'AT-own-6',
    'Owner re-approves the 50 DUSD delegation',
    'Token.Approve(relay authority, 50 DUSD)',
    async () => [
      await approveIx({ source: victim.dusd, owner: victim.owner, mandate, amount: units(50) }),
    ],
  )
  await rebase()

  // ---------------------------------------------------------------------------------------
  run.heading('Group 7: stale policy after a re-created mandate (A12)')
  const v2 = await makeVictim(ctx, units(50))
  const agent3 = await generateKeyPairSigner()
  const o2 = await onboardQuiet(ctx, {
    owner: v2.owner,
    agent: agent3.address,
    source: v2.dusd,
    out: v2.dout,
    recipients: [A.recipientDusd],
    swap: false,
    delegateCap: units(20),
  })
  const v2Before = await tokenBalance(chain, v2.dusd)
  await run.attempt({
    id: 'AT-stale-1',
    title:
      'Owner revokes the mandate but leaves the policy and delegation in place, then creates a new mandate with a different expiry',
    doing: 'revoke_mandate; create_mandate(expiry + 1h); add_permission(Token) in one transaction',
    who: `OWNER ${short(v2.owner.address)}`,
    actor: 'owner',
    signers: [v2.owner],
    build: async () => [
      await revokeMandateIx({ owner: v2.owner, agent: agent3.address }),
      await createMandateIx({
        owner: v2.owner,
        agent: agent3.address,
        expiry: o2.mandateAccount.expiry + 3600n,
      }),
      await addPermissionIx({
        owner: v2.owner,
        agent: agent3.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: units(20),
        perTxLimit: units(5),
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ],
    expect: { ok: true },
  })
  n++
  const staleRec = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'A12  Use the old policy with the re-created mandate',
    doing:
      'relay transfer of 1 DUSD to ACME with the OLD policy (its recorded mandate expiry differs from the live mandate)',
    who: `AGENT ${short(agent3.address)} (compromised key of the second victim)`,
    actor: 'agent',
    scripted: true,
    signers: [agent3],
    build: async () => [
      await relayTransferIx({
        agent: agent3,
        policy: o2.policy,
        destination: A.recipientDusd,
        amount: units(1),
      }),
    ],
    expect: rel('relay', 118, 'StalePolicy'),
    why: 'the policy remembers the mandate expiry it was created for; a re-created mandate does not silently re-bind it',
    board,
  })
  if ((await tokenBalance(chain, v2.dusd)) !== v2Before)
    throw new Error('second victim balance changed')
  rows.push({
    id: staleRec.id,
    ref: 'A12',
    title: 'old policy re-activates after revoke + re-create',
    klass: 'BLOCKED',
    outcome: 'relay 118 StalePolicy',
    unchanged: true,
  })
  await unwindBeat(ctx, v2.owner, agent3.address, 'AT-stale-2')

  // ---------------------------------------------------------------------------------------
  run.heading('Group 8: an accepted, documented limitation (L4) and pre-funded PDA griefing (E06)')
  const v3 = await makeVictim(ctx, units(50))
  const agent4 = await generateKeyPairSigner()
  const o3 = await onboardQuiet(ctx, {
    owner: v3.owner,
    agent: agent4.address,
    source: v3.dusd,
    out: v3.dout,
    recipients: [A.recipientDusd],
    swap: false,
    tokenSpend: units(10),
    tokenPerTx: units(5),
    delegateCap: units(20),
  })
  const acmeBefore = await tokenBalance(chain, A.recipientDusd)
  n++
  const l4 = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'L4  Two payments of 5 DUSD in ONE transaction (per_tx_limit is 5)',
    doing: 'two relay transfers of 5 DUSD in a single transaction, lifetime limit 10',
    who: `AGENT ${short(agent4.address)} (third mandate)`,
    actor: 'agent',
    scripted: true,
    signers: [agent4],
    build: async () => [
      await relayTransferIx({
        agent: agent4,
        policy: o3.policy,
        destination: A.recipientDusd,
        amount: units(5),
      }),
      await relayTransferIx({
        agent: agent4,
        policy: o3.policy,
        destination: A.recipientDusd,
        amount: units(5),
      }),
    ],
    expect: { ok: true },
    why: 'ACCEPTED, DISCLOSED LIMIT L4: per_tx_limit is per verify call, not per Solana transaction. The loss stays bounded by the lifetime limit (10) and goes only to the allowlisted payee.',
    board,
  })
  rows.push({
    id: l4.id,
    ref: 'E08/L4',
    title: 'split a spend inside one transaction (within the lifetime limit)',
    klass: 'ACCEPTED LIMIT',
    outcome: 'succeeded: 10 DUSD to ACME, the lifetime limit',
    unchanged: false,
  })
  if ((await tokenBalance(chain, A.recipientDusd)) !== acmeBefore + units(10))
    throw new Error('ACME should have received exactly 10 DUSD')
  n++
  const l4b = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'E08  One more DUSD after the lifetime limit is spent',
    doing: 'relay transfer of 1 DUSD to ACME',
    who: `AGENT ${short(agent4.address)}`,
    actor: 'agent',
    scripted: true,
    signers: [agent4],
    build: async () => [
      await relayTransferIx({
        agent: agent4,
        policy: o3.policy,
        destination: A.recipientDusd,
        amount: units(1),
      }),
    ],
    expect: core(9, 'SpendLimitExceeded'),
    why: 'the lifetime counter is the real bound',
    board,
  })
  rows.push({
    id: l4b.id,
    ref: 'E08',
    title: 'spend after the lifetime limit',
    klass: 'BLOCKED',
    outcome: 'agent_auth 9 SpendLimitExceeded',
    unchanged: true,
  })
  await unwindBeat(ctx, v3.owner, agent4.address, 'AT-l4-unwind')

  // Pre-funded PDA griefing: an attacker sends lamports to the addresses the owner is about to create.
  const agent5 = await generateKeyPairSigner()
  const mandate5 = (
    await mandatePda(victim.owner.address, agent5.address, env.programIds.agentAuth)
  ).address
  const policy5 = (await relayPolicyPda(mandate5, env.programIds.relay)).address
  await run.attempt({
    id: 'AT-grief-1',
    title: 'E06  MALLORY pre-funds the mandate PDA the owner is about to create',
    doing: `System transfer of 0.001 SOL to the not-yet-created mandate address ${short(mandate5)}`,
    who: `MALLORY ${short(attackerWallet.address)}`,
    actor: 'harness',
    scripted: true,
    signers: [attackerWallet],
    build: () => [systemTransferIx({ from: attackerWallet, to: mandate5, lamports: 1_000_000n })],
    expect: { ok: true },
    why: 'a classic griefing move: System CreateAccount would fail on a funded address',
  })
  n++
  const g1 = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'E06  create_mandate on the pre-funded PDA',
    doing: 'AgentAuth create_mandate for a fresh agent whose mandate address was pre-funded',
    who: `OWNER ${short(victim.owner.address)}`,
    actor: 'owner',
    signers: [victim.owner],
    build: async () => [
      await createMandateIx({
        owner: victim.owner,
        agent: agent5.address,
        expiry: (await client.getClusterTime()) + 3600n,
      }),
      await addPermissionIx({
        owner: victim.owner,
        agent: agent5.address,
        program: TOKEN_PROGRAM_ID,
        spendLimit: units(5),
        perTxLimit: units(1),
        discriminators: [TRANSFER_CHECKED_DISC],
      }),
    ],
    expect: { ok: true },
    why: 'NEUTRALISED: the hardened core tops up, allocates and assigns the pre-funded address instead of failing',
  })
  rows.push({
    id: g1.id,
    ref: 'E06',
    title: 'pre-funded mandate PDA (griefing create_mandate)',
    klass: 'NEUTRALISED',
    outcome: 'create_mandate still succeeds',
    unchanged: true,
  })
  await run.attempt({
    id: 'AT-grief-2',
    title: 'E06  MALLORY pre-funds the policy PDA',
    doing: `System transfer of 0.001 SOL to the not-yet-created policy address ${short(policy5)}`,
    who: `MALLORY ${short(attackerWallet.address)}`,
    actor: 'harness',
    scripted: true,
    signers: [attackerWallet],
    build: () => [systemTransferIx({ from: attackerWallet, to: policy5, lamports: 1_000_000n })],
    expect: { ok: true },
  })
  n++
  const g2 = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'E06  init_policy on the pre-funded PDA',
    doing: 'relay init_policy for that mandate',
    who: `OWNER ${short(victim.owner.address)}`,
    actor: 'owner',
    signers: [victim.owner],
    build: async () => [
      await initPolicyIx({
        owner: victim.owner,
        agent: agent5.address,
        config: {
          tokenProgram: TOKEN_PROGRAM_ID,
          budgetMint: dusdMint,
          sourceAccount: victim.dusd,
          recipients: [A.recipientDusd],
          swap: null,
        },
      }),
    ],
    expect: { ok: true },
    why: 'NEUTRALISED: the relay creates the policy on a funded address too',
  })
  rows.push({
    id: g2.id,
    ref: 'E06',
    title: 'pre-funded policy PDA (griefing init_policy)',
    klass: 'NEUTRALISED',
    outcome: 'init_policy still succeeds',
    unchanged: true,
  })
  await run.attempt({
    id: 'AT-grief-3',
    title: 'Cleanup: close the griefing fixtures',
    doing: 'revoke_mandate and close_policy for the extra agent (no delegation was created for it)',
    who: `OWNER ${short(victim.owner.address)}`,
    actor: 'owner',
    signers: [victim.owner],
    build: async () => [
      await closePolicyIx({ owner: victim.owner, agent: agent5.address }),
      await revokeMandateIx({ owner: victim.owner, agent: agent5.address }),
    ],
    expect: { ok: true },
  })

  // ---------------------------------------------------------------------------------------
  run.heading('Finish: the owner unwinds, the agent is locked out')
  await rebase()
  await unwindBeat(ctx, victim.owner, agent.address, 'AT-unwind')
  n++
  const last = await run.attempt({
    id: `AT-${String(n).padStart(2, '0')}`,
    title: 'D-ctl  The compromised agent retries after the unwind',
    doing: 'relay transfer of 1 DUSD to ACME',
    who: agentWho,
    actor: 'agent',
    scripted: true,
    signers: [agent],
    build: async () => [await pay1()],
    expect: rel('relay', 101, 'InvalidPolicy'),
    why: 'the policy is closed',
    board,
  })
  rows.push({
    id: last.id,
    ref: 'D-ctl',
    title: 'agent after the one-transaction unwind',
    klass: 'BLOCKED',
    outcome: 'relay 101 InvalidPolicy',
    unchanged: true,
  })

  // ---------------------------------------------------------------------------------------
  run.heading('Result table (SCRIPTED attacks)')
  for (const l of table(
    ['id', 'ref', 'attack', 'class', 'outcome', 'protected state unchanged'],
    rows.map((r) => [r.id, r.ref, r.title, r.klass, r.outcome, r.unchanged ? 'yes' : 'see note']),
  ))
    run.out(`  ${l}`)
  const blocked = rows.filter((r) => r.klass === 'BLOCKED').length
  const neutral = rows.filter((r) => r.klass === 'NEUTRALISED').length
  const accepted = rows.filter((r) => r.klass === 'ACCEPTED LIMIT').length
  run.out()
  run.say(
    `${rows.length} attacks: ${blocked} blocked with the documented error, ${neutral} neutralised (the owner's creation still succeeded), ${accepted} accepted and disclosed limitation (L4).`,
  )
  const distinctBlocked = new Set(rows.filter((r) => r.klass === 'BLOCKED').map((r) => r.outcome))
  run.say(
    `${distinctBlocked.size} distinct rejection outcomes across AgentAuth, the relay, the Token program, the mock AMM and the runtime.`,
  )
  const sb = await board.snapshot()
  run.out(
    `  scoreboard  attempted ${sb.attempted} | blocked ${sb.blocked} | allowed ${sb.allowed} | funds lost ${sb.fundsLost}`,
  )
  if (!sb.fundsLost.startsWith('0 ')) throw new Error(`MALLORY holds funds: ${sb.fundsLost}`)
  if (rows.length < 15) throw new Error('fewer than 15 attacks ran')
  run.say(
    'Honest limits: this suite shows what an agent key (or a stranger) can and cannot do through the real instructions on a local validator. It does not prove absence of bugs; the programs are unaudited. The L4 row is real: a mandate does not stop an agent from spending its budget quickly on its allowlisted payee.',
  )
})

function describeError(error: unknown): string {
  const parts: string[] = []
  let cur: unknown = error
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    parts.push(cur.message)
    cur = cur.cause
  }
  return parts.join(' | ')
}
