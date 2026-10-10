# @agentauth-sol/cli

`agentauth` is the command line for AgentAuth: give an AI agent a **mandate** on Solana (which programs and instructions it may call, with per-call and lifetime limits and an expiry), see exactly what it did, and take the mandate back.

> **Honesty.** AgentAuth is an **unaudited devnet prototype**. Hard enforcement exists only for the **relay transfer** (SPL `TransferChecked` to allowlisted token accounts) and the **pinned single-pool swap**, and only while the owner's SPL delegation is in place. Everything else a mandate lists is **advisory**: it binds a program only if that program calls `verify`. This CLI prints that distinction on every preview. A scripted "compromised agent" in the demos is a script, not an AI. The CLI refuses `mainnet-beta` unless you pass `--i-understand-this-is-unaudited` (and AgentAuth is not deployed there).

Everything here is built on `@agentauth-sol/sdk` (the frozen contract) and `@agentauth-sol/registry`; the CLI re-implements none of their logic. Read-only commands work without a keypair.

## The 2-minute tour (local validator)

```bash
# 1. a local validator with the programs, and the demo cast (owner, agent, Alice, a scripted attacker)
scripts/localnet.sh start
pnpm --filter @agentauth-sol/demo bootstrap
pnpm --filter @agentauth-sol/cli build
alias agentauth="node $PWD/packages/cli/dist/index.js"     # or: pnpm --filter @agentauth-sol/cli exec agentauth

agentauth doctor                       # node, RPC, the four programs, keypairs, balances
```

When the demo environment exists the CLI defaults to `--cluster localnet` and uses the demo keys (`owner` as `--keypair`, `agent` as `--agent-keypair`); `@recipientDusd`, `@attackerDusd`, `@ownerDusd`, `@dusd` ... are address aliases for the demo accounts. On devnet you pass real addresses and keypair files.

```bash
# 2. look before you leap: lint a preset or your own plan (no chain, no keys)
agentauth lint payments-usdc
agentauth registry preset payments-usdc

# 3. create a mandate. The preview lists WARNINGS first, then what the agent can/cannot do and which
#    parts are HARD vs ADVISORY; nothing is sent until you confirm (or pass --yes).
agentauth mandate create --preset payments-usdc \
  --per-call "5 DUSD" --budget "20 DUSD" --delegate "50 DUSD" --allow-override \
  --recipient @recipientDusd --swap-pool demo --swap-per-call 5 --swap-budget 10

# 4. the AGENT works (signs with the agent key, which holds no token authority)
agentauth relay pay --to @recipientDusd --amount "3 DUSD"           # ok
agentauth relay pay --to @attackerDusd  --amount "40 DUSD"          # exit 2: relay:104 RecipientNotAllowed (pre-flight)
agentauth relay pay --to @attackerDusd  --amount "40 DUSD" --no-preflight   # exit 3: lands on chain, fails, decoded

# 5. the OWNER changes the rules live, then looks at the record
agentauth permission remove spl-token --yes                         # agent now gets agent_auth:6 ProgramNotAllowed
agentauth activity                                                  # ok rows and BLOCKED attempts with the decoded reason

# 6. take it all back in ONE transaction
agentauth mandate revoke --yes
agentauth relay pay --to @recipientDusd --amount "1 DUSD"           # exit 2: relay:101 InvalidPolicy
```

The real, unedited output of this story (asserted step by step against a fresh validator) is in [`docs/e2e-transcript.txt`](docs/e2e-transcript.txt); regenerate it with `AA_LOCALNET_INSTANCE=<n> packages/cli/test/e2e.sh`.

## Global options

| Option | Meaning |
|---|---|
| `--cluster localnet\|devnet\|mainnet-beta` | Default `localnet` when a bootstrapped demo environment is found (`AA_DEMO_DIR`, or a `.demo` directory above the working directory), else `devnet`. `mainnet-beta` is refused without `--i-understand-this-is-unaudited` and prints an UNAUDITED banner. |
| `--url <rpc>` | RPC endpoint. Localnet default: `AA_RPC_URL`, else the demo state, else `http://127.0.0.1:8899`. |
| `--keypair <path>` | Owner keypair (default `~/.config/solana/id.json`, or the demo owner on localnet). |
| `--agent-keypair <path>` | Agent keypair for `relay pay` / `relay swap` (default: the demo agent on localnet). |
| `--json` | Machine-readable output, see below. |
| `--yes` | Do not ask for confirmation. Without it a non-interactive terminal refuses (exit 1). |
| `--simulate` | Simulate instead of sending. Steps that depend on an earlier step cannot be simulated and are reported as such. |
| `--no-color` | No colour. `NO_COLOR` is honoured too; colour is also off when stdout is not a terminal. |
| `--raw` | Show and accept raw base units instead of human amounts. |

