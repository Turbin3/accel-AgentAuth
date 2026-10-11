# @agentauth-sol/demo

Local demo environment and the scripted, narrated demo scenarios for AgentAuth. **Unaudited devnet prototype; everything here runs on a local validator and spends nothing.** Hard enforcement exists only for the relay `transfer` and the pinned `swap`; everything else a mandate lists is advisory unless the integrating program calls `verify`. Every attacker in this package (MALLORY, the "compromised agent") is a **script**, labelled as such on screen.

## Quick start

```sh
export PATH="$HOME/.cargo/bin:$PATH"
pnpm install && scripts/build-all.sh              # once: dependencies and the programs
pnpm --filter "@agentauth-sol/demo^..." build       # once: the SDK the runners import (dist/ is not committed)
scripts/localnet.sh start                         # fresh validator (AA_LOCALNET_INSTANCE=<0-9> for a parallel one)
eval "$(scripts/localnet.sh env)"                 # AA_RPC_URL, AA_WS_URL, AA_DEMO_DIR
pnpm --filter @agentauth-sol/demo bootstrap       # keys, mints, token accounts, mock pool -> .demo/

pnpm --filter @agentauth-sol/demo contrast        # same injection, hot-wallet agent vs mandate agent
pnpm --filter @agentauth-sol/demo scenario        # the full beat sequence of the demo script, expected errors asserted
pnpm --filter @agentauth-sol/demo attacks         # 54 scripted attacks, a result table, balances verified unchanged
```

Each of the three accepts `--fast` (no pauses; for CI), `--json` (only the JSON transcript on stdout), `--pause <ms>` (default 1200) and `--transcript <file>` (write the JSON next to the human output). They exit non-zero on **any** deviation from the expected outcome.

All three are idempotent against the same validator: they use a fresh throwaway agent key per run, clear a stale SPL delegation left by an aborted run, restock the demo wallets from the harness (the mint authority) when they run low, unwind what they create, and restore the shared mock pool after the price-floor beat. `contrast` and `scenario` use the bootstrapped `owner`; `attacks` uses a fresh throwaway victim so the demo wallets never drift.

| Script | What it shows | Measured (2026-10-11, loaded laptop) |
|---|---|---|
| `contrast` | The same injected invoice against (A) a naive hot-wallet agent, which loses everything in one transaction, and (B) the mandate agent, which holds only its own key (printed) and no token authority: the relay refuses the attacker payee (relay 104) and raw SPL attempts by the agent key fail with Token `OwnerMismatch` (Custom 4), attributed to the **Token program**. | 18-19 s, 9 transactions |
| `scenario` | DEMO-SCRIPT beats 1 to 8: onboarding in 2 transactions with the plain-English explanation, allowed payment and swap, ten injected attacks, the second integrator (`gated-example`), the live per-instruction revoke (error 6 after `remove_permission`, error 7 after re-adding Token with a different discriminator list), pause and resume, the static price floor on the mock pool, the one-transaction unwind and the failed follow-up. | 49-70 s, 34 transactions |
| `attacks` | Deterministic suite of scripted attacks from RELAY-SPEC section 15 through the real instructions; asserts the documented error for each and that balances, the SPL delegation, pool reserves and mandate counters never change. Includes the accepted limitation L4 (splitting inside one transaction) and the pre-funded PDA griefing cases, both labelled for what they are. | 3-3.5 min, 70 transactions (54 attacks) |

Each beat prints what is attempted, who signs, the decoded outcome, the transaction signature, a localnet explorer URL (`explorer.solana.com` with `cluster=custom&customUrl=<your RPC>`) and a running scoreboard `attempted / blocked / allowed / funds lost`. Attacks are landed with `skipPreflight: true` so the failure is recorded on chain; a failed transaction still pays its fee.

## Live LLM agent

`live-agent/` has the harness for running a real model (Claude Code or Claude Desktop with the AgentAuth MCP agent profile) against the same localnet: `live-setup`, `live-check`, `live-unwind`, a malicious invoice file and a recording checklist. Nothing in this repository calls an LLM API. See [live-agent/README.md](live-agent/README.md).

## Layout

```
src/bootstrap.ts, smoke.ts, lib/     environment: keys, mints, token accounts, mock pool, shared helpers
src/scenarios/contrast.ts            demo:contrast
src/scenarios/scenario.ts            demo:scenario
src/scenarios/attacks.ts             demo:attacks
src/scenarios/lib/                   runner (narration, assertions, scoreboard, transcript), instruction tamper helpers, fixtures
live-agent/                          real-LLM harness: setup, check, unwind, invoice files, prompt, README
test/                                unit tests (vitest)
```

## Honest limits

* Local validator, mock AMM (Raydium CP-Swap ABI, constant product, no fees), classic SPL mints with 6 decimals. Rent, compute and sizes printed by the scripts are local-validator measurements, not devnet figures.
* The demo amounts are DUSD ("Demo Dollar"), not a real stablecoin.
* Scripted attackers show what an agent key can and cannot do through the real instructions. They do not prove the absence of bugs.
* Accepted, disclosed limitation L4: `per_tx_limit` is per `verify` call, so one transaction can carry several calls up to the lifetime limit. The `attacks` table shows it.
* `scenario` raises the mock-AMM lifetime limit with `update_permission` before the price-floor beat, because the demo script's own earlier beats exhaust it (a script inconsistency we resolve in the open).
