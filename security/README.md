# security/: reproducible security evidence

Everything here exists so that a reviewer can re-run, from a clean checkout, the evidence quoted in
[docs/SECURITY.md](../docs/SECURITY.md) sections 8 (mutation testing) and 9 (relay red team) and in
[docs/AUDIT-PREP.md](../docs/AUDIT-PREP.md). Nothing here deploys, publishes or signs anything, and no
runner touches your working tree: every one of them works in a scratch copy of the repository.

**Read this first.** The red-team harness, the mutants and the witness tests were written by AI agents
under the founder's direction. This is a structured self-review, **not an independent audit**. The
project is an unaudited devnet prototype.

## Map

| Folder | What it is | docs/SECURITY.md |
|---|---|---|
| [`redteam-relay/`](redteam-relay/README.md) | Attack and fuzz harness for the relay (28 targeted attacks, 5 seeded fuzzers, 3 Token flavours), `run.sh`, seed replay of RT-F7 | section 9 |
| [`mutation-core/`](mutation-core/README.md) | 206 hand-written mutants of the core program as data, runner, ledger (`results.csv`), equivalence proofs; the earlier 99-mutant set | section 8.1 |
| [`mutation-relay/`](mutation-relay/README.md) | 257 hand-written mutants of the relay as data, runner, ledger, equivalence proofs; the earlier 15-mutant red-team set | section 8.2 |

The relay witness tests that closed the surviving relay mutants are in the normal test path:
`programs/relay/tests/witness.rs`. The regression tests of the red-team findings are in
`programs/relay/tests/rt.rs` and `rt2.rs`. The harness in `redteam-relay/` is deliberately **not** in
`programs/relay/tests`: it would slow the default `cargo test` and run the heavy fuzz.

## Reproduce

Requirements: Solana CLI with `cargo build-sbf`, rustup's cargo (the scripts put `$HOME/.cargo/bin`
first because Homebrew's cargo shadows it and breaks `cargo build-sbf`), Python 3, bash. Run from the
repository root. Pass a warm `CARGO_TARGET_DIR` (an APFS clone, `cp -cR <warm target> <dir>`) to skip a
cold dependency build, and delete the clone afterwards.

```sh
# Relay red team (scratch copy, own target dir)
security/redteam-relay/run.sh                      # smoke: all attacks + fuzz, RT_ITERS=2000
security/redteam-relay/run.sh replay               # RT_SEED=424242 RT_REPLAY_IT=145566 (finding RT-F7)
security/redteam-relay/run.sh deep                 # release, RT_ITERS=300000 (long)

# Core mutation testing
python3 security/mutation-core/run.py --control
python3 security/mutation-core/run.py --ids X02,V08,N-S31      # killed, equivalent, closed real gap
python3 security/mutation-core/run.py --all                    # the whole campaign (hours)

# Relay mutation testing
python3 security/mutation-relay/run.py --control
python3 security/mutation-relay/run.py --ids C01,V16,D04       # killed, equivalent, closed survivor
python3 security/mutation-relay/run.py --ids D04 --without-witness   # D04 survives without witness.rs
python3 security/mutation-relay/run.py --all                   # the whole campaign (many hours)
```

Each mutation runner prints one line per mutant (`run=<status> ledger=<status> OK|MISMATCH`) and exits
non-zero on any disagreement with `results.csv`. `--list` prints the catalogue.

## What the numbers mean

* A **mutant** is one hand-written edit of the program source (delete a check, flip a comparison, swap
  an error variant, drop a write, ...). It is **killed** if at least one test fails on the rebuilt
  program, **survived** otherwise. An **equivalent** mutant survives because the edit cannot change
  behaviour; it has a written proof (`EQUIVALENT.md`), an informal argument that was not machine-checked.
* The **mutation score** (killed / (total - equivalent)) is the **sensitivity of the tests to these
  hand-written mutants**. It is not a bug count and not evidence of the absence of bugs. The mutants
  were chosen by the same agents that fixed the tests; they are not an independent sample, and
  `cargo-mutants` was not used.
