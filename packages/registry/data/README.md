# Registry data

Hand-curated JSON read by `@agentauth-sol/registry`. Format rules, the canonical `disc8` convention and the risk classes are in `../SCHEMA.md`. Every value here was taken from a primary source (official IDL, program source or issuer docs) and the source is recorded next to it. Nothing is guessed; if a fact could not be verified it is omitted.

## Layout

| Path | Contents |
|---|---|
| `programs/<slug>.json` | One file per program: program ids, instruction names, canonical `disc8`, risk class, amount offsets, sources, verification. Covers system, spl-token, spl-token-2022, associated-token-account, memo, compute-budget, stake, orca-whirlpool, raydium-cpmm. |
| `mints.json` | Well-known token mints per cluster: address, decimals, owning token program, visible Token-2022 extensions, authorities, sources. |
| `presets/<name>.json` | Ready-made permission sets built only from instructions that exist in `programs/`. Five presets: `payments-usdc`, `treasury-ops`, `dex-trader-single-pool`, `lp-manager`, `read-only-observer`. |

## mints.json

* `relayCompatible` is true only for a classic SPL Token mint with no Token-2022 extension, because the AgentAuth relay supports only extension-free mints. PYUSD and CASH are Token-2022 with extensions and are not relay compatible. Wrapped SOL is classic but the relay rejects it as the budget or input mint.
* Addresses come from the issuer or protocol documentation (Circle, Tether, Paxos, Phantom, Marinade, Jito, SPL Token source). Owner program, decimals, extensions and authorities were then read with a read-only `getAccountInfo` on the named cluster.
* A cluster is listed only when an official source gives the address and the account exists there. USDT and CASH have no devnet entry. Devnet mints can differ from mainnet (USDC, PYUSD, JitoSOL) or match it (wSOL, mSOL).
* Issuer freeze authorities (USDC, USDT, PYUSD, CASH) and permanent delegates (PYUSD, CASH) are outside AgentAuth control and are listed in `authorities` and `notes`.
* Phantom's CASH page calls the standard "SPL Token" but the mint is owned by Token-2022 on-chain; the on-chain facts are recorded.

## presets

Format: `{schemaVersion, name, title, description, audience, risk_summary, permissions[], explicitly_blocked[], requires, honest_limits[]}`.

* `permissions[]` entries name a program slug and exact instruction names from `programs/`. `suggested` limits are examples with human units and a note, not defaults.
* `explicitly_blocked[]` lists every `authority_change`, `account_close` and `admin` instruction (every `defaultDeny` one) of each referenced program, plus value-moving instructions that are deliberately not allowlisted. Each carries a reason.
* `requires` lists mints (symbols in `mints.json`), whether the relay is needed, and warnings.
* `honest_limits` repeats what a preset cannot promise. Read it before relying on a preset:
  * per-tx limits are per verify call;
  * spend counters are unit-less per program, not per mint;
  * only relay `transfer_checked` and the pinned swap are hard enforced, everything else is advisory unless the integrator calls verify.

`lp-manager` withholds the Orca instructions that can send value to a caller-chosen account (liquidity decrease, fee and reward collection, reposition, all swaps); see its `permissions[0].notes`.

## Verification status

All data is unaudited and was checked on 2026-10-10 and 2026-10-11. Anchor discriminators were recomputed from names with `packages/registry/scripts/disc.js`. Items marked `medium` confidence in the earlier verification pass (associated-token-account, memo) have one-sided evidence, see their `notes`. Re-verify before relying on a value in production.
