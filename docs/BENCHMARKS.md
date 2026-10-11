# Benchmarks and test evidence

Every number in this file comes from a command or a file named next to it. Compute-unit (CU), transaction-size and rent figures are **LiteSVM measurements on one local machine** (macOS, Solana CLI 3.1.8, platform-tools v1.52). They are not mainnet measurements, they are not a performance guarantee, and the swap rows use a mock AMM, which is cheaper than the real Raydium CPMM (the real-Raydium swap is unmeasured). AgentAuth is an unaudited devnet prototype; passing tests say the suites pass, not that the code is free of bugs.

Date of the runs: 2026-10-11. Sources:

* Gate data written by the metrics gates: [data/core-metrics.json](data/core-metrics.json), [data/relay-metrics.json](data/relay-metrics.json). Both files are present.
* Re-runs made while writing this document (marked "re-run" below): `cargo test --workspace --no-fail-fast`, `cargo test --test regression_cu`, `cargo test -p agent-auth-relay --test fe`, `pnpm -r test`, `shasum -a 256` on `target/deploy`.
* Mutation, red-team and fuzz working files: [`security/`](../security) (mutation catalogues and per-mutant results, red-team suites).

Where a gate file and a re-run disagree, both are shown and the difference is explained or flagged.

## 1. Compute units

