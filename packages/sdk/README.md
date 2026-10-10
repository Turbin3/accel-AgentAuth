# @agentauth-sol/sdk

TypeScript SDK for **AgentAuth**: on-chain _mandates_ that say which programs and which instructions
an AI agent may call, with per-call and lifetime limits and an expiry, plus the **Relay**, the one
place where those limits are hard-enforced.

> **Status: unaudited devnet prototype.** Not audited, not mainnet-ready. Do not put funds behind it
> that you cannot lose. Program ids are devnet test deployments.

**The complete, frozen reference is [API.md](./API.md)**: every export with signature, semantics,
errors thrown and an example, plus ten verified consumer recipes (CLI, MCP, dashboard, seller,
kill switch, attack simulator).

- ESM, strict TypeScript, tree-shakeable named exports. `@solana/kit` ^8.4.0 is the only (peer)
  dependency. Node >= 20 and browsers. `require()` works on Node 22.12+ (the `default` export
  condition points at the ESM build).
- Every `u64`/`i64` is a `bigint`; no floating point anywhere (see `parseUnits`). Time is unix
  **seconds** (`expiresIn('7d')`; millisecond-looking values are refused).
- Plans and builders never sign or send. `client.sendAndConfirm` / `sendAndConfirmStep` are explicit
  opt-ins that sign with the signers you pass. The SDK stores no keys and has no global state.

## Install

```sh
pnpm add @agentauth-sol/sdk @solana/kit
```

## Quickstart (read, plan, send, explain a denial)

```ts
import { address, generateKeyPairSigner } from '@solana/kit'
import {
  createClient,
  expiresIn,
  parseUnits,
  parseProgramError,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_DISC,
} from '@agentauth-sol/sdk'

// 1. A client (devnet; reads at `confirmed`). `createClient({ cluster: 'localnet', programIds })` for tests.
const client = createClient({ cluster: 'devnet' })

// 2. Read a mandate as a human: mandate + relay policy + live SPL delegation + mint decimals in
//    at most three round trips. `can` is cross-checked against the policy and the delegation.
const owner = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xDh1Z8qy5z')
const agent = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLaPSpXJ3b6Ax')
const { address: mandateAddress, mandate } = await client.fetchMandateFor(owner, agent)
if (mandate) {
  const view = await client.inspect(mandateAddress)
  console.log(view.explanation?.headline, view.explanation?.can, view.explanation?.warnings)
  console.log(view.capacity) // { maxSpendNow, limitedBy, blockedBy, ... }
}

// 3. Plan the owner onboarding (UNSIGNED), then send each step in order with your signer.
const wallet = await generateKeyPairSigner() // in real code: your wallet's signer
const mint = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') // example mint
const ownerTokenAccount = address('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1') // example address
const recipientTokenAccount = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM') // example address
const plan = await client.plan.onboarding({
  owner: wallet,
  agent,
  expiry: expiresIn('7d'),
  fundAgentLamports: 10_000_000n,
  token: { mint, source: ownerTokenAccount, delegateCap: parseUnits('5', 6) },
  permissions: [
    {
      program: TOKEN_PROGRAM_ID,
      spendLimit: parseUnits('5', 6), // never 0n; write 'unlimited' if you mean it
      perTxLimit: parseUnits('1', 6),
      discriminators: [TRANSFER_CHECKED_DISC],
    },
  ],
  recipients: [recipientTokenAccount], // token ACCOUNTS, not wallets
})
console.log(plan.summary, plan.warnings)
for (const step of plan.steps) {
  // step.dependsOn / step.awaitConfirmation: step 2 (init_policy) needs step 1 confirmed.
  const res = await client.sendAndConfirm(step, { signers: [wallet] })
  if (!res.ok) throw res.error // AgentAuthError decoded from the logs
}

// 4. A denial is explained, not just numbered:
const err = parseProgramError({ InstructionError: [0, { Custom: 104 }] })
console.log(err?.program, err?.name, err?.hint) // relay RecipientNotAllowed, with the fix to try
```

