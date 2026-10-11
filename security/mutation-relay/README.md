# Relay mutation testing (`programs/relay/src/**`, program `agent_auth_relay`)

Hand-written mutants of the relay, applied one at a time, each rebuilt into real `.so` files and run
against the whole relay test suite. This is the evidence behind
[docs/SECURITY.md](../../docs/SECURITY.md) section 8.2. Read [../README.md](../README.md) first for what
the numbers do and do not mean.

## What is here

| File | Content |
|---|---|
| `mutants.json` | The 257 mutants (247 first-order, 10 second-order groups G01 to G10 that drop several mutually redundant checks at once). Per mutant: `id`, `area`, `file`, `description`, `spec_ref` (RELAY-SPEC section), `operator` (heuristic label), exact `old` / `new` text, or `edits` (a list of `{file, old, new}`) for the second-order groups, optional `count`, and `expected` |
| `results.csv` | The ledger of the final state: `id,status,killed_by,note,first_run`. `status` is `killed`, `survived` or `equivalent`; `first_run` is what the mutant did against the suite as it was before `witness.rs` (`killed`, `killed (unit tests only)`, `survived`) |
| `run.py` | The portable runner (Python 3 standard library only) |
| `EQUIVALENT.md` | Written proofs for the 6 equivalent mutants |
| `mutants-redteam15.json`, `results-redteam15.csv` | The earlier 15-mutant experiment run with the red-team suites (docs/SECURITY.md 8.2, first row) |

## Final numbers and how they reconcile

| | |
|---|---|
| Mutants | 257 (247 first-order + 10 second-order) |
| Killed by the suite as it stood before `witness.rs` | 211, of which 12 are killed only by `#[cfg(test)]` unit tests inside `src/` (no LiteSVM test fails) |
| Equivalent (written proofs) | 6: C02, L05, N22, V16, V17, X03 |
| Survived the pre-existing suite | 40 |
| Closed by `programs/relay/tests/witness.rs` | all 40 (the witness tests pass on the real relay and fail on the named mutants) |
| Score on the pre-existing suite | 211 / 251 = 84.1% (251 = 257 - 6 equivalent); first-order only 208 / 241 = 86.3% |
| Score with `witness.rs` | 251 / 251 of the non-equivalent mutants of this catalogue |

The last row is a statement about this catalogue, not a proof that the relay has no bugs.

Reconciliation with docs/SECURITY.md (which had an interim snapshot): that text said "233 mutants
defined, 176 run, 144 killed, 32 survived, 57 not yet run" at 03:41 IST. The finished campaign has 257
mutants, 211 killed, 6 equivalent, 40 survivors (46 mutants survived the pre-witness suite; 6 of those
are proven equivalent). All 32 interim survivors are among the 46 (three of them, C02, N22 and L05, turned
out to be equivalent); the other 14 come from mutants not yet run at the snapshot: G01, G03, G04, G05, G06,
G08, G09, L06, V05, V16, V17, V37, V38, X03 (V16, V17 and X03 are equivalent).
Every one of the 40 is now killed by a witness test, so there is no open relay survivor in this ledger. The
earlier 15-mutant experiment's survivor `MU1` ("drop `destination != source`") was judged equivalent there
because `init_policy` keeps the source out of the recipient list and the exact-delta check backs it up;
the systematic campaign counts the same edit as `T09`, which survives the old suite and is killed by the
planted-policy witness W11. Both statements hold: the edit is not reachable through the instruction
interface, but a test can plant the policy state that exposes it.

`docs/data/relay-metrics.json` is owned by the relay gate and was not edited; it should agree with this
ledger (257 / 211 / 6 / 40 / 251). A disagreement is a bug in one of them.

## Reproduce

```sh
python3 security/mutation-relay/run.py --list                          # catalogue with ledger status
python3 security/mutation-relay/run.py --control                       # unmutated source: the suite must pass
python3 security/mutation-relay/run.py --ids C01,V16,D04              # a killed, an equivalent and a closed survivor
python3 security/mutation-relay/run.py --ids D04 --without-witness     # D04 survives when witness.rs is removed
python3 security/mutation-relay/run.py --all                           # the whole campaign (many hours)
python3 security/mutation-relay/run.py --set redteam15 --ids MU2       # the 15-mutant experiment (installs the red-team suites)
```

For each mutant the runner works in a scratch copy under `$TMPDIR` (removed at the end; the working tree
is never touched): it restores the pristine file, applies the exact edit (it aborts if the `old` text
does not occur the expected number of times, i.e. if the source drifted from the catalogue), builds both
relay binaries with `cargo build-sbf` (default features, and `--features test-amm` for the mock AMM),
sources `scripts/env.sh`, points `AGENT_AUTH_RELAY_SO` and `AGENT_AUTH_RELAY_TESTAMM_SO` at the mutant
builds (the shared target never holds a mutant), unsets `AGENT_AUTH_ALLOW_SKIP`, and runs
`cargo test -p agent-auth-relay`. It records `killed` / `survived` and the first failing tests to
`results.jsonl` and prints whether that agrees with `results.csv` (non-zero exit on any disagreement).
`scripts/build-all.sh` runs once first because the relay suite also loads the other programs.
`cargo test` stops after the first failing test binary (`--all-failures` for `--no-fail-fast`), so a
reported killer is the first one, not the only one.

Pass `--target DIR` (an existing `CARGO_TARGET_DIR`, ideally an APFS clone `cp -cR <warm target> DIR`) to
avoid a cold build, and delete that clone when you are done.

## Cost (measured)

* Original campaign, four parallel workers under heavy machine load, full suite per mutant
  (`--no-fail-fast`): median 195 s per mutant (72 to 423 s), 14.4 machine-hours in total, about 3.6 hours
  wall-clock.
* Packaged runner, warm target clone, one mutant at a time, 10-core Apple machine: control 44 s; mutants 26 to 53 s each (killed ones stop at the first failing test binary; see "Verified" in [../README.md](../README.md)). Each mutant costs
  two `cargo build-sbf` builds plus a suite run (468 tests in 15 binaries plus 40 unit tests).
* Disk: a scratch copy is about 2 MB; the target directory is the cost (about 7 GB warm).

## Honest limits

* Mutants were written by the same AI agents, under the submitting developer's direction, that wrote the tests;
  not an independent sample, and `cargo-mutants` was not used.
* The 40 `witness.rs` tests exist because mutants survived; the 100% on the non-equivalent catalogue is
  therefore a closed loop on this catalogue, not an out-of-sample result. Several witnesses plant
  policy or token-account states that the relay's own instructions can never write; they pin
  defence-in-depth checks, not reachable bugs.
* 12 mutants are killed only by in-source unit tests; the deployed `.so` is not exercised by those.
* The two `#[ignore]`d tests (SW-15, which needs a dumped Raydium binary) were not run. The mock AMM
  stands in for Raydium; nothing here says anything about the real Raydium program.
* `operator` is a keyword heuristic over the description, only for browsing.
* The equivalence proofs are informal; L05 relies on pinocchio 0.9.3 `close()` semantics.
