# Comparison with other projects

This page places AgentAuth next to the systems a reader is most likely to compare it with. It is meant
to be fair: where another project does something better, it says so. Every statement about another
project has a source link. If a link is wrong or a statement is out of date, please open an issue.

**Scope and date of the evidence.** The comparison rests on a code-level audit done on 2026-10-10 and
2026-10-11: 36 hackathon repositories (31 read from source; Guardrail inferred from its published IDL
and deployed bytecode strings; 4 could not be audited because the repository was private, missing or
docs-only) and 19 incumbents and standards, including 4 EVM precedents. The audit read source statically;
it did not build or run these projects. "Unknown" means the code was not available, not "no". An
"absence" below means "not found in that set", not "does not exist". Deployment checks were existence
of an executable account on 2026-10-10, not a comparison of bytecode against source. Claims that
did not survive independent verification were dropped.

AgentAuth itself is an unaudited devnet prototype; see [SECURITY.md](SECURITY.md).

## What AgentAuth is, for comparison purposes

- **Core (the standard).** A non-custodial on-chain record (a *mandate*) per (owner, agent): an expiry,
  up to 16 target programs, up to 8 eight-byte discriminators per program, and a per-transaction and a
  lifetime spend limit per program. A `verify` instruction any program can call by CPI. `verify`
  trusts caller-reported values, so on its own it is **advisory**.
- **Relay (hard enforcement for two actions).** A separate program that is the in-repository reference integrator of
  `verify`. For SPL `TransferChecked` to allow-listed token accounts and for one pinned single-pool
  swap it derives the values itself and moves funds as the SPL delegate of the owner's own token account.
  Assets stay in the owner's accounts; the Token program's `delegated_amount` is the final cap.
- **Integrator crate and second integrator.** `crates/agent-auth-cpi` and `programs/gated-example`.

## Matrix

"Instruction-level" means the target instruction's tag or discriminator is matched against a configured
policy. "Composable hook" means another program can call a check. "Bypassable" asks whether the
delegated signer can act without passing the check.

