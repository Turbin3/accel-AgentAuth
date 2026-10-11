# Recorded red-team results (summary of the original run logs; one log is kept in this directory)

These are the recorded results of the original runs of this harness on 2026-10-11, taken from the logs.
They are not re-measurements: `run.sh` is how you reproduce them. See [../README.md](../README.md) for
what was verified from a clean checkout.

| Run | Command (summary) | Result |
|---|---|---|
| Debug suite | `RT_ITERS=2000`, `redteam_attacks`, `redteam_attacks2`, `redteam_fuzz`, debug build | attacks 16 passed, attacks2 12 passed, fuzz 5 passed (fuzz binary 31.2 s) |
| Deep fuzz, 100000 iterations | `RT_ITERS=100000`, `redteam_fuzz`, `--release`, 5 test threads | 5 passed, 88.2 s. Full per-flavour outcome histograms: `log-fuzz-release-100000-iters.txt` (paths removed) |
| Deep fuzz, 300000 iterations | `RT_ITERS=300000 RT_SEED=424242`, release | ended at seed 424243 (Classic), FZ-02, iteration 145566 with `ABNORMAL ProgramFailedToComplete` ("Could not create program address with signer seeds"): finding RT-F7, triaged in docs/SECURITY.md; the harness now records this class (relay-owned policy or mandate bytes corrupted by the fuzzer) instead of failing |
| Mutation experiment on the relay | 15 hand-written mutants, whole relay suite plus these suites | 14 killed, 1 survivor (MU1). Data and ledger: `../mutation-relay/mutants-redteam15.json`, `../mutation-relay/results-redteam15.csv` |

"About 1.4 million fuzzed transactions" (docs/SECURITY.md section 9) is the 100,000-iteration release run:
14 fuzz sections (FZ-01 to FZ-05 across three Token flavours, FZ-05 on two) times 100,000 iterations. The
preserved log `log-fuzz-release-100000-iters.txt` holds that run, and its per-section outcome counts sum to
1,400,002 (two extra counts in the `internal-corruption-abnormal` bucket of FZ-01 Classic). The logs of the
earlier 8000, 40000 and 300000-iteration runs are not preserved.
