# Relay red team

An attacker-minded suite for the relay (`programs/relay`), written independently of the relay's own
tests and run against the real compiled `.so` files in LiteSVM, in three flavours of the Token program
(classic `spl-token`, `p-token`, Token-2022). This is the evidence behind
[docs/SECURITY.md](../../docs/SECURITY.md) section 9. Read [../README.md](../README.md) first: it was
written by AI agents under the founder's direction, so it is a structured self-review, not an
independent audit.

Every test asserts the safe outcome, so a failing test is a finding.

## Files

| File | Content |
|---|---|
| `redteam_attacks.rs` | 16 targeted attacks (RT-01 to RT-16): alias matrices over all account pairs, flag flips, instruction splitting, stale-policy re-binding, close and re-init in one transaction, delegate tricks, hostile AMM modes, deadline edges, AMM allowlist by build, Token-2022 extension sweep |
| `redteam_attacks2.rs` | 12 more (rt17 onwards): phished approvals through an attacker's mandate, Token-2022 native mint and budget, core lifecycle effects on the relay, measurements, a `required_min_out` oracle |
| `redteam_fuzz.rs` | 5 seeded fuzzers FZ-01 to FZ-05 (transfer state, swap state, random instruction data, random account lists, an `init_policy` config oracle). A ledger check asserts that no lamport or token balance outside the policy changes |
| `redteam_util/mod.rs` | Seeded RNG, outcome classification, ledger and verify-call helpers |
| `run.sh` | Scratch-copy runner (below) |

The harness uses the repo's own `programs/relay/tests/common` helpers. It is **not** in
`programs/relay/tests`: a default `cargo test` must stay fast and must not run the heavy fuzz. `run.sh`
installs it into a scratch copy only.

## Run

```sh
security/redteam-relay/run.sh              # smoke: attacks + all fuzzers, RT_ITERS=2000
security/redteam-relay/run.sh attacks      # attacks only
security/redteam-relay/run.sh fuzz         # fuzz only
security/redteam-relay/run.sh replay       # replay iteration 145566 of seed 424242 (finding RT-F7)
security/redteam-relay/run.sh deep         # release build, RT_ITERS=300000, RT_SEED=424242 (long)
```

What `run.sh` does: makes a scratch copy of the repo (`cp -cR` on macOS, so it is an APFS clone and costs
no disk; `cp -R` elsewhere) under `$TMPDIR`, copies the harness into `programs/relay/tests` of the copy,
runs `scripts/build-all.sh` with its own `CARGO_TARGET_DIR`, sources `scripts/env.sh` and runs the tests.
Your working tree is not touched. The scratch directory is removed at the end (`RT_KEEP=1` keeps it).

| Variable | Meaning |
|---|---|
| `RT_SEED` | `u64` seed. Each fuzzer has its own default constant (FZ-01 `0xA11CE`, FZ-02 `0xB0B`, FZ-03 `0xDA7A`, ...). The per-flavour seed shown in a failure message is `RT_SEED ^ (flavour + 1)` with Classic = 0, p-token = 1, Token-2022 = 2: seed 424243 is `RT_SEED=424242` on the Classic flavour |
| `RT_ITERS` | Iterations per fuzzer. `run.sh` defaults to 2000 (a laptop minute or two once built); `deep` defaults to 300000 |
| `RT_REPLAY_FULL`, `RT_FLAVOR` | `RT_REPLAY_FULL=1` also sends the earlier iterations (the check that the fast-forward is faithful); `RT_FLAVOR=classic\|ptoken\|token2022` restricts FZ-01 / FZ-02 to one flavour |
| `RT_REPLAY_IT` | FZ-01 / FZ-02 only: replay only this iteration. The earlier iterations still draw from the generator, so the stream is identical, but they send nothing; the chosen iteration runs, prints `REPLAY ... outcome ... cu ...` and the program logs, and the loop stops. Not part of the original harness: added when the packaged harness was assembled |
| `RT_DEBUG` | An outcome name, e.g. `ProgramFailedToComplete`: FZ-01 prints the state diff and logs of every iteration ending with it |
| `CARGO_TARGET_DIR` | Build output. Point it at a warm copy (`cp -cR <warm target> <dir>`) to skip a cold build, and delete the copy afterwards |
| `RT_SCRATCH`, `RT_KEEP`, `RT_THREADS` | Scratch directory, keep it, `--test-threads` |

The deep run is the one behind the "about 1.4 million fuzzed transactions" in docs/SECURITY.md. Its
exact command is `RT_ITERS=300000 RT_SEED=424242 cargo test -p agent-auth-relay --release --test redteam_fuzz -- --nocapture --test-threads=5`
(that is what `run.sh deep` runs). Other deep runs of the same history used 8000, 40000 and 100000
iterations. Only the 100000-iteration release summary is quoted in `results-summary.md`; the full logs
(hundreds of KB) stay outside the repository.

## The replay of RT-F7

```sh
security/redteam-relay/run.sh replay
```

replays seed 424243 (`RT_SEED=424242`, Classic flavour), swap fuzz (FZ-02), iteration 145566, and then runs
the 14 deterministic pins of the same class in `programs/relay/tests/rt2.rs`. What the replay shows, as
measured when this was packaged:

* The fuzzer's mutation at that iteration is reproduced exactly: it overwrites the relay's own stored
  `authority_bump` (byte 3 of the policy) with 84 (the line prints `authority_bump_original` and
  `authority_bump_now`), and the swap then fails after the core `verify` succeeded.
* The runtime outcome is **not** the same on every run. The fixtures use fresh random keypairs each
  process, so the policy PDA, and with it the canonical bump (254 or 255 in the runs made), differ per run.
  With bump 84 the signer-seed derivation then gives either no valid address (`ProgramFailedToComplete`,
  the log line "Could not create program address with signer seeds", the outcome recorded in the original
  300000-iteration run) or a valid but different address (`PrivilegeEscalation`). Both were seen: in 13
  replays 7 were `ProgramFailedToComplete` and 6 `PrivilegeEscalation`. Compute units were 5762
  in every replay against 5725 in the original log (the program has been rebuilt since). Both outcomes are
  the revert that docs/SECURITY.md RT-F7 describes, and neither moves any balance.
* The fast-forward (earlier iterations draw from the generator but send nothing) is faithful: replaying with
  `RT_REPLAY_FULL=1`, which sends all 145565 earlier iterations (338 s in a debug build), gave the same
  iteration inputs and the same outcome class; for iterations 1500 and 6000 fast and full replays gave identical
  outcomes and compute units.
* In the original 300000-iteration run this ended the test with an `ABNORMAL ProgramFailedToComplete`
  assertion; the current harness records such outcomes as an internal-corruption case (policy or mandate
  bytes touched) instead of failing.

See docs/SECURITY.md RT-F7 and `programs/relay/tests/rt2.rs` (the pins for all 255 wrong bump values).

## Honest limits

* LiteSVM measurements are LiteSVM measurements. The mock AMM stands in for Raydium.
* A passing fuzz run says nothing about inputs it did not generate. The seeds are fixed so a run is
  repeatable, which also means a smoke run explores a small, fixed slice.
* The relay is a prototype, unaudited. This suite found two low-severity issues that were fixed
  (RT-F3, RT-F4) and documented five more; it did not prove their absence elsewhere.
