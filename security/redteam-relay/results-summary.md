# Recorded red-team results (summary of logs kept outside the repository)

These are the recorded results of the original runs of this harness on 2026-10-11, taken from the logs.
They are not re-measurements: `run.sh` is how you reproduce them. See [../README.md](../README.md) for
what was verified from a clean checkout.

| Run | Command (summary) | Result |
|---|---|---|
| Debug suite | `RT_ITERS=2000`, `redteam_attacks`, `redteam_attacks2`, `redteam_fuzz`, debug build | attacks 16 passed, attacks2 12 passed, fuzz 5 passed (fuzz binary 31.2 s) |
| Deep fuzz, 100000 iterations | `RT_ITERS=100000`, `redteam_fuzz`, `--release`, 5 test threads | 5 passed, 88.2 s. Full per-flavour outcome histograms: `log-fuzz-release-100000-iters.txt` (paths removed) |
| Deep fuzz, 300000 iterations | `RT_ITERS=300000 RT_SEED=424242`, release | ended at seed 424243 (Classic), FZ-02, iteration 145566 with `ABNORMAL ProgramFailedToComplete` ("Could not create program address with signer seeds"): finding RT-F7, triaged in docs/SECURITY.md; the harness now records this class (relay-owned policy or mandate bytes corrupted by the fuzzer) instead of failing |
| Mutation experiment on the relay | 15 hand-written mutants, whole relay suite plus these suites | 14 killed, 1 survivor (MU1). Data and ledger: `../mutation-relay/mutants-redteam15.json`, `../mutation-relay/results-redteam15.csv` |

"About 1.4 million fuzzed transactions in total" (docs/SECURITY.md section 9) is the sum over the
several runs (8000, 40000, 100000 and 300000 iterations, three Token flavours, five fuzzers); no single
preserved log holds that total, so treat it as the commit message's estimate.
