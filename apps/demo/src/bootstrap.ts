/**
 * Idempotent setup of the LOCAL demo environment. Run it against the validator from
 * `scripts/localnet.sh start`:
 *
 *   pnpm --filter @agentauth-sol/demo bootstrap            create whatever is missing
 *   pnpm --filter @agentauth-sol/demo bootstrap --refill   also restock balances and the pool to the initial amounts
 *
 * It creates keypairs under .demo/keys (mode 600, never printed), airdrops SOL, creates two classic
 * SPL mints (DUSD "Demo Dollar" and DOUT "Demo Out", 6 decimals), the token accounts of the cast, a
 * mock-AMM pool (test/demo only) and initialises gated-example, then writes the public addresses to
 * .demo/state.json. Every address is derived from the persisted keypairs, so a new ledger gets the
 * same addresses back.
 */
import {
  associatedTokenAddress,
  createAtaIdempotentIx,
  decodeMint,
  decodeTokenAccount,
  fetchRawAccount,
  parseUnits,
  programIds as sdkProgramIds,
  TOKEN_PROGRAM_ID,
  type RawAccount,
} from '@agentauth-sol/sdk'
import { getAddressEncoder, type Address, type Instruction, type KeyPairSigner } from '@solana/kit'
import { connect, waitForHealth, type DemoChain } from './lib/chain'
import { endpointsFromEnv } from './lib/config'
import {
  createAccountIx,
  gatedConfigPda,
  gatedInitIx,
  initializeAccount3Ix,
  initializeMint2Ix,
  MINT_SIZE,
  mintToCheckedIx,
  mockAmmAuthority,
  mockAmmInitPoolIx,
  MOCK_AMM_MODE_NORMAL,
  MOCK_POOL_STATE_SIZE,
  TOKEN_ACCOUNT_SIZE,
} from './lib/instructions'
import {
  ensureKeypair,
  loadSigner,
  OBJECT_KEYS,
  WALLET_ROLES,
  type DemoSigners,
  type WalletRole,
} from './lib/keys'
import { demoDir, stateFile } from './lib/paths'
import { writeState, type DemoState } from './lib/state'

const DECIMALS = 6
const SOL = 1_000_000_000n

/** SOL each wallet is topped up to (the agent keeps fee money only: 0.05 SOL as in DEMO-SCRIPT). */
const SOL_TARGETS: Readonly<Record<WalletRole, bigint>> = {
  owner: 100n * SOL,
  agent: SOL / 20n,
  attacker: 5n * SOL,
  recipient: SOL,
  harness: 100n * SOL,
  hot: 5n * SOL,
}

const AMOUNTS = {
  ownerDusd: parseUnits('1000', DECIMALS),
  simulatorDusd: parseUnits('1000', DECIMALS),
  hotDusd: parseUnits('50', DECIMALS),
  harnessDusd: parseUnits('1000', DECIMALS),
  poolDusd: parseUnits('10000', DECIMALS),
  poolDout: parseUnits('10000', DECIMALS),
} as const

const refill = process.argv.includes('--refill')
const log = (line: string): void => console.log(line)

async function accountsExist(chain: DemoChain, addresses: readonly Address[]): Promise<boolean[]> {
  const { value } = await chain.rpc
    .getMultipleAccounts([...addresses], {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed',
    })
    .send()
  return value.map((a) => a !== null)
}

