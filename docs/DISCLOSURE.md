# Pre-existing and in-window work

**Status: DRAFT for the founder to review and correct.** This is a factual statement of what existed
before the Crypto World's Fair window and what was built during it, derived from the repository's git
history and from public chain data. It is meant for the founder's eligibility disclosure and for
anyone who needs to know what in this repository is new. It is **not** text for a submission form.
Lines marked "founder to confirm" need the founder's knowledge; they cannot be established from the
repository alone.

## 1. Pre-existing work (the baseline)

The first commit of this repository, `7677fef` ("import pre-hackathon baseline snapshot", authored
2026-10-10), imports a snapshot of the team's earlier capstone project. Its commit message states that
no code was authored in that commit and that everything in it predates the window of 2026-09-14 to
2026-10-13.

What the baseline contained (29 files):

| Item | Detail |
|---|---|
| Core on-chain program `agent_auth` | A Pinocchio program, 973 lines in `src/` (10 files), 5 instructions: `create_mandate`, `add_permission`, `remove_permission`, `verify`, `revoke_mandate` |
| Test suite | 41 passing tests plus 7 ignored (6 devnet, 1 golden writer), about 2,100 lines in `tests/` |
| Golden layout fixture | `fixtures/golden_mandate.bin` (the 2136-byte mandate layout) |
| README and images | `README.md`, `assets/overview.png`, `assets/devnet-tests.png` |
| Design document | `overview/AgentAuthorizationProtocol_Overview.docx` (v0.1) |

Evidence for the dates, from sources other than the commit message:

- **Devnet deployment.** The core program `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` was last
  deployed in slot 471094128, which `solana block-time 471094128 --url devnet` reports as
  **2026-06-22T03:04:23Z**. The deployed binary is the baseline lineage (29,593 non-zero bytes), not the
  hardened build in this repository. (Read-only commands run 2026-10-11.)
- **Design document.** The `.docx` core properties record `created` and `modified` of
  **2026-06-04T19:05:04Z**.
- **File dates.** The baseline import commit message says the files are dated 2026-06-22; the `.docx`
  file in the working tree has a modification time of 2026-06-22.

Founder to confirm: the original private history of the capstone (earlier commits, repository, or
course submission) that these files were imported from, who authored the baseline, and whether any of
it was submitted for a prior event or grant. The git history of this repository does not contain it.
The git author of all 25 commits is the same account.

## 2. In-window work

Everything after `7677fef` is in-window work. At commit `e38124d` there are 24 commits after the
baseline, from 2026-10-10 15:19 to 2026-10-11 (IST). Output of
`git diff --numstat 7677fef..e38124d`, summed by area. Lines are raw added and deleted lines, and
include generated and data files (lockfiles, IDL JSON, fixtures), so they overstate hand-written
code. Binary files (screenshots) count as files with zero lines.

| Area | Files | Lines added | Lines deleted |
|---|---:|---:|---:|
| Core program (`src/`), modified in place | 12 | 722 | 423 |
| Core tests (`tests/`), legacy suite replaced | 24 | 6,260 | 1,658 |
| Core fixtures | 1 | 0 | 0 |
| Relay program (`programs/relay`: src, Cargo, config) | 17 | 3,615 | 0 |
| Relay tests (`programs/relay/tests`) | 47 | 14,586 | 0 |
| `programs/mock-amm` (test AMM) | 13 | 2,757 | 0 |
| `programs/gated-example` | 5 | 1,190 | 0 |
| `programs/evil-token` (test stub) | 2 | 258 | 0 |
| `crates/agent-auth-cpi` | 13 | 1,859 | 0 |
| `idl/` (interface descriptions) | 2 | 2,046 | 0 |
| `packages/registry` | 28 | 6,118 | 0 |
| `packages/sdk` | 66 | 22,161 | 0 |
| `packages/cli` | 36 | 6,475 | 0 |
| `packages/mcp` | 48 | 7,031 | 0 |
| `packages/guard` | 26 | 2,253 | 0 |
| `apps/dashboard` | 96 | 9,385 | 0 |
| `apps/demo` | 34 | 6,270 | 0 |
| `docs/` (committed so far) | 19 | 1,705 | 0 |
| `scripts/`, `skills/` | 12 | 638 | 0 |
| Lockfiles | 5 | 10,301 | 0 |
| Root configuration | 8 | 135 | 0 |
| **Total** | **514** | **105,765** | **2,081** |

