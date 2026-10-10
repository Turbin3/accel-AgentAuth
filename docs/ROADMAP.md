# Roadmap

These are the next steps we consider worth doing, in a rough order of dependence, with the reason for
each and what it depends on. **No dates are promised.** Nothing here is a commitment until a maintainer
schedules it. The project is an unaudited devnet prototype; the first block is about making that
statement less true, in order. See [SECURITY.md](SECURITY.md) for the limitations several items answer.

## 1. Close the evidence gaps (small, no external dependency)

| Item | Why | Depends on |
|---|---|---|
| Commit the mutation scripts and the red-team harness into the repository | Today the 98-of-99 core mutation result and the relay red team cannot be re-run from a clean checkout ([SECURITY.md](SECURITY.md) sections 8 and 9) | Cleaning up the scripts (they refer to local paths) |
| Finish the 233-mutant relay campaign and triage the interim survivors | Each survivor is either an equivalent mutant or a test gap; the binding checks (`C15` to `C17`) matter most | The campaign finishing; a decision per survivor |
| Replay the one deep-fuzz case that ended in a runtime "Could not create program address" error (seed 424243, iteration 145,566) | Establish that it is only an error-code quality issue, then map it to a relay error or document it | Reproducing with the recorded seed |
| Measure swap compute units and behaviour against the real Raydium CP-Swap binary (`SW-15`) | Today only the mock AMM is tested; the real binary may differ | A dumped devnet binary and a devnet pool |
| ~~Regenerate or retire the overview docx~~ | Done: moved to `docs/archive/pre-hackathon/` and marked superseded (it had drifted from the code: SPEC-15, MATH-14) | none |
| Publish a verifiable build for each deployed program | Lets anyone tie deployed bytes to source ([AUDIT-PREP.md](AUDIT-PREP.md) section 4.4) | A public repository and a deployment |

## 2. Deployment and governance

| Item | Why | Depends on |
|---|---|---|
| Redeploy the hardened core to devnet and deploy the relay | Devnet runs the baseline lineage; the relay is not deployed ([SECURITY.md](SECURITY.md) section 6) | The program authority key holder; funds for rent |
| Move upgrade authority to a multisig with a timelock, then burn it for a release candidate | The upgrade authority is the largest residual trust; "immutable" may only be claimed after `solana program show` proves it | Multisig membership; a decision about how much upgradeability is needed before a stable ABI |
| Independent security audit of the core, the relay and the integrator crate | No external review has happened. Scope and questions: [AUDIT-PREP.md](AUDIT-PREP.md) | Funding; an auditor; a frozen commit |
| Bug bounty with a defined scope | Gives researchers a channel and reward after an audit | An audit first; funds |

## 3. Protocol features

Each of these changes either the relay, the core, or both. The core account layout (2136 bytes), the
`verify` ABI and error codes 1 to 22 are frozen; a change that needs more state means a new account
version or a new program, and has to be designed as such.

| Item | Why | Depends on |
|---|---|---|
| Rolling-window limits (daily, hourly) | The core has lifetime counters only; a stolen key can spend a whole lifetime budget at once. Periodic limits are offered by most of the systems in [COMPARISON.md](COMPARISON.md) | A layout version with window fields; migration for existing mandates; a clock rule |
| Mandate generation id | Removes the same-expiry re-bind of a stale relay policy (RT-F2) | The same layout work as rolling windows |
| Per-asset budgets in the core | Today one counter covers every mint reported under a program (MATH-6). The relay pins one mint; the core does not | A convention (scoped keys) or a layout field |
| Per-recipient limits and USD-denominated budgets | Raw units of one mint are hard to reason about | A price source, which brings its own trust; probably an integrator-side feature |
| Token-2022 extensions | Real mints use extensions; the relay accepts only extension-free mints (L6). Candidates in order of risk: metadata pointer and similar inert extensions first; transfer fee (changes the delta checks); transfer hook (executes foreign code); permanent delegate and confidential transfer are expected to stay refused | A per-extension threat analysis and tests with real Token-2022 binaries |
| More typed actions and adapters | The hard-enforcement surface is two actions. Candidates: native SOL transfer, stake delegation, lending deposit and withdraw, further pinned pools. Each needs a typed instruction that derives its own `verify` arguments and checks balance deltas | One design and red-team pass per action; the pin model per target program |
| Jupiter limit and DCA orders | Swap routes from Jupiter cannot be pinned because route accounts change per quote. Limit and DCA orders have fixed shapes and may be pinnable | A study of Jupiter's order programs; verifying their account layouts |
| Coexistence with the Solana Foundation's Subscriptions & Allowances | An SPL token account has one delegate, so the relay and Subscriptions cannot share a token account ([COMPARISON.md](COMPARISON.md)). Options: documented separate accounts, or an adapter | Reading Subscriptions' current interface; a design decision |
| A Squads-compatible profile | Squads users could keep assets in a smart account and use `verify` as a hook target | Squads' hook interface being usable by third parties (unconfirmed) |

## 4. A standard, not just a program

| Item | Why | Depends on |
|---|---|---|
| Write the interface as a SIMD or SRFC proposal ("delegated-signer authorization check") | The value of a check is that many programs call it. A public interface lets other mandate implementations be compatible | Stable ABI, at least two independent integrators, an external review. Note that an earlier SIMD in an adjacent area (SIMD-0520, identity registry) was closed unmerged on 2026-05-04, so the process has to be approached with care |
| An integrator guide with audited-pattern examples | The most common failure is an integrator that trusts caller-reported values or takes the program id from the transaction (CPI-2, CPI-3) | The integrator crate staying stable; feedback from real integrators |
| A conformance test kit for implementers | Lets other programs claim compatibility honestly | The interface proposal |

## 5. Integrations

| Item | Why | Depends on |
|---|---|---|
| Agent frameworks and wallets (for example Solana Agent Kit, Vercel AI SDK, an MCP wrapper for wallets) | The guard package covers a Kit signer, the Vercel AI SDK approval hook and an x402 client hook, none of them enforcement. A wallet-level adapter would put the check where the key is used | Verified APIs of each framework; each adapter stays labelled cooperative unless it routes through the relay |
| x402 and pay.sh flows | Payments are the main agent use case; the relay `transfer` is the enforceable path | The token-transfer shape of the payment protocol; a facilitator that accepts relay-built transactions |
| Dashboard hardening | The dashboard builds plans that an owner signs; the preview must match the transaction exactly | Wallet integration review; a threat model for the web app, which [SECURITY.md](SECURITY.md) covers only briefly |
| Registry growth | The registry lists known programs, instructions and presets; more verified entries make mandates easier to write correctly | A process for verifying a program's instruction discriminators |

## Not planned

- Anything that makes `verify`-only enforcement look like hard enforcement.
- Custody of owner assets by the relay or the core.
- Prompt-injection detection. The project caps the blast radius on chain; it does not classify prompts.
- MEV protection. The price floor is a static guard.
