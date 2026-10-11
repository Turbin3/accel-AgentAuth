# Pre-existing and in-window work

**Status: derived from the repository's git history and from public chain data.** This is a factual
statement of what existed before the Crypto World's Fair window and what was built during it, for anyone who
needs to know what in this repository is new. It is **not** text for a submission form.

## 1. Pre-existing work (the baseline)

The baseline is the team's earlier capstone repository, public at
<https://github.com/Turbin3/accel-AgentAuth> (default branch `main`, head `ae67543`, "devnet: use
jupiter's real route discriminator", 2026-06-22). This history is that history plus the
in-window commits on top of it: `ae67543` is the last pre-window commit, and `git log ae67543..HEAD` lists
everything done in the window (2026-09-14 to 2026-10-13).

The capstone repository has 42 commits, dated 2026-06-14 to 2026-06-22. GitHub's contributor list
(read 2026-10-12) shows five accounts: DivineUX23 (17 commits), AdemolaSam (9), xavierScript (8),
VictoryG0D (7) and V1C70RYG0D (1). Those commits are not in-window work and have several authors: 34 of
the 42 commits (81%) were authored by DivineUX23, AdemolaSam and xavierScript, and 8 (19%) by the accounts
VictoryG0D (git author name "Sumit Kumar", 7 commits) and V1C70RYG0D (git author name "VictoryGod", 1).
By `git blame` at `ae67543`, the 973 lines of `src/` are Sumit Kumar 50%, DivineUX23 24%, AdemolaSam 16%
and xavierScript 10%; the 2,098 lines of `tests/` are xavierScript 33%, DivineUX23 24%, AdemolaSam 24% and
Sumit Kumar 19%. The baseline's design document and README roadmap are also the capstone's work.

What the baseline contained (29 files):

| Item | Detail |
|---|---|
| Core on-chain program `agent_auth` | A Pinocchio program, 973 lines in `src/` (10 files), 5 instructions: `create_mandate`, `add_permission`, `remove_permission`, `verify`, `revoke_mandate` |
| Test suite | 41 passing tests plus 7 ignored (6 devnet, 1 golden writer), about 2,100 lines in `tests/` |
| Golden layout fixture | `fixtures/golden_mandate.bin` (the 2136-byte mandate layout) |
| README and images | `README.md`, `overview.png`, `devnet-tests.png` (the images are now in `docs/archive/pre-hackathon/`) |
| Design document | `AgentAuthorizationProtocol_Overview.docx` (v0.1; now `docs/archive/pre-hackathon/`, superseded) |

Evidence for the dates, from sources other than the commit message:

- **Devnet deployment.** The core program `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` was last
  deployed in slot 471094128, which `solana block-time 471094128 --url devnet` reports as
  **2026-06-22T03:04:23Z**. The deployed binary is the baseline lineage (29,593 bytes after trailing zero padding is removed; the baseline build is 29,608 bytes), not the
  hardened build in this repository. (Read-only commands run 2026-10-11.)
- **Design document.** The `.docx` core properties record `created` and `modified` of
  **2026-06-04T19:05:04Z**.
- **Commit dates.** `git log ae67543` runs from 2026-06-14 to 2026-06-22; the last pre-window commit is
  2026-06-22.

This document does not attribute baseline authorship beyond those commit counts. The baseline README
declares the license as MIT but the capstone repository had no `LICENSE` file; the first in-window commit
adds the MIT `LICENSE` file, matching the declared license. The git author of every in-window commit is
the same account (Sumit Kumar).

## 2. In-window work

Everything after `ae67543` is in-window work. At commit `11c4019` there are 41 commits after the
baseline, from 2026-10-10 (IST) to 2026-10-11 06:18 (IST). Output of
`git diff --numstat ae67543..11c4019`, summed by area. Lines are raw added and deleted lines, and
include generated and data files (lockfiles, IDL JSON, fixtures, mutation ledgers, transcripts), so
they overstate hand-written code. Binary files (screenshots, rendered diagrams, `.bin` and `.so` fixtures) count as files with zero lines. Commits
made after `11c4019` (documentation fixes from the clean-clone check) are not included.

| Area | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| Core program (`src/`), modified in place | 12 | 722 | 423 |
| Core tests (`tests/`), legacy suite replaced | 25 | 6,507 | 1,658 |
| Core fixtures | 1 | 0 | 0 |
| Relay program (`programs/relay`: src, Cargo, config) | 17 | 3,615 | 0 |
| Relay tests (`programs/relay/tests`) | 49 | 15,341 | 0 |
| `programs/mock-amm` (test AMM) | 13 | 2,757 | 0 |
| `programs/gated-example` | 5 | 1,190 | 0 |
| `programs/evil-token` (test stub) | 2 | 258 | 0 |
| `crates/agent-auth-cpi` | 13 | 1,859 | 0 |
| `idl/` (interface descriptions) | 2 | 2,046 | 0 |
| `packages/registry` | 28 | 6,135 | 0 |
| `packages/sdk` | 66 | 22,185 | 0 |
| `packages/cli` | 36 | 6,732 | 0 |
| `packages/mcp` | 49 | 7,225 | 0 |
| `packages/guard` | 26 | 2,253 | 0 |
| `apps/dashboard` | 97 | 9,629 | 0 |
| `apps/demo` | 34 | 6,322 | 0 |
| `docs/` (includes data, transcripts, diagrams, archive) | 60 | 5,099 | 0 |
| `security/` (red-team suites, mutation runners, catalogues, ledgers) | 23 | 9,783 | 0 |
| `scripts/`, `skills/` | 14 | 965 | 0 |
| `.github/` (CI workflow, templates) | 5 | 226 | 0 |
| Lockfiles | 5 | 10,301 | 0 |
| Root configuration and top-level documents (`README.md` rewritten: 220 added, 133 deleted) | 12 | 613 | 133 |
| **Total** | **594** | **121,763** | **2,214** |

