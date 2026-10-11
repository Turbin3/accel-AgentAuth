# scripts/ - build, test and the local environment

AgentAuth is an unaudited devnet prototype. Everything here targets a **local** validator; nothing deploys or spends real funds.

```sh
pnpm install
scripts/build-all.sh                              # every program -> target/deploy, target/deploy-localnet
pnpm --filter "@agentauth-sol/demo^..." build       # the SDK the demo imports (dist/ is not committed)
scripts/localnet.sh start                         # fresh validator on :8899/:8900/:9900, 4 programs preloaded
pnpm --filter @agentauth-sol/demo bootstrap       # keys, SOL, mints, token accounts, mock pool -> .demo/state.json
pnpm --filter @agentauth-sol/demo smoke --relay   # create_mandate + verify round trip, relay transfer + swap, unwind
scripts/localnet.sh stop
```

| Script | What it does |
|---|---|
| `build-all.sh` | `cargo build-sbf` for core, relay (default features = the devnet build), mock AMM, gated-example, evil-token and the cpi-crate fixtures, plus **`deploy-localnet/agent_auth_relay.so` built with `--features test-amm`** (the mock AMM is allowlisted). Prints sha256 and size of each. Idempotent. Honours `CARGO_TARGET_DIR`. |
| `test-all.sh` | build, then `cargo test --workspace` with every `*_SO` variable set (`env.sh`; a missing `.so` is a hard failure), then `pnpm -r test`. Extra args go to `cargo test`. |
| `env.sh` | `source scripts/env.sh` exports `AGENT_AUTH_SO`, `AGENT_AUTH_RELAY_SO`, `AGENT_AUTH_RELAY_TESTAMM_SO`, `MOCK_AMM_SO`, `GATED_EXAMPLE_SO`, `EVIL_TOKEN_SO`, `FIXTURE_*_SO`. |
| `localnet.sh start\|stop\|reset\|status` | `solana-test-validator --reset` (ledger and log under `/tmp/agentauth-localnet`, override with `AA_LOCALNET_DIR`). Loads core `AKkih5Yd...`, the localnet relay `33Vpe...`, mock AMM `6QhMS...`, gated-example `CoXCz...`; waits for `getHealth` and for every program to be executable. Works from any cwd, refuses to start twice, only ever stops its own validator. |

All scripts are `set -euo pipefail` and shellcheck-clean.

**The localnet relay is not the devnet relay.** `deploy-localnet/agent_auth_relay.so` allowlists the mock AMM and must never be deployed to devnet or mainnet. `deploy/agent_auth_relay.so` is the one to ship.

## The demo environment (`apps/demo`)

`bootstrap` is idempotent. It writes keypairs to `.demo/keys/*.json` (gitignored, directory 700, files 600, never printed), airdrops SOL, and creates everything below. Public addresses go to `.demo/state.json`; apps read them with `loadDemoEnv()` from `@agentauth-sol/demo` and the keys with `loadDemoSigners(env)`. Because every address derives from the persisted keypairs, a reset ledger gets the same addresses back (`checkDemoEnv` flags a stale `state.json` by genesis hash).

| Cast | Holds |
|---|---|
| `owner` (human) | 100 SOL, 1,000 DUSD (source and swap input) and an empty DOUT account (swap output) |
| `agent` | 0.05 SOL for fees, no token accounts |
| `recipient` ("Alice") | the allowlisted DUSD account |
| `attacker` | empty DUSD, DOUT and a second DUSD account for the control beat. **A scripted "compromised agent", not an AI.** |
| `hot` | a naive agent's own wallet with 50 DUSD (control beat) |
| `harness` | mint authority of both mints, 1,000 DUSD for the price-floor "searcher" |

DUSD ("Demo Dollar") and DOUT are classic SPL mints with 6 decimals. The pool is a **mock AMM** (Raydium CP-Swap ABI, constant product, no fees) with 10,000 DUSD / 10,000 DOUT; gated-example is initialised to honour only the `owner` wallet.

`bootstrap --refill` restocks the wallets and the pool to the amounts above. `smoke` uses throwaway in-memory keys; `--relay` moves the shared pool slightly. Environment overrides: `AA_DEMO_DIR`, `AA_RPC_URL`, `AA_WS_URL`; a non-loopback RPC is refused unless `AA_ALLOW_REMOTE=1`.

## Honest limits

Hard enforcement exists only for the relay `transfer` and the pinned `swap`; everything else a mandate lists is advisory unless the integrating program calls `verify`. These scripts exercise a local test setup, not mainnet conditions, and the build times above are for a warm cargo cache.

## Parallel instances

Several people (or agents) on one machine can each run their own validator, so one reset never kills another's run:

```bash
AA_LOCALNET_INSTANCE=2 scripts/localnet.sh start            # rpc :8919, ws :8920, faucet :9902, ledger /tmp/agentauth-localnet-2
eval "$(AA_LOCALNET_INSTANCE=2 scripts/localnet.sh env)"    # AA_RPC_URL, AA_WS_URL, AA_DEMO_DIR=<repo>/.demo-2
pnpm --filter @agentauth-sol/demo bootstrap
AA_LOCALNET_INSTANCE=2 scripts/localnet.sh stop
```

Instance `n` (0-9) uses rpc `8899 + 10n`, websocket `rpc + 1`, faucet `9900 + n`, gossip `7000 + n` and its own dynamic port range. Instance 0 is the default and keeps the original ports.
