# @agentauth-sol/guard

> **Read this first. This package is a COOPERATIVE, CLIENT-SIDE guard, not enforcement.**
> It runs in the agent's own process and decides what *that process* will sign. Anyone who holds the
> raw agent key can sign without it (`test/bypass.test.ts` and `test/e2e.localnet.test.ts` prove it).
> Hard enforcement exists only in the AgentAuth **relay** (typed token transfer and the pinned swap).
> Unaudited devnet prototype. Not a defence against prompt injection, only a way to stop an honest
> or confused agent stack from signing what its mandate does not cover.

A thin integration slice that lets an existing agent stack adopt a mandate in a few lines:

| Surface | Export | Verified against |
|---|---|---|
| `@solana/kit` signer | `guardSigner(signer, opts)` | `@solana/kit@8.4.0`, unit tests + real localnet |
| Vercel AI SDK `toolApproval` | `agentAuthToolApproval(opts)` | `ai@7.0.137` with `MockLanguageModelV4` (no real LLM) |
| x402 client hook | `agentAuthX402Hook(opts)` | `@x402/core@2.28.0` + `@x402/fetch` + `@x402/svm@2.28.0`, fake 402 server (no facilitator, no real payment) |

Not implemented (no verified API in this slice): MCP proxy, Solana Agent Kit wallet, ElizaOS, Wallet
Standard `guardWallet`, OWS policy. Sending-only Kit signers are not supported.

## Kit: wrap the signer you already have

```ts
import { guardSigner } from '@agentauth-sol/guard'

const signer = guardSigner(agentKeyPairSigner, { rpc, mandate: mandateAddress }) // or { owner, agent }
// use `signer` as fee payer / authority exactly like before
```

Before ANY signature the transaction is decoded and every instruction is classified from its real
bytes (program id, canonical disc8 and amount parsed by `@agentauth-sol/registry`; nothing the agent
reports is trusted), then checked against the live mandate with the SDK `checkVerify` mirror, with
spend accumulated across the instructions of the same transaction.

| Instruction | Decision |
|---|---|
| ComputeBudget, Memo, `allowPrograms` | allowed without a permission (a priority fee is spend the mandate does not meter) |
| Relay instruction | allowed; the relay enforces it on chain |
| Known value-bearing instruction (System transfer, Token transfer, ...) | allowed only if the mandate covers program, disc8 and amount |
| Unknown program / unknown instruction | **denied** (`UNKNOWN_PROGRAM`, `UNKNOWN_INSTRUCTION`) |
| Token / Token-2022 `Batch` (tag 255, hides inner instructions) | **denied** (`BATCH_HIDES_INSTRUCTIONS`) |
| Approve, SetAuthority, CloseAccount, System Assign ... | **denied** (`AUTHORITY_CHANGE`) |
| Truncated amount, undecodable message, unresolved lookup tables | **denied** (`AMOUNT_UNPARSEABLE`, `UNSUPPORTED_TRANSACTION`) |

A refusal throws `GuardRefusedError`, which **is** an `AgentAuthError`: a mandate denial carries the
same `program / code / name` the chain would give (for example `agent_auth` 8 `PerTxExceeded`), a
guard default has `program: 'unknown'`, `code: 0`, `name: <RefusalCode>`. `error.explain()` prints one
line per instruction; `error.report` is the structured report.

When the transaction is allowed and `injectVerify` is on (default in `enforce` mode), one `verify`
instruction per covered instruction is **prepended** (amount and disc8 derived from the real bytes),
so the chain books the spend atomically with the action. `mode: 'dry-run'` never refuses and never
modifies; it only reports through `onReport`. `signer.evaluate(tx)` / `signer.explain(tx)` report
without signing.

## AI SDK

```ts
import { agentAuthToolApproval, createGuard } from '@agentauth-sol/guard'
const guard = createGuard({ rpc, mandate })
const toolApproval = agentAuthToolApproval({
  guard,
  tools: { transferSol: ({ lamports }) => [systemTransferIx({ from, to, lamports: BigInt(lamports) })] },
})
await generateText({ model, tools, toolApproval /* ... */ })
```

A call the mandate would deny returns `{ type: 'denied', reason }` before `execute()` runs, everything
else `not-applicable`. It fails closed if the mandate cannot be read. Provider-executed tools bypass
SDK approvals.

## x402

```ts
const client = new x402Client()
  .setSpendControls({ maxAmountPerPayment: '$10' }) // x402's own default ($1) runs BEFORE this hook
  .register('solana:*', new ExactSvmScheme(signer))
  .onBeforePaymentCreation(agentAuthX402Hook({ guard }))
```

The hook treats the payment as a Token `TransferChecked` of `selectedRequirements.amount`. It checks
but does not book spend (a `verify` instruction cannot ride in a default exact-SVM payment
transaction), and a mandate permission is per program, not per mint.

## Limits worth knowing

- **Bypassable by design**: see the top of this file. Use the relay when you need enforcement.
- A modified transaction invalidates other signers' earlier signatures; Kit runs modifying signers
  first, so use the guard as the first signer.
- Each covered instruction gets its own `verify`: per-call caps apply per instruction, only the
  lifetime cap bounds the sum.
- The pre-flight uses cluster time and the mandate at read time; the chain decides at execution.
- v0 transactions with address lookup tables are refused unless you pass `addressesByLookupTableAddress`.
- Registry coverage decides what is "known": System, SPL Token, Token-2022, ATA, Memo, ComputeBudget,
  Stake, Raydium CPMM, Orca Whirlpool. Everything else is denied by default.

## Run it

```sh
pnpm --filter @agentauth-sol/guard test            # unit tests (no network)
AA_LOCALNET_INSTANCE=<n> scripts/localnet.sh start
eval "$(AA_LOCALNET_INSTANCE=<n> scripts/localnet.sh env)"
pnpm --filter @agentauth-sol/demo bootstrap
pnpm --filter @agentauth-sol/guard test:e2e        # real validator
pnpm --filter @agentauth-sol/guard exec tsx examples/01-kit-agent.ts
pnpm --filter @agentauth-sol/guard exec tsx examples/02-ai-sdk-agent.ts
pnpm --filter @agentauth-sol/guard exec tsx examples/03-x402-client.ts
```

`examples/` are localnet-only. The AI SDK example uses the SDK's mock model (a script, not an LLM).