async function ensureProgramsLoaded(chain: DemoChain): Promise<void> {
  const ids = sdkProgramIds('localnet')
  const programs: Array<[string, Address]> = [
    ['agent_auth', ids.agentAuth],
    ['relay', ids.relay],
    ['mock_amm', ids.mockAmm],
    ['gated_example', ids.gatedExample],
  ]
  const { value } = await chain.rpc
    .getMultipleAccounts(
      programs.map(([, a]) => a),
      { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
    )
    .send()
  const bad = programs.filter((_, i) => !value[i]?.executable).map(([n]) => n)
  if (bad.length > 0) {
    throw new Error(
      `program(s) not deployed on ${chain.endpoints.rpcUrl}: ${bad.join(', ')}. ` +
        'Run scripts/build-all.sh and scripts/localnet.sh start (the localnet script preloads all four).',
    )
  }
}

async function topUpSol(chain: DemoChain, signers: DemoSigners): Promise<void> {
  for (const role of WALLET_ROLES) {
    const address = signers[role].address
    const have = await chain.balance(address)
    const want = SOL_TARGETS[role]
    // Top up only when below half the target, so a repeat run is quiet (fees alone never trigger it).
    if (have < want / 2n) {
      await chain.airdrop(address, want - have)
      log(`  airdrop  ${role.padEnd(9)} +${formatSol(want - have)} SOL`)
    }
  }
}

function formatSol(lamports: bigint): string {
  const whole = lamports / SOL
  const frac = (lamports % SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

async function ensureMint(
  chain: DemoChain,
  harness: KeyPairSigner,
  mint: KeyPairSigner,
  label: string,
): Promise<void> {
  const existing = await fetchRawAccount(chain.rpc, mint.address, { commitment: 'confirmed' })
  if (existing) {
    const view = decodeMint(existing.data)
    if (
      existing.ownerProgram !== TOKEN_PROGRAM_ID ||
      !view.isInitialized ||
      view.decimals !== DECIMALS ||
      view.mintAuthority !== harness.address
    ) {
      throw new Error(
        `${label} mint ${mint.address} exists but is not the demo mint (decimals ${DECIMALS}, authority harness); ` +
          `delete ${demoDir()} and reset the validator to start clean`,
      )
    }
    return
  }
  const rent = await chain.rpc.getMinimumBalanceForRentExemption(MINT_SIZE).send()
  await chain.send(
    [
      createAccountIx({
        payer: harness,
        newAccount: mint,
        lamports: BigInt(rent),
        space: MINT_SIZE,
        owner: TOKEN_PROGRAM_ID,
      }),
      initializeMint2Ix({ mint: mint.address, decimals: DECIMALS, mintAuthority: harness.address }),
    ],
    harness,
  )
  log(`  mint     ${label.padEnd(9)} ${mint.address}`)
}

interface AtaSpec {
  readonly owner: Address
  readonly mint: Address
  readonly ata: Address
}

async function ata(owner: Address, mint: Address): Promise<AtaSpec> {
  return { owner, mint, ata: (await associatedTokenAddress(owner, mint)).address }
}

/** Create the missing ATAs (batches of 4 keep every transaction well under 1232 bytes). Returns the set that was missing before. */
async function ensureAtas(
  chain: DemoChain,
  payer: KeyPairSigner,
  specs: readonly AtaSpec[],
): Promise<Set<Address>> {
  const exists = await accountsExist(
    chain,
    specs.map((s) => s.ata),
  )
  const missing = specs.filter((_, i) => !exists[i])
  for (let i = 0; i < missing.length; i += 4) {
    const batch = missing.slice(i, i + 4)
    const ixs = await Promise.all(
      batch.map((s) => createAtaIdempotentIx({ payer, owner: s.owner, mint: s.mint, ata: s.ata })),
    )
    await chain.send(ixs, payer)
  }
  if (missing.length > 0) log(`  accounts ${missing.length} token account(s) created`)
  return new Set(missing.map((s) => s.ata))
}

async function ensureAttackerAccountB(
  chain: DemoChain,
  harness: KeyPairSigner,
  account: KeyPairSigner,
  mint: Address,
  tokenOwner: Address,
  label = 'attacker control account',
): Promise<boolean> {
  const [exists] = await accountsExist(chain, [account.address])
  if (exists) return false
  const rent = await chain.rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE).send()
  await chain.send(
    [
      createAccountIx({
        payer: harness,
        newAccount: account,
        lamports: BigInt(rent),
        space: TOKEN_ACCOUNT_SIZE,
        owner: TOKEN_PROGRAM_ID,
      }),
      initializeAccount3Ix({ account: account.address, mint, owner: tokenOwner }),
    ],
    harness,
  )
  log(`  accounts ${label} ${account.address}`)
  return true
}

async function balanceOf(chain: DemoChain, account: Address): Promise<bigint> {
  const raw: RawAccount | null = await fetchRawAccount(chain.rpc, account, {
    commitment: 'confirmed',
  })
  return raw ? decodeTokenAccount(raw.data).amount : 0n
}

/** Mint `target - balance` when the account is new or `--refill` is set. */
async function stock(
  chain: DemoChain,
  harness: KeyPairSigner,
  p: { name: string; mint: Address; account: Address; target: bigint; fresh: boolean },
): Promise<void> {
  if (!p.fresh && !refill) return
  const have = await balanceOf(chain, p.account)
  if (have >= p.target) return
  await chain.send(
    [
      mintToCheckedIx({
        mint: p.mint,
        destination: p.account,
        authority: harness,
        amount: p.target - have,
        decimals: DECIMALS,
      }),
    ],
    harness,
  )
  log(`  stock    ${p.name.padEnd(14)} ${formatUnits6(p.target)}`)
}

function formatUnits6(raw: bigint): string {
  const whole = raw / 10n ** BigInt(DECIMALS)
  const frac = (raw % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

async function ensurePool(
  chain: DemoChain,
  harness: KeyPairSigner,
  p: {
    pool: KeyPairSigner
    config: KeyPairSigner
    observation: KeyPairSigner
    vault0: Address
    vault1: Address
    mockAmm: Address
  },
): Promise<void> {
  const existing = await fetchRawAccount(chain.rpc, p.pool.address, { commitment: 'confirmed' })
  if (existing) {
    const enc = getAddressEncoder()
    const v0 = enc.encode(p.vault0)
    const v1 = enc.encode(p.vault1)
    const same =
      existing.ownerProgram === p.mockAmm &&
      existing.data.length === Number(MOCK_POOL_STATE_SIZE) &&
      existing.data[0] === MOCK_AMM_MODE_NORMAL &&
      v0.every((b, i) => existing.data[8 + i] === b) &&
      v1.every((b, i) => existing.data[40 + i] === b)
    if (!same) {
      throw new Error(
        `pool account ${p.pool.address} exists but is not the demo pool; delete ${demoDir()} and reset the validator`,
      )
    }
    return
  }
  const [poolRent, emptyRent] = await Promise.all([
    chain.rpc.getMinimumBalanceForRentExemption(MOCK_POOL_STATE_SIZE).send(),
    chain.rpc.getMinimumBalanceForRentExemption(0n).send(),
  ])
  const owned = (newAccount: KeyPairSigner, lamports: bigint, space: bigint): Instruction =>
    createAccountIx({ payer: harness, newAccount, lamports, space, owner: p.mockAmm })
  await chain.send(
    [
      owned(p.pool, BigInt(poolRent), MOCK_POOL_STATE_SIZE),
      // amm_config and observation_state are "accepted, unused" by the mock; real Raydium owns them too.
      owned(p.config, BigInt(emptyRent), 0n),
      owned(p.observation, BigInt(emptyRent), 0n),
      mockAmmInitPoolIx({
        pool: p.pool.address,
        vault0: p.vault0,
        vault1: p.vault1,
        programId: p.mockAmm,
      }),
    ],
    harness,
  )
  log(`  pool     mock AMM ${p.pool.address}`)
}

async function ensureGatedInit(chain: DemoChain, owner: KeyPairSigner): Promise<Address> {
  const { address: config } = await gatedConfigPda()
  const existing = await fetchRawAccount(chain.rpc, config, { commitment: 'confirmed' })
  if (existing && existing.data.length >= 32) {
    const honoured = new Uint8Array(getAddressEncoder().encode(owner.address))
    if (!honoured.every((b, i) => existing.data[i] === b)) {
      throw new Error(
        `gated-example is already initialised for a different owner (config ${config}); reset the validator`,
      )
    }
    return config
  }
  try {
    await chain.send([await gatedInitIx({ authority: owner })], owner)
  } catch (error) {
    throw new Error(
      `gated-example init failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'If gated_example.so predates the `init` instruction, rebuild with scripts/build-all.sh and restart the validator.',
    )
  }
  log(`  gated    config ${config} (honours the owner wallet only)`)
  return config
}

async function main(): Promise<void> {
  const endpoints = endpointsFromEnv()
  const chain = connect(endpoints)
  log(`bootstrap against ${endpoints.rpcUrl}${refill ? ' (--refill)' : ''}`)
  await waitForHealth(chain)
  await ensureProgramsLoaded(chain)
  const genesisHash = await chain.rpc.getGenesisHash().send()

  // 1. keys (never printed)
  let generated = 0
  for (const name of [...WALLET_ROLES, ...OBJECT_KEYS]) if (await ensureKeypair(name)) generated++
  log(
    `  keys     ${generated} generated, ${WALLET_ROLES.length + OBJECT_KEYS.length - generated} reused (${demoDir()}/keys, mode 600)`,
  )
  const wallets = Object.fromEntries(
    await Promise.all(WALLET_ROLES.map(async (r) => [r, await loadSigner(r)] as const)),
  ) as DemoSigners
  const [dusdMint, doutMint, pool, ammConfig, observation, attackerB, simulatorAcct] =
    (await Promise.all(OBJECT_KEYS.map((k) => loadSigner(k)))) as [
      KeyPairSigner,
      KeyPairSigner,
      KeyPairSigner,
      KeyPairSigner,
      KeyPairSigner,
      KeyPairSigner,
      KeyPairSigner,
    ]

  // 2. SOL
  await topUpSol(chain, wallets)

  // 3. mints (harness = mint authority)
  await ensureMint(chain, wallets.harness, dusdMint, 'DUSD')
  await ensureMint(chain, wallets.harness, doutMint, 'DOUT')

  // 4. token accounts
  const ids = sdkProgramIds('localnet')
  const poolAuthority = (await mockAmmAuthority(ids.mockAmm)).address
  const specs = {
    ownerDusd: await ata(wallets.owner.address, dusdMint.address),
    ownerDout: await ata(wallets.owner.address, doutMint.address),
    recipientDusd: await ata(wallets.recipient.address, dusdMint.address),
    attackerDusd: await ata(wallets.attacker.address, dusdMint.address),
    attackerDout: await ata(wallets.attacker.address, doutMint.address),
    hotDusd: await ata(wallets.hot.address, dusdMint.address),
    harnessDusd: await ata(wallets.harness.address, dusdMint.address),
    harnessDout: await ata(wallets.harness.address, doutMint.address),
    vaultDusd: await ata(poolAuthority, dusdMint.address),
    vaultDout: await ata(poolAuthority, doutMint.address),
  }
  const fresh = await ensureAtas(chain, wallets.harness, Object.values(specs))
  await ensureAttackerAccountB(
    chain,
    wallets.harness,
    attackerB,
    dusdMint.address,
    wallets.attacker.address,
  )
  const simulatorFresh = await ensureAttackerAccountB(
    chain,
    wallets.harness,
    simulatorAcct,
    dusdMint.address,
    wallets.owner.address,
    'dashboard simulator account (owner DUSD #2)',
  )

  // 5. balances (only for accounts created now, or everything with --refill)
  const dusd = dusdMint.address
  const dout = doutMint.address
  await stock(chain, wallets.harness, {
    name: 'owner DUSD',
    mint: dusd,
    account: specs.ownerDusd.ata,
    target: AMOUNTS.ownerDusd,
    fresh: fresh.has(specs.ownerDusd.ata),
  })
  await stock(chain, wallets.harness, {
    name: 'simulator DUSD',
    mint: dusd,
    account: simulatorAcct.address,
    target: AMOUNTS.simulatorDusd,
    fresh: simulatorFresh,
  })
  await stock(chain, wallets.harness, {
    name: 'hot DUSD',
    mint: dusd,
    account: specs.hotDusd.ata,
    target: AMOUNTS.hotDusd,
    fresh: fresh.has(specs.hotDusd.ata),
  })
  await stock(chain, wallets.harness, {
    name: 'harness DUSD',
    mint: dusd,
    account: specs.harnessDusd.ata,
    target: AMOUNTS.harnessDusd,
    fresh: fresh.has(specs.harnessDusd.ata),
  })
  await stock(chain, wallets.harness, {
    name: 'pool DUSD',
    mint: dusd,
    account: specs.vaultDusd.ata,
    target: AMOUNTS.poolDusd,
    fresh: fresh.has(specs.vaultDusd.ata),
  })
  await stock(chain, wallets.harness, {
    name: 'pool DOUT',
    mint: dout,
    account: specs.vaultDout.ata,
    target: AMOUNTS.poolDout,
    fresh: fresh.has(specs.vaultDout.ata),
  })

  // 6. pool (mode NORMAL)
  await ensurePool(chain, wallets.harness, {
    pool,
    config: ammConfig,
    observation,
    vault0: specs.vaultDusd.ata,
    vault1: specs.vaultDout.ata,
    mockAmm: ids.mockAmm,
  })

  // 7. gated-example config
  const gatedConfig = await ensureGatedInit(chain, wallets.owner)

  // 8. public state
  const mintInfo = (address: Address, symbol: string, name: string) => ({
    address,
    symbol,
    name,
    decimals: DECIMALS,
    mintAuthority: wallets.harness.address,
  })
  const state: DemoState = {
    version: 1,
    network: 'localnet',
    rpcUrl: endpoints.rpcUrl,
    wsUrl: endpoints.wsUrl,
    genesisHash,
    wallets: Object.fromEntries(
      WALLET_ROLES.map((r) => [r, wallets[r].address]),
    ) as DemoState['wallets'],
    mints: {
      dusd: mintInfo(dusd, 'DUSD', 'Demo Dollar'),
      dout: mintInfo(dout, 'DOUT', 'Demo Out'),
    },
    tokenAccounts: {
      ownerDusd: specs.ownerDusd.ata,
      ownerDout: specs.ownerDout.ata,
      recipientDusd: specs.recipientDusd.ata,
      attackerDusd: specs.attackerDusd.ata,
      attackerDusdB: attackerB.address,
      simulatorDusd: simulatorAcct.address,
      attackerDout: specs.attackerDout.ata,
      hotDusd: specs.hotDusd.ata,
      harnessDusd: specs.harnessDusd.ata,
      harnessDout: specs.harnessDout.ata,
    },
    pool: {
      state: pool.address,
      authority: poolAuthority,
      config: ammConfig.address,
      observation: observation.address,
      vaultDusd: specs.vaultDusd.ata,
      vaultDout: specs.vaultDout.ata,
      initialReserves: { dusd: AMOUNTS.poolDusd.toString(), dout: AMOUNTS.poolDout.toString() },
    },
    gated: { config: gatedConfig },
    initialBalances: {
      ownerDusd: AMOUNTS.ownerDusd.toString(),
      hotDusd: AMOUNTS.hotDusd.toString(),
      harnessDusd: AMOUNTS.harnessDusd.toString(),
    },
  }
  await writeState(state)

  await printSummary(chain, state)
}

async function printSummary(chain: DemoChain, s: DemoState): Promise<void> {
  log('')
  log(`environment ready: ${stateFile()} (public addresses only)`)
  log('  wallets')
  for (const r of WALLET_ROLES) {
    log(
      `    ${r.padEnd(10)} ${s.wallets[r]}  ${formatSol(await chain.balance(s.wallets[r])).padStart(9)} SOL`,
    )
  }
  log(
    `  mints      DUSD ${s.mints.dusd.address}   DOUT ${s.mints.dout.address}   (${DECIMALS} decimals, classic Token)`,
  )
  log('  token accounts')
  for (const [name, address] of Object.entries(s.tokenAccounts)) {
    log(
      `    ${name.padEnd(14)} ${address}  ${formatUnits6(await balanceOf(chain, address)).padStart(10)}`,
    )
  }
  log(`  pool       ${s.pool.state} (mock AMM, mode NORMAL)`)
  log(
    `    vaultDusd ${formatUnits6(await balanceOf(chain, s.pool.vaultDusd))}   vaultDout ${formatUnits6(await balanceOf(chain, s.pool.vaultDout))}`,
  )
  log(
    'Note: the mock AMM and every wallet here are local test fixtures; the demo attacker is a script.',
  )
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