All CU figures are what LiteSVM reports for the transaction or instruction. Reproduce with:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
scripts/build-all.sh && source scripts/env.sh
cargo test --test regression_cu -- --nocapture --test-threads=1              # core table
cargo test -p agent-auth-relay --test fe -- --nocapture --test-threads=1     # relay MEASURE lines
```

### 1.1 Core program (`agent_auth`)

Source: `tests/regression_cu.rs::compute_units_per_instruction`. The "ceiling" column is the regression gate in that test (the test fails above it).

| Instruction | Best CU | Worst CU | Ceiling | Case |
|---|---|---|---|---|
| `verify` | 480 | 738 | 1200 | permission in slot 1 / slot 16, 8th discriminator, limits set, books the spend |
| `verify` (failing) | 496 | 496 | 1200 | unknown program, scans all 16 slots |
| `create_mandate` | 3433 | 10933 | 25000 | fresh PDA, 60 random agents (the spread is `find_program_address` bump search) |
| `create_mandate` (pre-funded PDA) | 4618 | 4618 | 25000 | someone sent lamports to the PDA first |
| `add_permission` | 243 | 420 | 1200 | 1st slot / 16th slot, 8 discriminators |
| `update_permission` | 204 | 339 | 1000 | slot 1 / slot 16 |
| `remove_permission` | 228 | 338 | 1000 | last of 16 / first of 15 |
| `set_active` | 124 | 126 | 600 | pause / resume |
| `revoke_mandate` | 1802 | 1802 | 3000 | 12 random agents |
| `revoke_mandate` (legacy v0 mandate) | 3322 | 3322 | 20000 | account from the pre-hardening binary, bump search |

Difference to flag: `data/core-metrics.json` records the pre-funded `create_mandate` row as 6118 CU; the re-run on the final tree printed 4618 CU. All other rows are identical between the gate file and the re-run. The table above uses the re-run. The old README's "estimated 1,500 to 2,500 CU" for `verify` was an estimate and was wrong; the measured range is 480 to 738 CU.

### 1.2 Relay (`agent_auth_relay`)

Source: `programs/relay/tests/fe.rs` (`fe02_*`), re-run, identical to `data/relay-metrics.json`. Totals are for the whole transaction: relay, the `verify` CPI into the core, the Token CPI, and for swaps the mock AMM.

| Scenario | classic spl-token | p-token | Token-2022 |
|---|---|---|---|
| `transfer` (hard-enforced `TransferChecked`) | 10,649 | 4,508 | 6,160 |
| `swap` (pinned pool, mock AMM) | 24,881 | 12,162 | 15,445 |
| `transfer` + `swap` in one transaction | 35,530 | 16,670 | 21,605 |
| unwind (2 Token `Revoke` + `revoke_mandate` + `close_policy`) | 7,718 | 2,582 | not measured |
| `init_policy` (swap enabled) | 8,476 to 15,976 (12 runs, median about 11,476); one re-run printed 14,476 | 8,476 to 14,476 (median about 9,976); re-run printed 8,476 | 8,492 to 15,992 (median about 11,492); re-run printed 8,492 |

Notes (all from `relay-metrics.json`, `compute_units.notes`, and the re-run):

* The relay's own cost for a `transfer`, excluding the `verify` and Token CPIs, is 3,912 CU (classic and p-token) and 3,917 CU (Token-2022). The difference between the columns is the Token program, not the relay.
* `set_paused`: 459 CU. `close_policy`: 564 CU (both identical on all three Token programs).
* `STRICT_TOP_LEVEL` adds 115 CU to a `transfer` (p-token).
* `init_policy` varies because it calls `find_program_address` twice on chain (about 1,500 CU per extra bump candidate). The range is what 12 runs produced, not a bound.
* Stack depth: direct `transfer` reaches depth 2, direct `swap` depth 3. Wrapping the relay in other programs works for up to 3 wrappers (`transfer`) and 2 wrappers (`swap`); beyond that the runtime returns `CallDepth` (`fe03_how_deep_can_the_relay_be_wrapped`).
* CU gates in `fe.rs`: `transfer` at most 15,000 (classic) and 8,000 (p-token); both are met.

### 1.3 Integrator crate

`agent-auth-cpi` adds 162 CU over a bare `verify` CPI. Command: `cargo test -p agent-auth-cpi --test e2e cu_overhead -- --nocapture`. This figure was produced by the earlier README run on 2026-10-11 and was not re-run for this document.

## 2. Transaction size, rent, program size

### 2.1 Transaction size

Legacy transactions as serialised by the LiteSVM harness, signatures included, limit 1,232 bytes (`fe.rs::fe01_*`, re-run, identical to the gate file).

| Transaction | Bytes | Notes |
|---|---|---|
| `transfer` | 476 | 516 with `SetComputeUnitLimit` |
| `swap` (mock AMM) | 757 | 797 with `SetComputeUnitLimit` |
| `init_policy` | 1,072 | the largest; 160 bytes under the limit |
| onboarding tx 1 (fee payer, `create_mandate`, 2 permissions, 2 `Approve`) | 579 | 595 with 3 permissions and 1 `Approve` |
| unwind, 2 Token `Revoke` + `revoke_mandate` + `close_policy` | 415 | 377 with a single `Revoke` (the CLI's `mandate revoke`) |

Because `per_tx_limit` applies per `verify` call, not per Solana transaction, 21 relay transfers fit in one 1,232-byte transaction (`rt_f1` test). The lifetime limit and the SPL `delegated_amount` still bound the total; see [SECURITY.md](SECURITY.md) finding RT-F1.

### 2.2 Rent

Source: `programs/relay/tests/fe.rs::fe_rent_figures_come_from_the_runtime` (LiteSVM `minimum_balance_for_rent_exemption`; asserts `(128 + len) * 3480 * 2`).

| Account | Bytes | Lamports | SOL |
|---|---|---|---|
| core mandate | 2,136 | 15,757,440 | 0.01575744 |
| relay policy | 944 | 7,461,120 | 0.00746112 |
| SPL token account (for comparison) | 165 | 2,039,280 | 0.00203928 |
| Token-2022 mint base (for comparison) | 82 | 1,461,600 | 0.0014616 |

Onboarding rent for one agent (mandate plus policy) is 23,218,560 lamports, about 0.0232 SOL, returned to the owner by `revoke_mandate` and `close_policy` in the unwind. These are the **local** figures (LiteSVM and `solana-test-validator` use the older default of 6,960 lamports per byte).

**Live clusters differ.** `solana rent <bytes> --url <devnet or mainnet-beta>`, read on 2026-10-11 (both clusters returned the same values):

| Account | Bytes | Lamports (live devnet and mainnet-beta) | SOL |
|---|---|---|---|
| core mandate | 2,136 | 11,501,120 | 0.01150112 |
| relay policy | 944 | 5,445,760 | 0.00544576 |
| SPL token account | 165 | 1,488,440 | 0.00148844 |

On the live clusters, onboarding rent for one agent (mandate plus policy) is therefore 16,946,880 lamports, about 0.0169 SOL, also returned by the unwind. Rent is a cluster parameter and can change; re-read it before quoting it.

### 2.3 Built program sizes and hashes

Command: `scripts/build-all.sh` (prints sha256, bytes, path); re-checked with `shasum -a 256 target/deploy/*.so`. The sizes match `data/*-metrics.json`, and the hashes match the table in [AUDIT-PREP.md](AUDIT-PREP.md). The core baseline imported before the hackathon window was 29,608 bytes (`core-metrics.json`).

| Program | Bytes | sha256 |
|---|---|---|
| `agent_auth.so` | 36,472 | `1e459e348907adf0c5b5d3606cfc00324de7628ca0cb6e550547413d6cfc09bc` |
| `agent_auth_relay.so` (default features, devnet allow-list) | 64,032 | `ed6b884c3e33dc8b71a32c2465543f5c76b770064907433ff07479a5c130ea4f` |
| `agent_auth_relay.so` (`test-amm`, localnet and tests only, never deploy) | 64,104 | `ba02f32c9b3d33a1df5a3fe074a3805087385ae1aa96190a53da26ba5b614ad7` |
| `mock_amm.so` (test and demo only) | 42,600 | `d71df55bf8f764ffd3b72b45faa497063cf0ba4ba1db3fed94ce2bdb40ebc139` |
| `gated_example.so` | 25,904 | `2086bceb3792bda2ef84c9751a4d9366d235dbb1db70567714c34ab71acb828b` |
| `evil_token.so` (test only) | 12,384 | `a2bfd0989af287eac1947cc70d0ca3896c4b7dd398a129f227f38155f1f9f28f` |

Test `fe05` asserts the relay is at most 65,536 bytes and contains no std formatting or panic strings; the default build leaves 1,504 bytes of headroom. The hashes depend on the toolchain and source state; a different build environment can produce different bytes.

## 3. Test counts

### 3.1 Rust

Command (re-run): `source scripts/env.sh; cargo test --workspace --no-fail-fast` (every `*_SO` variable set, `AGENT_AUTH_ALLOW_SKIP` unset, so a missing `.so` is a hard failure). Result: **778 passed, 0 failed, 10 ignored** across 47 result lines (test binaries, unit-test targets and doctests).

| Crate | Passed | Ignored | Suites |
|---|---|---|---|
| core (`agent_auth`, root crate) | 141 | 8 | `lib` 11, `error_matrix` 8, `full_lifecycle` 3, `fuzz_program` 3, `idl_conformance` 5, `layout` 1, `layout_v1` 3, `model_properties` 3, `mutation_survivors` 8, `poc_regressions` 19, `regression_cu` 4, `regression_lifecycle` 32, `regression_verify` 13, `source_hygiene` 5, `state_model` 2, `state_unit` 21 |
| relay (`agent_auth_relay`) | 529 | 2 | `lib` 40, `ar` 16, `common/main` 64, `conformance` 11, `dl` 40, `fe` 29, `inv` 8, `pl` 38, `re` 39, `rt` 22, `rt2` 14, `smoke` 10, `sw` 58, `t22` 12, `tr` 67, `uw` 16, `witness` 45 |
| `mock_amm` | 59 | 0 | 19 unit + 40 mode tests |
| `gated-example` | 21 | 0 | `gated` |
| `agent-auth-cpi` | 27 | 0 | 9 unit + 14 e2e + 4 doctests |
| `evil_token` | 1 | 0 | unit |

The 10 ignored tests: 6 in `tests/devnet.rs` (live network, not run), 2 golden-fixture writers (`layout.rs`, `layout_v1.rs`), 2 real-Raydium rows in the relay `sw.rs` (they need a mainnet fixture that is not in the repository). Counts for core and relay equal the gate files. Almost every Token-touching relay test runs once per Token program flavour (`::classic`, `::ptoken`, and for the CU, Token-2022 and `t22` suites `::token2022`), so the 529 are counted per flavour. The earlier README said 708 passed; that predates the witness tests (45) and later additions.

Non-vacuity check (gate files): running `regression_cu` with `AGENT_AUTH_SO=/nonexistent.so` panics with "program binary not found", and `tr_01` with `AGENT_AUTH_RELAY_SO=/nonexistent.so` fails in `require_so`. A missing binary cannot produce a silent pass.

### 3.2 TypeScript

Command (re-run): `pnpm -r test`, exit 0.

| Package | Passed | Skipped | Note |
|---|---|---|---|
| `@agentauth-sol/sdk` | 565 | 0 | vitest, 17 files |
| `@agentauth-sol/cli` | 48 | 0 | 3 files |
| `@agentauth-sol/mcp` | 88 | 46 | the skipped tests are localnet end-to-end tests that need a running validator |
| `@agentauth-sol/guard` | 46 | 1 | |
| `@agentauth-sol/registry` | 271 | 1 | `node --test`, 272 tests |
| `apps/dashboard` | 73 | 0 | 12 files |
| `apps/demo` | 35 | 0 | unit tests; the `scenario` and `attacks` runners are separate, see below |

### 3.3 Scripted demo runners

These need a local validator (see the README quickstart) and were not re-run for this document. Figures are from [DEMO.md](DEMO.md) and the README run of 2026-10-11: `scenario` passed with 34 transactions (about 33 s with `--fast`); `attacks` runs 54 scripted attacks (about 3 minutes). The attacker is a script.

### 3.4 Property and fuzz tests that run in the normal suite

Sizes are the defaults in the source; `AGENT_AUTH_PROP_CASES` overrides them (`tests/common/integration.rs::prop_cases`).

| Test | Default size | Source |
|---|---|---|
| `random_and_mutated_instructions_never_crash_the_program` | 6 seeds x 400 transactions | `tests/fuzz_program.rs` |
| `a_stranger_with_every_account_cannot_change_anything` | 800 random attempts | `tests/fuzz_program.rs` |
| `every_tag_survives_every_payload_length` | every tag at every payload length | `tests/fuzz_program.rs` |
| state model tests | 300 and 200 seeds | `tests/state_model.rs` |
| model property tests | 40 and 4 seeds | `tests/model_properties.rs` |

## 4. Mutation testing

Method (both programs): hand-written source mutants (guard deletions, comparison flips, error-code swaps, dropped state writes, off-by-one and 31-of-32-byte key compares, constant changes), applied one at a time to a scratch copy, rebuilt with `cargo build-sbf`, and run against the full test suite with `AGENT_AUTH_ALLOW_SKIP` unset. A mutant is "killed" if any test fails. "Equivalent" mutants have a written argument that no input distinguishes them; those proofs are the author's own reading and were not machine-checked. A mutation score measures the tests against the mutants that were written, not against every possible bug. `cargo-mutants` was not used.

Catalogues, runners and per-mutant results are in `security/mutation-core/` and `security/mutation-relay/` (`results.csv`, `run.py`, `EQUIVALENT.md`).

### 4.1 Core (`src/`)

Source: `data/core-metrics.json`; `security/mutation-core/results.csv` has 206 rows (203 killed, 3 equivalent).

| Round | Mutants | Killed | Equivalent | Survived | Score excluding equivalent |
|---|---|---|---|---|---|
| 1 | 144 | 138 | 3 | 3 (`C20`, `V10`, `W31`) | 138/141 = 97.9% |
| 2 | 68 (62 new, 6 re-runs of round 1) | 64 | 3 | 1 (`N-S31`) | 64/65 = 98.5% |
| unique | 206 | 203 | 3 | 0 after the tests below | |

The four real gaps and the tests that closed them:

* `C20`: `create_mandate` on an already pre-funded PDA still sent a transfer when nothing was missing. Killed by `tests/mutation_survivors.rs::funded_husk_create_needs_no_system_program`.
* `V10`: `revoke` with an invalid stored bump returned the wrong error. Killed by `revoke_with_an_on_curve_stored_bump_is_invalid_account_type`.
* `W31`: `verify` checked writability before ownership (error order). Killed by `tests/error_matrix.rs::every_instruction_times_every_failure_has_its_documented_code`.
* `N-S31`: `swap_remove` zeroed the vacated tail slot one byte short. Killed by a test in `tests/state_unit.rs`.

Equivalent: `S18` (`swap_remove_permission` self-copy no-op), `V06` and `V08` (explicit zeroing before `close()`, which already zeroes; this relies on pinocchio 0.9.3 `close()` semantics). Limit: the new tests were each verified to fail on their own mutant and pass on the real source in a private clone, but **the full mutant sweep was not re-run after the last tests were added**. An earlier 99-mutant campaign on the pre-fix binary is in `results-legacy99.csv` (98 killed, 1 equivalent).

### 4.2 Relay (`programs/relay/src`)

Source: `data/relay-metrics.json` and `security/mutation-relay/results.csv` (257 rows: 247 first-order mutants and 10 second-order redundancy groups).

| Stage | Result |
|---|---|
| Round 1 against the pre-existing suite | 211 killed, 6 equivalent (`C02`, `N22`, `X03`, `V16`, `V17`, `L05`), 40 survived: 211/251 = **84.1%** |
| After adding `programs/relay/tests/witness.rs` (45 tests, witness tests `w01` to `w21`) | all 40 survivors killed, each witness test run individually against its mutant: 251/251 non-equivalent = **100%** (`data/relay-metrics.json`, `results.csv`) |

The nine mutants that survived the first witness batch (`G09`, `N10`, `N12`, `N13`, `S12`, `S41`, `S42`, `T07`, `T11`) were killed by the later witness tests `w15` to `w21` (per-mutant evidence in `results.csv`). Each of them is a check that another layer also enforces (the Token program pinned by the policy, owner program re-checked by `token_acct_ok`, the output Token program differing only when input and output use different Token programs, `agent != owner` already refused by `create_mandate`, system-owned and empty-data checks on the policy account also failing in `create_account`). Redundant defence is why they were hard to kill from outside; a reviewer may prefer to remove a redundant check rather than test it.

**Limit:** each kill was verified by running the witness test binary against that one mutant; **the full 257-mutant sweep was not re-run after the witness tests were added** (a full sweep takes hours). The swept relay source is the current source (it includes the red-team fixes RT-F3 and RT-F4). Mutation score describes how sensitive the tests are to these hand-written mutants, not the absence of bugs.

Round 1 survivors by area (before the witness tests): shared checks 8, init_policy 3, `set_paused` 3, second-order groups 7, `close_policy` 1, among others (full table in the round 1 report). Error-code, event, allow-list, dispatch and floor-math mutants were all killed.

Relay red-team mutant set: 15 hand-written mutants (`results-redteam15.csv`), 14 killed and 1 judged equivalent (`MU1`); see [SECURITY.md](SECURITY.md) section 8.2.

## 5. Red team and fuzzing

An attacker-minded relay suite was written independently of the relay's own tests and run against the compiled `.so` files in LiteSVM, over classic spl-token, p-token and Token-2022. Files: `security/redteam-relay/` (`redteam_attacks.rs`, `redteam_attacks2.rs`, `redteam_fuzz.rs`, `redteam_util/`). Every assertion states the safe outcome; a failing assertion is a finding. The fuzzers check a ledger: no lamport or token balance outside the policy may change.

**Fuzz size.** The release-mode run is `RT_ITERS=100000` per section (log `output-fuzz-release-100000.log` in the build working directory): 14 sections (five fuzz families FZ-01 to FZ-05 across the three Token flavours, with FZ-05 run on two flavours), 100,000 iterations each, so **1,400,000 fuzzed transactions in that run**. A summed histogram of the log gives 1,400,002; the two extra counts are in the `internal-corruption-abnormal` bucket below. This is the "about 1.4 million" quoted in [SECURITY.md](SECURITY.md) section 9. Default sizes when `RT_ITERS` is unset are 1,500 to 4,000 per section (`redteam_fuzz.rs`). The suite lives in `security/`, outside the normal `cargo test` path, so these 1.4 million are **not** reproduced by `cargo test --workspace`; committing the harness into the test tree is an open item.

**Findings** (from [SECURITY.md](SECURITY.md) section 9):

| Id | Severity | What | State |
|---|---|---|---|
| RT-F1 | low | `per_tx_limit` is per `verify` call: 21 relay transfers fit in one transaction | accepted, documented, pinned by a test; lifetime limit and SPL allowance still bound the loss |
| RT-F2 | low | revoke then re-create with the same expiry re-binds an unclosed policy | accepted, documented; a fix needs a generation id the locked core layout does not have; the unwind closes the policy |
| RT-F3 | medium | Token-2022 native mint was not refused at `init_policy` like the classic native mint | fixed in commit `5ad0992` |
| RT-F4 | low | `set_paused` / `close_policy` with a read-only mutated account failed with a runtime error instead of a relay code | fixed in `5ad0992` (relay error 102) |
| RT-F5 | none | the relay's CPI account lists must be exactly the pinned ones | held; pinned by a test |
| RT-F6 | info | a test gap | listed in the `5ad0992` commit message; not otherwise recorded |
| RT-F7 | info | one abnormal termination in the deep run: the fuzzer overwrote the relay's own stored `authority_bump` | triaged, no program change; all 255 wrong bump values reverted atomically; pinned by 14 tests in `rt2.rs` |

Severity labels here are this document's reading of the SECURITY.md descriptions, not a scored rating. The statement that stands is: no non-Custom failure was reachable through instruction inputs in the tested runs, and no path moved owner funds outside the policy in the recorded runs. That is a statement about tested inputs, not an audit.

## 6. What these numbers do not show

* No mainnet or validator-cluster measurement; LiteSVM only, one machine.
* No real-Raydium swap CU; the swap rows use the mock AMM.
* No external audit. Mutation and fuzz results are evidence about test sensitivity and tested inputs.
* The mutation sweeps were not re-run end to end after the last tests were added (core and relay).
* The mutation, red-team and fuzz harnesses are in `security/`, which was untracked at the time of writing; the claim is reproducible only if that directory is committed.