* Where a survivor was closed by a new test, the ledger records the test in `killed_by` and the first
  result in `first_run`. The 100% figures are a closed loop on a catalogue: mutants survived, tests were
  written to kill them. Several relay witnesses plant states that the relay's own instructions can never
  write, so they pin defence in depth.
* The fuzz is seeded and bounded: a clean run says nothing about inputs it did not generate.
* LiteSVM is not a validator, and the mock AMM stands in for Raydium.

## The ledgers and docs/data

| | Ledger | Agrees with |
|---|---|---|
| Core | 206 unique mutants (144 round 1 + 62 new in round 2): 203 killed, 3 equivalent (S18, V06, V08); 4 real gaps (C20, V10, W31, N-S31) closed by tests | `docs/data/core-metrics.json`: 206 unique, 4 gaps closed, 3 equivalent |
| Relay | 257 mutants: 211 killed by the pre-witness suite (12 only by unit tests), 6 equivalent (C02, L05, N22, V16, V17, X03), 40 survivors, all killed by `witness.rs`: 251 killed, 6 equivalent | `docs/data/relay-metrics.json` for 257 / 211 / 6 / 40; see the reconciliation below for the witness count |

Reconciliations (every mismatch found while packaging, and what was done about it):

1. **Relay mutant count.** docs/SECURITY.md carried an interim snapshot ("233 defined, 176 run, 144
   killed, 32 survived"). The finished campaign has 257 mutants; the 32 interim survivors are all among
   the 46 first-pass survivors (40 gaps and 6 equivalents). SECURITY.md was updated.
2. **Relay witnesses: 31 or 40 of 40.** `docs/data/relay-metrics.json` (and BENCHMARKS.md) record 31 of
   the 40 killed and nine open: G09, N10, N12, N13, S12, S41, S42, T07, T11. The packaged ledger records
   all 40 killed, from witness runs made after the witness file was extended (the nine include w16, w18 and w21). With the
   current `programs/relay/tests/witness.rs` the packaged runner kills all nine individually (see
   Verified below), so the gate file reflects an earlier witness version. Both records share one caveat:
   **the full 257-mutant sweep was not re-run with the final `witness.rs`**; only each survivor against
   its mutant. `relay-metrics.json` was not edited (it belongs to the relay gate).
3. **MU1 versus T09.** The red-team pass judged `MU1` (drop `destination != source`) equivalent; the
   systematic campaign's `T09` is the same edit, survives the old suite and is killed by the planted-policy
   witness W11. Both are true: unreachable through instructions, detectable with planted state.
4. **Core "93 and 99 mutants".** The identity of the one equivalent survivor of the 99-mutant set was not
   recorded; it is `R7`, the same edit in effect as the equivalent `V06`. The set is packaged as
   `mutants-legacy99.json` and applies cleanly to the current source. The "legacy suite, 93 mutants, 31
   killed" stage needs the pre-rewrite test suite and is not reproducible from this repository.
5. **Core sweep after the last tests.** As in core-metrics.json: the three round-1 gaps were re-run in
   round 2; N-S31's closing tests were verified on their own mutant, and the packaged runner re-runs it;
   the whole 206-mutant sweep was not re-run after the last commit.

## Cost (measured on a 10-core, 16 GB Apple machine, 17 GB free disk)

* A scratch copy of the repository is about 2 MB (the harness copies only `Cargo.toml`, `Cargo.lock`,
  `src`, `tests`, `fixtures`, `idl`, `programs`, `crates`, `scripts`). The cost is the cargo target
  directory: about 7 GB warm. `cp -cR` of a warm target is an APFS clone that costs almost nothing
  until builds write to it. A cold dependency build was not measured.
* Core mutant: 16 to 50 s each with a warm target (control 44 s); the whole 206-mutant campaign took
  about 3.9 machine-hours in its original harness.
* Relay mutant: about 30 to 45 s each with a warm target (two `cargo build-sbf` builds and the full
  suite, which takes about 40 s); 257 of them is roughly 2 to 3 hours serially. The original campaign
  needed 14.4 machine-hours under heavy load.
* Red team: see Verified.

## Verified

All run from the repository root with warm APFS clones of the shared target (`cp -cR`), one scratch copy
per invocation, every scratch and target directory deleted afterwards. Times are wall-clock on the 10-core
machine above.

| Command | Outcome |
|---|---|
| `python3 security/mutation-core/run.py --control --ids X02,V08,N-S31` | control: suite passes (44 s). `X02` killed (16 s), `V08` survived = equivalent (29 s), `N-S31` killed (33 s) by `tests/mutation_survivors.rs::remove_permission_wipes_all_128_bytes_of_the_vacated_slot`. All three agree with the ledger |
| `python3 security/mutation-core/run.py --ids X02,C20` (after fixing the first-failure parser) | `X02` killed (36 s) by `error_matrix.rs`; `C20` (a round-1 gap) killed (50 s) by `mutation_survivors.rs::funded_husk_create_needs_no_system_program` |
| `python3 security/mutation-core/run.py --set legacy99 --ids R7,T13` | `R7` survived = equivalent (52 s), `T13` killed (17 s) |
| `python3 security/mutation-relay/run.py --control --ids C01,V16,D04` | control: the relay suite passes (44 s). `C01` killed (26 s) by `tr.rs::tr_16_fake_policy_rows`, `V16` survived = equivalent (37 s), `D04` (a pre-witness survivor) killed (42 s) by `witness.rs::w08_pause_preserves_strict_top_level` |
| `python3 security/mutation-relay/run.py --ids G09,N10,N12,N13,S12,S41,S42,T07,T11` | the nine mutants that `relay-metrics.json` lists as open: all nine killed by the current `witness.rs` (27 to 41 s each) |
| `python3 security/mutation-relay/run.py --without-witness --ids D04,T07` | both survive without `witness.rs` (53 s, 48 s), as the ledger's `first_run` says |
| `RT_ITERS=3000 security/redteam-relay/run.sh smoke` | 16 attacks + 12 attacks + 5 fuzzers passed, 43 s in total (fuzz binary 23 s); build of the scratch copy 3 s on the warm target |
| `security/redteam-relay/run.sh replay` and `RT_FLAVOR=classic RT_REPLAY_FULL=1 security/redteam-relay/run.sh replay` | iteration 145566 of seed 424243 reproduced: stored bump overwritten with 84, atomic revert; outcome `ProgramFailedToComplete` or `PrivilegeEscalation` depending on the run's random keys (see redteam-relay/README.md); fast and full replay agree; the 14 `rt2.rs` pins pass. The full replay took 338 s in a debug build |

Not run: the whole 206-mutant and 257-mutant campaigns, the deep fuzz (`run.sh deep`), a cold build.

## Honest limits

* Self-review by the authors' own AI agents; the mutants, the witnesses, the proofs and the fuzz are not
  independent. No claim of "audited", "secure" or "complete".
* Not reproducible from this repository: the pre-rewrite legacy suite (31/93 stage), the raw logs of the
  300000-iteration deep fuzz and of the campaigns (hundreds of KB, kept outside), and the total of "about
  1.4 million fuzzed transactions", which no single preserved log contains.
* The relay source snapshot the 257-mutant sweep ran on is byte-identical to the current
  `programs/relay/src` (checked with `diff -r` while packaging), and the runner aborts if a mutant's
  `old` text no longer matches. docs/BENCHMARKS.md says the sweep "predates the red-team fixes RT-F3 and
  RT-F4"; that is not true of the program source (the fixes are in the swept source), only possibly of
  the test files, and was not changed here because BENCHMARKS.md is not part of this package.