Secret key material is never printed; keypair files are read only to sign.

## Commands

| Command | What it does |
|---|---|
| `doctor` | Environment, RPC, program availability, keypairs and balances. Read-only. |
| `registry list \| show <program> \| decode <program> <hex...> \| presets \| preset <name>` | The verified catalog: instructions with canonical `disc8`, risk class, default-deny flag, decoded amounts, presets with their honest limits. Read-only. `decode` takes the program and the instruction data as hex; several hex arguments are joined and `0x` prefixes are ignored. |
| `mandate create` | Preview (warnings first) then send the planned transactions in order; prints signatures and explorer links. `--preset`, `--mint`, `--source`, `--recipient` (repeatable), `--per-call`, `--budget`, `--delegate`, `--expiry 7d\|ISO\|unix`, `--swap-pool demo\|file.json`, `--allow-unlimited`, `--dry-run`. Limits are never guessed: both `--per-call` and `--budget` are required. |
| `mandate show \| explain [agent-or-mandate]` | Status, limits spent, relay policy, live SPL delegation and capacity (`show`); the plain-English narrative with HARD/ADVISORY labels (`explain`). |
| `mandate list --owner <addr>` | The mandates an owner created. |
| `mandate pause \| resume [--scope relay\|mandate\|both]` | Reversible kill switch (relay `set_paused` and/or core `set_active`). |
| `mandate revoke` | The one-transaction unwind (SPL `Revoke`, `revoke_mandate`, `close_policy`) with a size check against the 1232-byte limit. |
| `permission add \| update \| remove <program> [instructions...]` | Edit a mandate live. Instruction names come from the registry; default-deny instructions need `--allow-default-deny`. `remove` with instruction names takes only those away: the next call to one of them fails with `agent_auth:7` DiscriminatorNotAllowed, unless none would remain, in which case the whole slot goes and it fails with `agent_auth:6` ProgramNotAllowed (the preview predicts which, from the live permission). Without names it removes the slot (`agent_auth:6`). |
| `relay status` | The policy, delegation, balance and what the agent can move right now. |
| `relay pay --to <token account> --amount "25 DUSD"` | Agent-signed hard-enforced payment. Pre-flights with the SDK mirror (exit 2 on denial), then sends. `--no-preflight` skips both the local check and the RPC preflight so the attempt lands on chain and is recorded (a failed attempt still pays the fee). |
| `relay swap --amount-in "5 DUSD" [--min-out ...]` | Swap through the one pinned pool; the relay enforces `max(min-out, floor)`. Not MEV protection. |
| `check --program <p> --instruction <i> --amount <n>` | Pre-flight only: would the mandate authorise this call now? Advisory; sends nothing. |
| `activity [agent-or-mandate] [--address <mandate>] [--follow]` | `--address` reads the history of a mandate that no longer exists (after `mandate revoke`). Table of time, kind, outcome (`ok` or `BLOCKED relay:104 RecipientNotAllowed`), amount and signature. The `verify` call nested in a relay action is folded into the relay row (`--all` shows it). |
| `lint <plan.json\|-\|preset>` | Static analysis for CI, below. |
| `version` | The CLI version. |

Addresses for recipients are **token accounts**, not wallets: the relay pins accounts. Amounts are human units (`"25 DUSD"`, `25`, `0.5`); a symbol suffix is accepted only when it equals the mint's known symbol, so `"25 USDC"` can never be read as a different token.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Usage error (bad flag, unknown program, missing confirmation, cancelled). **`lint` also exits 1 when it finds an error-level problem** (CI convention). |
| 2 | Denied before anything was sent: the SDK pre-flight, a refused plan (`PlanRefusedError`), a failed simulation, or `check` saying no. |
| 3 | On-chain failure: the transaction was sent (or the RPC rejected it with a program error). The decoded program error is shown. |
| 4 | Network: the RPC cannot be reached, or a send timed out (the transaction may or may not have landed: check the signature). |

Every error prints the decoded program error (`relay:104 RecipientNotAllowed`), what it means and a fix hint. Program names matter because codes overlap between programs; the SDK attributes them from the failing program id in the logs.

## `--json`

With `--json` stdout is exactly one JSON document (progress goes nowhere; `activity --follow` prints one document per line). `bigint` values are decimal strings, bytes are hex, keys are never present.

```jsonc
// success
{ "schema": "agentauth-cli/1", "ok": true, "command": "relay pay", "cluster": "localnet", "data": { ... } }
// failure (the process exit code is also in the document)
{ "schema": "agentauth-cli/1", "ok": false, "command": "relay pay", "cluster": "localnet",
  "error": { "kind": "denied", "message": "...", "hint": "...",
             "program": { "program": "relay", "code": 104, "name": "RecipientNotAllowed", "message": "...", "hint": "...", "retryable": false },
             "programErrorSource": "relay" },
  "exitCode": 2, "data": null }
```