Documentation written after `e38124d` (this directory, the README rewrite), `.github/workflows/ci.yml`,
`Makefile`, `scripts/lint-all.sh` and `scripts/devnet-deploy.sh` were uncommitted when this page was
written and are not in the table.

### What is new

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

The core program was modified in place, not rewritten. In commit `8879732` ("harden the AgentAuth
program") and `84f1c09` (tests):

- **Preserved:** the `verify` ABI (tag 3, 49 bytes), the 2136-byte account layout and error codes 1 to 18.
- **Fixed:** pre-funded-PDA griefing in `create_mandate`; `revoke_mandate` is now a real close; one error
  contract for owner-signed instructions; exact instruction-data lengths; expiry boundary; counter
  overflow behaviour (details and tests in [SECURITY.md](SECURITY.md)).
- **Added:** instructions `set_active` (tag 5) and `update_permission` (tag 6); error codes 19 to 22.
- **Tests:** the 41 legacy tests were replaced or rewritten (the commit message says legacy tests were
  updated "only where the contract intentionally changed" for the hardening commit, and the next commit
  replaces the tautological ones). The current core suite runs 132 tests
  (`cargo test` result lines, 2026-10-11).
- **Not touched:** the overview `.docx`. It still describes the baseline and has drifted from the code
  (see SPEC-15 in [SECURITY.md](SECURITY.md)).

The hardened core has **not** been deployed. Devnet runs the baseline lineage.

### What exists only as a design or interim artifact

The relay specification, the test matrix, the review reports and the competitor research were produced
during the window as working documents outside the repository. They are summarized in the repository docs;
the raw files are not in the repository.

## 3. How the in-window code was produced

The in-window code, tests and documentation were developed with AI coding assistance (Claude) under the
team's direction. The commit trailers say so: the commits carry a `Co-Authored-By: Claude Sonnet 5.5`
line. The security review lenses, the mutation experiments and the red team were also run with AI
assistance, which is why [SECURITY.md](SECURITY.md) calls the review a structured self-review and not an
independent audit.

**Founder to confirm wording.** In particular: how the team wants to describe the division of work
between the human team and the assistant (direction, review, acceptance of each change); whether the
event's rules require a specific AI-use disclosure; and who the contributors are. The repository history
shows a single git author account for all commits and does not identify the team.

One further point to be aware of: the baseline import commit `7677fef` carries the same
`Co-Authored-By` trailer as the others, although its message says no code was authored in it. If that
trailer should not be on a snapshot import, that is a history-rewrite question for the founder; this
document does not alter history.

## 4. Third-party code and data

- Dependencies are declared in `Cargo.toml` / `Cargo.lock` and `package.json` / `pnpm-lock.yaml`.
  Licenses were not audited for this page.
- The mock AMM is described in its README as shaped like Raydium CP-Swap (account order and instruction
  ABI) for testing. Founder to confirm that no Raydium source code was copied into it. A devnet pool
  snapshot used as a test fixture is in `programs/relay/tests/raydium_fixture/devnet_pool.json`, fetched
  by `fetch_fixture.py` from public chain data. The relay's real-Raydium test (`SW-15`) is ignored
  unless a dumped devnet binary is supplied.
- Program and token addresses in `packages/registry` come from public chain data and documentation.
- The repository is licensed MIT (`LICENSE`).

## 5. Reproducing the numbers on this page

```sh
git log --oneline 7677fef..HEAD | wc -l
git diff --numstat 7677fef..e38124d      # per-file added/deleted lines; sum by directory
solana block-time 471094128 --url devnet # baseline deployment time
solana program show AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if --url devnet
unzip -p overview/AgentAuthorizationProtocol_Overview.docx docProps/core.xml
```