| Project | Custody | Enforcement point | Instruction-level? | Composable hook? | Bypassable? | Maturity (as found) |
|---|---|---|---|---|---|---|
| **AgentAuth core** (this repo) | None: mandate is a record | On-chain, only if the target or agent calls `verify` | Yes: 8-byte discriminator allow-list per program (caller-reported) | Yes: CPI-callable `verify` | **Yes** (advisory) | Unaudited devnet prototype |
| **AgentAuth relay** (this repo) | None: assets stay in the owner's accounts; the relay's PDA is the SPL delegate | On-chain, relay derives and enforces: `transfer`, one pinned `swap` | Two typed actions only | Relay is an integrator, not a hook | No, for those two actions; bounded by `delegated_amount` | Unaudited, LiteSVM and local validator only |
| [Squads v4 SpendingLimit](https://github.com/Squads-Protocol/v4/blob/af94153ff77a28b6effe46b9c94baaa93742b48c/programs/squads_multisig_program/src/state/spending_limit.rs) | Vault PDA | On-chain (`spending_limit_use`) | No: mint, amount, period, members, destinations | No | No | Immutable since November 2024 ([source](https://docs.squads.so/main/basics/security)); ~157.9k multisigs, ~35.5k spending limits; 4 audit firms and formal verification (per the audit) |
| [Squads Smart Account Program, ProgramInteractionPolicy](https://github.com/Squads-Protocol/smart-account-program/blob/80bf1f7ad28fd1176c364879776982730b8e9c80/programs/squads_smart_account_program/src/state/policies/implementations/program_interaction.rs) | Smart-account vault PDA (assets move in) | On-chain, atomic with execution; pre/post hooks | **Yes**: program id, account and data constraints (byte-slice values documented "for discriminators"), deny-by-default once constraints are non-empty | Partial: hooks call a configured program; signers must go through Squads | No | Mainnet [`SMRTzf...`](https://explorer.solana.com/address/SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG), redeployed 2026-08-31; 23,437 policy accounts, 19,432 with at least one instruction constraint (own on-chain decode); no public audit of the policy module found |
| [Swig](https://github.com/anagrambuild/swig-wallet) | Wallet PDA (assets must move in) | On-chain execution engine (parses nested instructions, CPIs, checks balance deltas) | No discriminator action: program-level scopes plus `ProgramScope` (program, account, numeric byte range) | No | No | Mainnet; Accretion (2025) and Halborn (2026) audits; AGPL-3.0 |
| [Solana Subscriptions & Allowances](https://github.com/solana-foundation/subscriptions) | Non-custodial: SPL delegate is a per-(user, mint) authority PDA | On-chain: the program moves the tokens | No | No | No, for delegated pulls | Mainnet since 2026-06-02; 3 Cantina engagements, the latest has 1 High acknowledged and not fixed (per the audit); Solana Foundation |
| [Phantom MCP server](https://docs.phantom.com/phantom-mcp-server) | Phantom KMS (key storage and signing service) | Off-chain at Phantom (the KMS enforces policy before signing) | None documented | No third-party pre-sign hook | Yes (vendor-defined, off-chain) | Published package `@phantom/mcp-server` |
| [Privy policy engine](https://docs.privy.io/controls/policies/overview) | Vendor-operated key infrastructure | Off-chain, evaluated in the vendor's enclave (per the linked page) | Yes, off-chain: program id plus Anchor-IDL-decoded name, discriminator, args, accounts; default-deny | No | Yes (key usable only through the vendor) | Production |
| [Turnkey policy engine](https://docs.turnkey.com/features/policies/smart-contract-interfaces) | Vendor-operated signing infrastructure | Off-chain in the vendor's policy engine | Yes, off-chain: IDL upload gives the instruction name and parsed arguments to policy conditions | No | Yes | Production |
| [Coinbase CDP policy engine](https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/solana-idl-policies) | Coinbase-operated wallet infrastructure | Off-chain in the Coinbase policy engine | Yes, off-chain, for API-key wallets (`solData` IDL criterion). The Agentic Wallet CLI exposes per-call and per-session caps only | No | Yes | Production; Agentic Wallets launched 2026-02-11 |
| [MetaMask Delegation Framework](https://github.com/MetaMask/delegation-framework) (ERC-7710 / 7715, EVM) | Non-custodial smart account | On-chain manager performs the call | Yes: `AllowedTargets`, `AllowedMethods`, `AllowedCalldata` | No check-only method by design | No | 37 enforcers; ERC-7710/7715 still Draft |
| [Zodiac Roles](https://github.com/gnosisguild/zodiac-modifier-roles) (EVM) | Safe (non-custodial) | On-chain module performs the call | Yes: function-level scope and 19 condition operators | No | No | Used by ENS, Balancer, Gnosis; usage figures self-reported; a June 2026 ERC-1271 authentication bug was reported |
| [AgentTrust](https://github.com/agenttrust-labs/agenttrust) (hackathon) | User wallet | On-chain verify hook `gate_payment_strict` (return data or revert) | No on-chain; an off-chain x402 parser hard-codes SPL `transferChecked` | Yes: CPI-callable by any signer | Yes: gate and transfer are bound only by SDK composition; its own proof document shows a split-transaction case | 3 Anchor programs on devnet; 52 localnet tests; Kani proofs on pure logic (7 of 7) |
| [Fuin](https://github.com/Fuin-Labs/Fuin) v2 (hackathon) | v1 vault PDA; v2 non-custodial intents | v2: sibling-instruction verifier through the Instructions sysvar | Partial: hard-coded SPL Transfer (3), TransferChecked (12), one Jupiter route discriminator; everything else unsupported | Partial: same-transaction sibling, its SDK says it is not a CPI wrapper | Partial: the agent can omit the verify instruction | Anchor, devnet, SDKs, MCP server, relayer |
| [Guardrail](https://guardrail.shikhr.in/assets/index-DSIR2Cva.js) (hackathon, source private) | Policy PDA is the target's authority | On-chain CPI relay for one target program | Yes: custom discriminator whitelist of 8-byte discriminators (inferred from the published IDL and bytecode strings) | Partial: relay, not a verify hook | Partial | Devnet; Frontier-cohort project page |
| [SNSIP-Agent](https://github.com/hien-p/snsip-agent) (hackathon) | None | Off-chain SDK and MCP checker (advisory); its 4 Anchor programs are undeployed sketches with placeholder ids | Partial: models (target program, optional 8-byte discriminator) in JSON, checked in TypeScript on caller-supplied inputs | No | Yes | npm `snsip-mcp` 0.1.0; last commit 2026-05-11 |
| [Altheia](https://github.com/altheia-xyz/altheia-program) (hackathon) | Swig wallet (enforcement delegated) | Registry program; enforcement outsourced to Swig and a closed backend | No: program-level allowed programs mapped to Swig permissions | No | Partial (the SDK fails open by default, per the audit) | Anchor registry, devnet |
| [Kyvern Atlas](https://github.com/shariqazeem/kyvern-atlas) (hackathon) | Squads vault | On-chain CPI relay over Squads spending limits; per its own `CLAUDE.md` the main HTTP path calls Squads directly | No | No | Yes | Anchor plus Squads v4, devnet |

Other systems in the audit that the matrix leaves out for space and that are relevant: LazorKit
(Pinocchio smart wallet with a program-id whitelist, vault PDA), MagicBlock session keys (non-custodial,
only when the target program integrates), Crossmint agent wallets (Swig-based; documented Solana scope is
token transfers) and many vault-PDA relay projects. See the audit's full matrix for the rest.

## What each does better

**Squads.** Squads has the track record this project does not have: v4 has been immutable since
November 2024, is used by ~157.9k multisigs, and has been through multiple audits and formal verification.
Its Smart Account Program already ships instruction constraints richer than a discriminator list
(account and data constraints, deny-by-default), runs them atomically with execution with post-checks on
balance deltas, and is on mainnet with 19,432 policy accounts that have an instruction constraint. Squads
also provides multisig governance, which a single-owner mandate does not. The cost is that assets live in a
Squads smart account and the constraints bind only signers acting through it. AgentAuth is a record that
works over the owner's own accounts and is readable by any program, but its enforcement is narrower.

**Swig.** Swig is an audited, mainnet execution engine with roles, recurring slot-based limits and
destination limits, and a wide action vocabulary. It enforces by executing through the wallet, so it
cannot be skipped; AgentAuth's core can. The cost is again migration of assets into the Swig wallet.

**Solana Subscriptions & Allowances.** It is the Foundation's answer to expiry and recurring amounts on
top of SPL delegation, is on mainnet, and has had three audit engagements. It is non-custodial like the
relay, **and it uses the same underlying mechanism**: an SPL delegate. An SPL token account has exactly
one delegate, so the two cannot both be active on the same token account. A user must choose a token
account per scheme. Subscriptions has no program or instruction scope; the AgentAuth relay does, but only
for two typed actions.

**Phantom MCP, Privy, Turnkey, Coinbase.** These are production products with distribution, support and
simple developer experience. Privy, Turnkey and Coinbase evaluate policies, including program and
IDL-decoded instruction conditions with argument and account constraints, which are more expressive than a
discriminator list. The trade is that policy is evaluated off-chain in a vendor-operated service: it is not publicly
readable on-chain, cannot be checked by other programs, and the signing path depends on the vendor.
Rolling aggregations are documented only for Ethereum methods at Privy, and Coinbase's agentic-wallet CLI
exposes per-call and per-session caps only (per the audit). These are descriptions of what the documentation
says on the date read, not a verdict on the products.

**ERC-7710 / 7715, MetaMask Delegation Framework and Zodiac Roles (EVM lineage).** These are the closest
design precedents. The (target, method, calldata range, allowance, period, expiry) shape is public prior
art, and AgentAuth did not invent it. On EVM the manager performs the call, so enforcement is real by
construction; the equivalent on Solana is what the relay does for two actions. ERC-7710/7715 are still
Draft and define only redeem and request interfaces. Zodiac has the most credible institutional adoption
(ENS, Balancer, Gnosis) and condition operators far beyond this project. The EVM experience also carries a
warning: Coinbase removed its V0 permissioned-call implementation, tests and docs in a commit dated 2024-10-08 UTC
([commit](https://github.com/coinbase/smart-wallet-permissions/commit/012b76cb51aca5cabe97bee2768191bdf0b4bf31)).

**AgentTrust.** The closest in shape to the core: a non-custodial, CPI-callable verify hook. It offers
period limits (per-transaction, daily, weekly, velocity) that the AgentAuth core lacks, and it has Kani
proofs on its pure logic. Its amount is caller-reported and there is no on-chain discriminator gating, so it
shares the "voluntary check" weakness.

**Fuin.** Fuin v2 parses the real instruction amount from sibling instructions through the Instructions
sysvar, which is stronger than trusting a caller-reported amount, and has hierarchical delegation. It
supports a small fixed set of actions and is not a CPI-callable check.

**Guardrail.** It has an on-chain discriminator whitelist in a deployed devnet relay, so it is prior art
for "instruction-level on-chain" on Solana, built for a single target program and aimed at compromised
admin keys rather than delegated agents (per the audit). Its source is private, so the finding rests on the
published IDL and bytecode strings.

**SNSIP-Agent.** It published the (target program, optional 8-byte discriminator) data model in May 2026,
before the hackathon window, as an advisory checker. It is public prior art for the data model; its
specification credits the EVM project ENSign as the origin of the tuple.

**Altheia and Kyvern.** Both build on Squads or Swig. They show the pattern of putting a registry or relay
over an existing vault or wallet. Their enforcement is as strong as the underlying vault.

## Prior art we build on, in plain words

- The permission tuple (target, selector, allowance, period, expiry) comes from the EVM lineage
  (ERC-7710/7715, Zodiac Roles, ENSign) and from earlier Solana projects (SNSIP-Agent, Guardrail).
- Spend limits are not new: Squads, Swig, LazorKit, Subscriptions, Privy, Turnkey and Coinbase all ship them.
- The relay model (the program that moves funds enforces the policy) is the vault-PDA relay pattern that
  many hackathon projects use; the AgentAuth relay differs in leaving assets in the owner's account and
  using the SPL delegate as the cap.
- Pinocchio is not a differentiator: Swig, Subscriptions and LazorKit are also Pinocchio.

## What is different

1. The mandate is a **record that other programs can call**: a CPI-callable `verify` over a
   non-custodial, owner-configured (program, 8-byte discriminator) allow-list with per-permission
   per-transaction and lifetime caps. This is the combination, not any one feature.
2. The relay **leaves assets in the owner's accounts**. Its hard cap is the Token program's
   `delegated_amount`, not the relay's own code, and the mandate's counters are shared across integrators.

The depth of testing (see [SECURITY.md](SECURITY.md)) is a property of this repository, not a claim
of difference: other projects in the set also have tests, and AgentTrust has Kani proofs.

## The narrow claim AgentAuth can defend

> AgentAuth is a non-custodial, agent-keyed on-chain permission record with owner-configured (program,
> 8-byte discriminator) allow-lists, per-permission lifetime and per-transaction spend caps, and a
> CPI-callable `verify` that any program can invoke. Among the 36 Colosseum-hackathon repositories and 19
> incumbents and standards reviewed (as of 2026-10-11), we found none that combines all of these.

It must travel with these caveats:

- `verify` is advisory unless the target program or the relay enforces it. Hard enforcement exists for the
  relay's `transfer` and one pinned `swap`, and for integrators that gate their own instruction.
- The project is unaudited and devnet only.
- The claim is the combination; each component exists somewhere in the set.
- "We found none" is bounded by what was read. Four hackathon repositories could not be audited.
- Relay-path non-custody has a cost: one SPL delegate per token account, which conflicts with other
  delegate-based schemes such as Subscriptions, and Token-2022 extensions (permanent delegate, CPI Guard,
  transfer hooks) limit what mints can be used.

## Claims we do not make

- "First on-chain instruction-discriminator-level agent mandate on Solana." Squads'
  ProgramInteractionPolicy, Guardrail and Fuin v2 each contradict it, and "first" cannot be proven by a
  search of 55 items.
- "No on-chain, composable primitive scopes a delegated signer by program and discriminator." False as
  stated (Squads, Guardrail). The surviving statement is the narrow claim above.
- "Squads has no instruction-level agent gate." False. Only the v4 `SpendingLimit` has no program or
  instruction fields.
- "Privy, Turnkey and Coinbase are not composable with arbitrary Solana programs." False as stated: their
  policies cover arbitrary programs that have an IDL. What is true is that other on-chain programs cannot
  read or CPI-check those policies.
- "Spend limits are novel" or "Pinocchio is a differentiator."
- Anything about the traction, awards or user counts of other projects.
- That `verify`-based enforcement "cannot be bypassed."

## Sources

The detailed audit (per-repository teardowns, the on-chain decode of Squads policy accounts, and the
verifier's corrections) is a working document of the project's research phase. The links in the matrix are
the primary sources. Additional sources used in the prose: SPL Token delegate semantics
([state.rs](https://github.com/solana-program/token/blob/8185db13640f0df038266c7cf4306c212d81380a/interface/src/state.rs#L84-L108),
[docs](https://solana.com/docs/tokens/basics/approve-delegate)); Token-2022 extensions
([CPI Guard](https://solana.com/docs/tokens/extensions/cpi-guard),
[permanent delegate](https://solana.com/docs/tokens/extensions/permanent-delegate)); Subscriptions
announcement ([solana.com](https://solana.com/news/subscriptions-and-allowances)); ERC-7710
([text](https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7710.md)); Privy, Turnkey and
Coinbase documentation linked above.