`error.kind` is one of `usage`, `denied`, `onchain`, `network` (exit codes 1 to 4). `schema` changes only for breaking changes. The shapes are pinned by snapshot tests (`test/__snapshots__`).

## Lint a plan in CI

`agentauth lint` reads a mandate **plan** (or the name of a registry preset) and reports problems without touching the network or any key. It is static analysis of intent, not a proof of safety: it uses the registry's risk classes, which are conservative judgements from cited sources.

```bash
agentauth lint plan.json --max-expiry 30d            # exit 1 on any error
agentauth lint plan.json --json                      # machine-readable findings
agentauth lint plan.json --fail-on warn              # also fail on warnings
agentauth lint payments-usdc                         # a registry preset (relay/expiry settings are yours to lint)
cat plan.json | agentauth lint -
```

| Rule | Severity | Flags |
|---|---|---|
| AA001 | error | Unlimited (`0` / `"unlimited"`) lifetime or per-call limit on a value-moving permission, or an unlimited SPL delegation. On chain, 0 means unlimited. |
| AA002 | error | Relay delegation larger than the lifetime budget (the SPL delegation should be the independent backstop, not the only cap). |
| AA003 | error | An allowed instruction whose registry risk class is `authority_change`, `account_close` or `admin` (default-deny). |
| AA004 | error | Expiry beyond `--max-expiry`. |
| AA005 | warn | A value-out permission with no recipient allowlist (no relay, or an empty allowlist, which makes every relay transfer fail). |
| AA006 | warn | A permission used with several mints: spend counters are unit-less per program. |
| AA007 | error | A swap permission without a price floor (`relay.swap.floorOut/floorIn`), or with no relay at all. |
| AA008 | error | The agent key in the owner role (`owner == agent`, or the funded token account owned by the agent). |
| AA009 | warn | A program or instruction the registry does not know (risk unknown). |
| AA010 | error | Malformed plan (missing or unreadable fields, expiry in the past, expiry in milliseconds). |
| AA011 | info | The permission is advisory: only the relay transfer and the pinned swap are hard-enforced. |
| AA012 | warn | Per-call limit larger than the lifetime budget. |

Rule ids are stable; new rules get new ids. Plan file format (all amounts are decimals in token units of the permission's mint, or `"unlimited"`):

```json
{
  "owner": "<address>",
  "agent": "<address>",
  "expiry": "7d",
  "permissions": [
    { "program": "spl-token", "instructions": ["transfer_checked"], "spendLimit": "500", "perTxLimit": "50", "mints": ["USDC"] }
  ],
  "relay": {
    "recipients": ["<token account>"],
    "delegate": "500",
    "swap": { "floorOut": "95", "floorIn": "100" },
    "sourceAccountOwner": "<address>"
  }
}
```

`program` is a registry slug (`spl-token`), one of `agent-auth`, `relay`, `mock-amm`, `gated-example`, or a program id; `instructions` are registry names or 16-hex `disc8` values; `relay` may be `null` (no relay); `expiry` is a duration, an ISO timestamp or unix seconds. See [`test/fixtures`](test/fixtures) for a clean plan and a plan that trips most rules.

GitHub Actions snippet (copy into `.github/workflows/agentauth-lint.yml`; the package is not published yet, so build it from the repo or replace the install step once it is):

```yaml
name: agentauth-lint
on: [pull_request]
jobs:
  lint-mandate-plans:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @agentauth-sol/cli build
      - name: Lint every mandate plan
        run: |
          for plan in mandates/*.json; do
            node packages/cli/dist/index.js lint "$plan" --max-expiry 30d --json | tee "lint-$(basename "$plan")"
          done
```

(GitHub's default `bash` shell runs with `-e -o pipefail`, so a plan with an error-level finding fails the step even through `tee`.)

## Development

```bash
pnpm --filter @agentauth-sol/cli typecheck && pnpm --filter @agentauth-sol/cli lint
pnpm --filter @agentauth-sol/cli test            # unit + wiring tests with an injected SDK client
pnpm --filter @agentauth-sol/cli build           # tsup -> dist/index.js (bin: agentauth)
AA_LOCALNET_INSTANCE=1 packages/cli/test/e2e.sh  # real validator, wipes that instance, writes docs/e2e-transcript.txt
```

The e2e script uses the localnet relay build (`target/deploy-localnet`, which allowlists the mock AMM). **Never deploy that build to devnet.**