The `docs/`, `security/` and `.github/` rows are text, data and CI configuration, not program code.
`git diff --numstat` is run with rename detection on (the default), so moved baseline files such as the
overview images appear under their new path.

### What is new

The baseline README roadmap listed a TypeScript SDK, a CLI and an MCP server as future phases, and the
baseline design document named an execute relay as a deferred second-version idea. No code for any of
them existed at `ae67543`; the implementations below are in-window work, built on those plans.

- **The relay** (`programs/relay`, Pinocchio): `init_policy`, `set_paused`, `close_policy`, `transfer`,
  `swap`; an owner-written 944-byte policy; error codes 100 to 119. Entirely in-window.
- **Test AMM and stubs** (`programs/mock-amm`, `programs/evil-token`) and the **second integrator**
  (`programs/gated-example`). Entirely in-window.
- **Integrator crate** (`crates/agent-auth-cpi`). Entirely in-window.
- **TypeScript SDK, CLI, MCP server, client-side guard, program registry**
  (`packages/*`), the **dashboard** and the **demo and attack-simulation harness** (`apps/*`).
  Entirely in-window.
- **Test infrastructure:** the replacement core suite (error matrix, model differential, fuzzing,
  regression tests), the relay test matrix, the red-team regressions, build and test scripts.
- **Security review work:** the seven-lens review, mutation experiments and relay red team described
  in [SECURITY.md](SECURITY.md).
- **Documentation and diagrams.**

### What changed in the pre-existing core program

The core program was modified in place, not rewritten. In commit `c9e390c` ("harden the AgentAuth
program") and `b46d184` (tests):

- **Preserved:** the `verify` ABI (tag 3, 49 bytes), the 2136-byte account layout and error codes 1 to 18.
- **Fixed:** pre-funded-PDA griefing in `create_mandate`; `revoke_mandate` is now a real close; one error
  contract for owner-signed instructions; exact instruction-data lengths; expiry boundary; counter
  overflow behaviour (details and tests in [SECURITY.md](SECURITY.md)).
- **Added:** instructions `set_active` (tag 5) and `update_permission` (tag 6); error codes 19 to 22.
- **Tests:** the 41 legacy tests were replaced or rewritten (the commit message says legacy tests were
  updated "only where the contract intentionally changed" for the hardening commit, and the next commit
  replaces the tests that did not exercise program code). The current core suite runs 141 tests, 8 ignored
  (`docs/data/core-metrics.json`, `cargo test` result lines, 2026-10-11).
- **Not touched:** the overview `.docx`. It still describes the baseline and has drifted from the code
  (see SPEC-15 in [SECURITY.md](SECURITY.md)).

The hardened core has **not** been deployed. Devnet runs the baseline lineage.

### What exists only as a design or interim artifact

The relay specification, the test matrix, the raw review reports and the competitor research were
produced during the window as working documents outside the repository. They are summarized in the
repository docs; the raw files are not in the repository. The red-team suites and the mutation
catalogues, runners and per-mutant ledgers are in the repository under `security/`; only the raw logs of
the long fuzz runs stay outside it (see `security/redteam-relay/results-summary.md`).

## 3. How the in-window code was produced

The in-window code, tests and documentation were developed with AI coding assistance (Claude Code) under
the direction of the submitting developer (git author Sumit Kumar). The security review lenses, the
mutation experiments and the red team were also run with AI assistance, which is why
[SECURITY.md](SECURITY.md) calls the review a structured self-review and not an independent audit.

The commits are authored by that single git account and carry no co-author trailer for the assistant, so
this section is the record of the AI assistance; the git history does not identify any other person.

## 4. Third-party code and data

- Dependencies are declared in `Cargo.toml` / `Cargo.lock` and `package.json` / `pnpm-lock.yaml`.
  Licenses were not audited for this page.
- The mock AMM is described in its README as shaped like Raydium CP-Swap (account order and instruction
  ABI) for testing. A search of its sources for licence headers or identical code found no Raydium source (2026-10-12). A devnet pool
  snapshot used as a test fixture is in `programs/relay/tests/raydium_fixture/devnet_pool.json`, fetched
  by `fetch_fixture.py` from public chain data. The relay's real-Raydium test (`SW-15`) is ignored
  unless a dumped devnet binary is supplied.
- Program and token addresses in `packages/registry` come from public chain data and documentation.
- The repository is licensed MIT (`LICENSE`).

## 5. Reproducing the numbers on this page

```sh
git rev-list --count ae67543..11c4019   # 41: the commits the table above counts (the branch head adds later commits)
git diff --numstat ae67543..11c4019      # per-file added/deleted lines; sum by directory
git shortlog -sn ae67543                 # commit counts of the baseline
git blame --line-porcelain ae67543 -- src/ tests/   # per-line authorship of the baseline (loop over the files)
solana block-time 471094128 --url devnet # baseline deployment time
solana program show AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if --url devnet
unzip -p docs/archive/pre-hackathon/AgentAuthorizationProtocol_Overview.docx docProps/core.xml
```