More: [API.md recipes](./API.md#consumer-recipes). The agent's payment is
`relayTransferIx({ agent, policy, destination, amount })` after `client.preflightTransfer(...)`.

## Honesty notes (read these before you rely on anything)

1. **`verify` is advisory.** It trusts the program id, discriminator and amount the _caller_
   reports, and any program can call it. A mandate only constrains an action when whichever program
   performs the action derives those values itself and gates on the result.
2. **Hard enforcement exists in exactly two places:** the relay's `transfer` (SPL `TransferChecked`
   to an allowlisted token account) and its `swap` (one pinned Raydium-CP-Swap-ABI pool, output
   forced into the owner's own account, floor price). Everything else a mandate lists is advisory.
   `explainMandate` labels every action `hard (relay)` or `advisory (integrator must call verify)`;
   with no relay policy, _nothing_ is labelled hard.
3. **The 0 trap.** On chain `spend_limit = 0` and `per_tx_limit = 0` mean **UNLIMITED** (a fail-open
   sentinel kept for layout compatibility). The builders therefore refuse a bare `0n`
   (`ZERO_LIMIT_AMBIGUOUS`); you must write `"unlimited"` and the onboarding plan additionally
   refuses it unless `allowUnlimited: true`. Decoded permissions expose `spendUnlimited` /
   `perTxUnlimited` so UIs never print "0".
4. **Spend counters are unit-less and per target program.** Every mint and every decimal of the
   same program shares one raw-unit counter. Only the relay pins a single mint; elsewhere use one
   mandate per asset. The SDK never claims a USD value.
5. **Recipients are token accounts, not wallets.** Whoever controls an allowlisted account's owner
   field can redirect future payments.
6. **`per_tx_limit` is per `verify` call, not per transaction.** No daily or rolling windows.
7. **Expiry:** a mandate is expired iff `now >= expiry` (the first invalid second). `checkVerify`
   uses the `now` you pass; the cluster Clock decides on chain.
8. **Pre-flight is not a guarantee.** `checkVerify`, `checkRelayTransfer` and `checkRelaySwap` mirror
   the check _order_ of the programs for the state you give them. They do not simulate the AMM,
   compute limits or the post-CPI balance checks (relay 106, 112, 119).
9. **A scripted "compromised agent" is a script.** The SDK helps _cap_ the blast radius on chain; it
   does not prevent prompt injection, does not protect from MEV, and does not claim immutability.
10. **Client-side validation mirrors, it does not replace, the programs.** Every rejection the SDK
    makes (for example `BAD_CONFIG` with `relayCode: 113`) is a rule the program enforces too.

## Errors

- On-chain failures: `parseProgramError(logs | simulation | error)` returns an `AgentAuthError`
  `{ program: 'agent_auth' | 'relay' | 'token' | 'system' | 'mock_amm' | 'runtime' | 'unknown', code,
name, message, hint, retryable, logs }`. The ORIGIN frame in the logs decides which table applies;
  a wrapper (the relay re-reporting a CPI failure) never overrides a foreign program that raised the
  code. Well-known runtime failures (`NotEnoughAccountKeys`, `InvalidAccountData`,
  `MissingRequiredSignature`, `AccountNotFound`, `BlockhashNotFound`, compute exhaustion) come back
  as `program: 'runtime'`. Without logs only 104..119 are attributed to the relay; 100..103 are also
  Anchor framework codes and stay `unknown`.
- Client-side failures: `ValidationError` (bad input, nothing built), `DecodeError` (on-chain bytes
  do not look like what they claim), `PlanRefusedError` (an unsafe plan; `reasons` lists all of
  them). All extend `SdkError` and carry a stable `code`.

## Plans

Every `plan*` function returns `{ steps, warnings, summary }`. A step is
`{ label, description, instructions, signers, expectedOutcome, estimatedSizeBytes,
worstCaseSizeBytes, fitsInOneTx, dependsOn, awaitConfirmation }`. `estimatedSizeBytes` is the exact
legacy-transaction size; `worstCaseSizeBytes` adds the v0 prefix and two compute-budget instructions
(+54 bytes), and `fitsInOneTx` is judged on the worst case. `client.plan.*` fills in `chainState`
(mandate, policy, the token accounts involved) from the RPC; the bare `plan*` functions work offline
when you pass `chainState` yourself.

| plan                       | transactions                                                                                                                                      | refuses                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `planOnboarding`           | 1) fund agent, `create_mandate`, `add_permission`..., SPL `Approve`; 2) relay `init_policy` (depends on 1)                                        | unlimited or >= 2^63 limits, `delegateCap` above the smallest lifetime limit, missing Token/AMM permissions, default-deny instructions (SPL mint/freeze/authority, System assign/allocate...), an existing mandate/policy, a different existing SPL delegate (unless `allowReplaceDelegate`), past/millisecond/beyond-1-year expiry, funding above 1 SOL, invalid relay config |
| `planUnwind`               | with known chain state: `Revoke`(s), `revoke_mandate`, `close_policy` in **one** transaction; with unknown state: kill switch alone, then cleanup | nothing left to unwind                                                                                                                                                                                                                                                                                                                                                         |
| `planPause` / `planResume` | relay `set_paused` and/or core `set_active`                                                                                                       | nothing to do for the scope                                                                                                                                                                                                                                                                                                                                                    |
| `planRevokePermission`     | `remove_permission` (optionally re-add narrower, remaining budget carried over; never widens unless `allowWiden`)                                 | unknown program, used-up budget with `replaceWith`                                                                                                                                                                                                                                                                                                                             |
| `planRevokeDiscriminator`  | takes one discriminator away, computes the kept list                                                                                              | unknown slot or discriminator                                                                                                                                                                                                                                                                                                                                                  |
| `planUpdateLimits`         | `update_permission` (counters preserved)                                                                                                          | unlimited unless `allowUnlimited`                                                                                                                                                                                                                                                                                                                                              |
| `planClosePolicy`          | relay `close_policy`                                                                                                                              | no policy                                                                                                                                                                                                                                                                                                                                                                      |
| `planReinitPolicy`         | `close_policy` then `init_policy` (two transactions)                                                                                              | invalid config                                                                                                                                                                                                                                                                                                                                                                 |

