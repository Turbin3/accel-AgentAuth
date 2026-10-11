# Core mutation testing (`src/**`, program `agent_auth`)

Hand-written mutants of the core program, applied one at a time, each rebuilt into a real `.so` and run
against the whole test suite. This is the evidence behind [docs/SECURITY.md](../../docs/SECURITY.md)
section 8.1. Read [../README.md](../README.md) first for what the numbers do and do not mean.

## What is here

| File | Content |
|---|---|
| `mutants.json` | The 206 unique mutants of the final campaign (round 1: 144, round 2: 62 new). Per mutant: `id`, `round`, `file`, `description`, `operator` (heuristic label), exact `old` / `new` text (a string, or lists of equal length for multi-edit mutants), optional `occurrence`, and `expected` |
| `results.csv` | The ledger of the final state: `id,status,killed_by,note,first_run,round,harness_mode`. `status` is `killed`, `survived` or `equivalent`; `first_run` is what the mutant did the first time it ran |
| `run.py` | The portable runner (Python 3 standard library only) |
| `EQUIVALENT.md` | Written proofs for the 3 equivalent mutants |
| `mutants-legacy99.json`, `results-legacy99.csv` | The earlier 99-mutant campaign against the rewritten suite (`98 killed, 1 equivalent`), see below |

`status` in the ledger: `killed` = at least one test fails on the mutant; `equivalent` = survives every
test and has a written proof in `EQUIVALENT.md`; `survived` = a real test gap (none remain in the
final ledger; the four gaps found are listed below and each is `killed` after its closing test).

## Final numbers and how they reconcile

| | Round 1 | Round 2 |
|---|---|---|
| Mutants run | 144 | 68 = 62 new + 6 re-runs of the round-1 survivors and equivalents |
| Killed | 138 | 64 |
| Survived | 6 (3 gaps: C20, V10, W31; 3 equivalent: S18, V06, V08) | 4 (1 gap: N-S31; 3 equivalent, the re-runs) |
| Score (killed / (total - equivalent)) | 138/141 = 97.9% | 64/65 = 98.5% |

`206 = 144 + 62` unique mutants; 3 are equivalent; the 4 real gaps (C20, V10, W31 from round 1, N-S31
from round 2) were closed with targeted tests. The ledger therefore reads 203 `killed` and 3
`equivalent`. This agrees with `docs/data/core-metrics.json` (206 unique, 4 real gaps closed, 3
equivalent). One caveat is the same as there: **the full sweep was not re-run after the last tests were
added**. The three round-1 gaps were re-run in round 2 and are killed. N-S31 was verified individually
(fails on the mutant, passes on the real source) and, for this package, re-run with the packaged
runner (see "Verified" in [../README.md](../README.md)); its ledger `killed_by` names the
closing tests.

Closing tests of the four gaps:

| Gap | Mutation | Closed by |
|---|---|---|
| C20 | `top_up` transfers even when nothing is missing | `tests/mutation_survivors.rs::funded_husk_create_needs_no_system_program` |
| V10 | `revoke`: a failing `create_program_address` returns NotOwner | `tests/mutation_survivors.rs::revoke_with_an_on_curve_stored_bump_is_invalid_account_type` |
| W31 | `verify`: writable check before owned-by check (error order) | combined-failure rows of `tests/error_matrix.rs::every_instruction_times_every_failure_has_its_documented_code` |
| N-S31 | `swap_remove` zeroes the vacated slot one byte short | `tests/state_unit.rs::swap_remove_zeroes_every_byte_of_the_vacated_slot`, `tests/mutation_survivors.rs::remove_permission_wipes_all_128_bytes_of_the_vacated_slot` |

A second honest limit from round 2: `N-S25` (`permissions_len()` reads only the low byte of the u16) is
killed by a host-side test, but the deployed `.so` alone (all program-backed test binaries) survives it,
because no LiteSVM test stores a corrupt length such as `0x0100`. It counts as killed here because a test
in the suite fails.

## Reproduce

Requirements: the Solana CLI with `cargo build-sbf`, rustup's `cargo` first on `PATH` (the runner puts
`$HOME/.cargo/bin` first; Homebrew's cargo shadows rustup and breaks `cargo build-sbf`), Python 3.

```sh
python3 security/mutation-core/run.py --list                       # the catalogue with its ledger status
python3 security/mutation-core/run.py --control                    # unmutated source: the suite must pass
python3 security/mutation-core/run.py --ids X02,V08,N-S31          # a killed, an equivalent and a closed gap
python3 security/mutation-core/run.py --all                        # the whole campaign
python3 security/mutation-core/run.py --set legacy99 --ids R7      # the legacy set
```

For each mutant the runner: copies the repo to a scratch dir (default under `$TMPDIR`, removed at the
end; your working tree is never touched) once; restores the pristine file, applies the exact edit
(it aborts if the `old` text does not occur exactly once, i.e. if the source drifted from the
catalogue); runs `cargo build-sbf` for the mutant `.so`; sources `scripts/env.sh`, points
`AGENT_AUTH_SO` at the mutant and runs `cargo test` with `AGENT_AUTH_ALLOW_SKIP` unset (a missing `.so`
is a hard failure); records `killed` / `survived` and the first failing tests to `results.jsonl`, and
prints whether that agrees with `results.csv`. Exit status is non-zero on any disagreement.
`cargo test` stops after the first failing test binary (`--all-failures` for `--no-fail-fast`), so the
reported killer is the first one, not the only one.

Pass `--target DIR` (an existing `CARGO_TARGET_DIR`, ideally an APFS clone `cp -cR <warm target> DIR`) to
avoid a cold build of the dependency tree, and delete that clone when you are done.

## Cost (measured)

* Packaged runner, warm target clone, 10-core Apple machine, one mutant at a time: control 44 s,
  X02 16 s (first run, killed by an early binary) and 36 s (second run), V08 (equivalent: the whole
  suite runs) 29 s, N-S31 33 s, C20 50 s. A mutant that survives costs a full suite run,
  a killed one stops at the first failing test binary. A cold build of the dependency tree was not
  measured and costs several GB of target directory.
* The original campaign (a different harness that reused pre-built test binaries for handler-only
  mutants, three parallel workers): median 25 s for handler mutants, 92 s for state/constant/error
  mutants (which also rebuild the host library, maximum 593 s), about 3.9 machine-hours in total across
  both rounds. The packaged runner rebuilds the test binaries after every mutation, so expect
  `--all` to take a few hours on a laptop, serially.
* Disk: a scratch copy is about 2 MB; the target directory is the cost (a warm one is about 7 GB, a clone
  of it starts at ~0 and grows with each mutant build).

## Honest limits

* 206 hand-written mutants chosen by the same AI agents under the founder's direction that wrote the
  tests' fixes; they are not an independent sample, and `cargo-mutants` was not used.
* A killed mutant shows the suite is sensitive to that edit, nothing more. The equivalence proofs are
  informal arguments; `V06` and `V08` rely on pinocchio 0.9.3 `close()` semantics.
* `operator` is a keyword heuristic over the description, only for browsing.
* The legacy set (`mutants-legacy99.json`) is the earlier campaign whose result docs/SECURITY.md
  quotes ("current suite against 99 mutants: 98 killed, 1 equivalent"); its sibling stage
  ("legacy suite against 93 mutants: 31 killed") needs the pre-rewrite test suite, which is not in this
  repository, and cannot be reproduced from a clean checkout.
