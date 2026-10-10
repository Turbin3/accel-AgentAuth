# Security policy

AgentAuth is an **unaudited devnet prototype**. It has not been reviewed by a third party and it is not
ready to protect real funds. We still want to hear about vulnerabilities, wrong claims and unsafe
documentation. The technical security material (threat model, internal review, known limitations) is in
[docs/SECURITY.md](docs/SECURITY.md). This file is only the reporting policy.

## How to report

Use **GitHub private vulnerability reporting** on this repository: open the repository's **Security**
tab, choose **Report a vulnerability**, and describe the issue. This creates a private advisory visible
only to you and the maintainers. Please do not open a public issue or pull request that contains exploit
details.

If the "Report a vulnerability" button is not available, the maintainers have not enabled the feature
yet. In that case open a public issue that says only that you have a security report and asks for a
private channel. Do not put technical details in it. We do not publish a security e-mail address.

A useful report contains: the affected component and commit; what an attacker needs (keys, accounts,
privileges); a minimal reproduction, ideally a failing test against the real `.so` in LiteSVM (see
`programs/relay/tests/rt.rs` and `tests/poc_regressions.rs` for the style); and the impact you
believe it has.

## Scope

In scope:

- The core program (`src/`), the relay (`programs/relay`) and the integrator crate
  (`crates/agent-auth-cpi`): anything that lets someone other than the owner change a mandate or policy,
  spend beyond the mandate or the SPL allowance, move tokens to a destination outside the policy, bypass
  the relay's checks, brick an owner's accounts, or make the program panic or behave
  inconsistently with its documented error codes.
- The TypeScript packages and apps (`packages/*`, `apps/*`): anything that makes a signed transaction
  differ from what the user was shown, leaks a key, or lets an agent process obtain owner powers.
- Documentation that overstates what the system enforces. These are bugs for us; label them
  "documentation" and report them in the same way or as a normal issue if they contain no exploit.

Out of scope:

- Test and demo components that must never be deployed: `programs/mock-amm`, `programs/evil-token`,
  the `test-amm` build of the relay, the scripted attack demo.
- The documented limitations in [docs/SECURITY.md](docs/SECURITY.md), section 10 (for example: `verify`
  alone is advisory, `per_tx_limit` is per `verify` call, no MEV protection, one SPL delegate per token
  account). A report that shows a limitation is *worse* than documented is welcome.
- The devnet deployment's single-wallet upgrade authority (known, listed as residual trust).
- Vulnerabilities in the Solana runtime, the SPL Token programs, Raydium, or other third-party software;
  report those to their maintainers. Tell us if they change our assumptions.
- Findings that need a stolen owner key, a compromised developer machine, or a malicious dependency
  we did not introduce.
- Denial of service by sending transactions to public devnet accounts, spam, or social engineering.

## What to expect

This is a small project. We will try to acknowledge a report, tell you whether we consider it in scope,
fix confirmed issues with a regression test, and credit you if you wish. We give no guaranteed response
time, and there is **no bug bounty** at present.

Please give us reasonable time to fix a problem before you disclose it publicly. If a report is
about a deployed program, we will tell you what we did before the details become public. We will not
take action against good-faith research that stays within this policy: it does not touch other
people's funds or accounts, it uses your own keys, and it runs against local validators, LiteSVM or
devnet.

## Supported versions

| Version | Supported |
|---|---|
| `main` (current prototype, v0.1) | Yes: fixes land here |
| Anything else, including the baseline lineage that is deployed on devnet and any fork | No |

There are no releases and nothing is published to crates.io or npm. When a release exists, this table
will list which versions get fixes.

## Disclosure of fixed issues

Fixed findings are recorded in [docs/SECURITY.md](docs/SECURITY.md) with the test that guards them.