## Testing

```sh
pnpm --filter @agentauth-sol/sdk test       # vitest, fully offline
pnpm --filter @agentauth-sol/sdk typecheck  # tsc --noEmit (strict), includes the API.md recipes
pnpm --filter @agentauth-sol/sdk lint       # tsc --noEmit + prettier --check
pnpm --filter @agentauth-sol/sdk build      # tsup -> dist/index.js + index.d.ts
```

The suite checks the encoders byte for byte against the relay design vectors (`test/fixtures/`),
decodes the real core goldens, derives every builder's accounts and data from `idl/core-idl.json`
and `idl/relay-idl.json` (IDL drift fails the build), has a truth table for `checkVerify`, and
verifies that every recipe in API.md is the code that typechecks. The tests are offline; LiteSVM
differential tests against the real programs belong to the integration workflow.

## Registry

Names and risk classes come from `@agentauth-sol/registry` when you pass it
(`createClient({ registry })`, `explainMandate(m, { registry })`). Without it the SDK falls back to a
small built-in table (SPL Token and Token-2022 including mint/freeze/authority rows, System
value/authority rows, Raydium CP-Swap ABI, mock AMM, gated-example). `loadRegistry()` tries to import
the package lazily and resolves to `null` when it is not installed. Permissions on instructions no
registry knows produce a plan warning (`requireKnownInstructions: true` refuses them).
