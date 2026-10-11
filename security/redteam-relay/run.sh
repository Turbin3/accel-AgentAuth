#!/usr/bin/env bash
# Relay red-team harness: attacks + seeded fuzz, run against the real relay .so files in LiteSVM.
#
# Never touches the working tree: it makes a scratch copy of the repo, installs the harness into
# programs/relay/tests OF THE COPY, builds every program with scripts/build-all.sh (own
# CARGO_TARGET_DIR) and runs the tests there. The harness is deliberately NOT part of the default
# `cargo test` of the repository (the fuzz is heavy).
#
#   security/redteam-relay/run.sh                 # smoke: all attacks + fuzz, RT_ITERS=2000
#   security/redteam-relay/run.sh attacks         # targeted attacks only (no fuzz)
#   security/redteam-relay/run.sh fuzz            # fuzz only
#   security/redteam-relay/run.sh deep            # the deep run: release build, RT_ITERS=300000, RT_SEED=424242
#   security/redteam-relay/run.sh replay          # replay iteration 145566 of seed 424242 (finding RT-F7)
#
# Environment (all optional):
#   RT_SEED        u64 seed of the fuzzers (default: each fuzzer's own constant; deep and replay use 424242)
#   RT_ITERS       iterations per fuzzer (default 2000 here; 300000 in `deep`)
#   RT_REPLAY_IT   run only this iteration of FZ-01 / FZ-02 (default 145566 in `replay`)
#   RT_REPLAY_FULL=1   with RT_REPLAY_IT: also send the earlier iterations (slow: ~6 minutes for 145566; the check that the fast-forward is faithful)
#   RT_FLAVOR      classic|ptoken|token2022: restrict FZ-01 / FZ-02 to one Token flavour
#   RT_DEBUG       outcome name (e.g. ProgramFailedToComplete): print the diff and logs of every iteration with it
#   CARGO_TARGET_DIR   build output; point it at a warm copy to skip the cold build (a cold build is slow)
#   RT_SCRATCH     scratch directory (default: a new mktemp dir under $TMPDIR, deleted at the end)
#   RT_KEEP=1      keep the scratch directory
#   RT_THREADS     --test-threads (default 4)
set -euo pipefail

MODE="${1:-smoke}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"   # rustup's cargo must shadow Homebrew's, or `cargo build-sbf` breaks

CLEAN=1
if [ -n "${RT_SCRATCH:-}" ]; then SCRATCH="$RT_SCRATCH"; CLEAN=0; mkdir -p "$SCRATCH"; else SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/agentauth-redteam.XXXXXX")"; fi
[ "${RT_KEEP:-0}" = 1 ] && CLEAN=0
WORK="$SCRATCH/repo"
LOGS="$SCRATCH/logs"
mkdir -p "$WORK" "$LOGS"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$SCRATCH/target}"
cleanup() { if [ "$CLEAN" = 1 ]; then rm -rf "$SCRATCH"; else echo "scratch kept: $SCRATCH"; fi; }
trap cleanup EXIT

echo "scratch copy: $WORK"
echo "cargo target: $CARGO_TARGET_DIR"
CP="cp -R"; [ "$(uname)" = Darwin ] && CP="cp -cR"   # APFS clone: instant and no extra disk
for f in Cargo.toml Cargo.lock src tests fixtures idl programs crates scripts; do
  [ -e "$REPO/$f" ] && $CP "$REPO/$f" "$WORK/$f"
done
find "$WORK" -name target -type d -prune -exec rm -rf {} + 2>/dev/null || true

# install the harness into the COPY
T="$WORK/programs/relay/tests"
cp "$HERE"/redteam_attacks.rs "$HERE"/redteam_attacks2.rs "$HERE"/redteam_fuzz.rs "$T"/
rm -rf "$T/redteam_util" && cp -R "$HERE/redteam_util" "$T/redteam_util"

cd "$WORK"
echo "== scripts/build-all.sh (log: $LOGS/build-all.log)"
started=$SECONDS
bash scripts/build-all.sh >"$LOGS/build-all.log" 2>&1 || { tail -20 "$LOGS/build-all.log"; exit 1; }
echo "   built in $((SECONDS - started))s"
# shellcheck disable=SC1091
source scripts/env.sh

THREADS="${RT_THREADS:-4}"
PKG=(-p agent-auth-relay)
run() { echo "== $*"; "$@"; }

case "$MODE" in
  smoke)
    export RT_ITERS="${RT_ITERS:-2000}"
    run cargo test "${PKG[@]}" --test redteam_attacks --test redteam_attacks2 --test redteam_fuzz --no-fail-fast -- --nocapture --test-threads="$THREADS" 2>&1 | tee "$LOGS/smoke.log" | grep -E "^(running|test |test result|----|REPLAY|error)" || true
    ;;
  attacks)
    run cargo test "${PKG[@]}" --test redteam_attacks --test redteam_attacks2 --no-fail-fast -- --test-threads="$THREADS" 2>&1 | tee "$LOGS/attacks.log" | grep -E "^(running|test |test result|error)" || true
    ;;
  fuzz)
    export RT_ITERS="${RT_ITERS:-2000}"
    run cargo test "${PKG[@]}" --test redteam_fuzz --no-fail-fast -- --nocapture --test-threads="$THREADS" 2>&1 | tee "$LOGS/fuzz.log" | grep -E "^(running|test |test result|----|error)" || true
    ;;
  deep)
    export RT_ITERS="${RT_ITERS:-300000}" RT_SEED="${RT_SEED:-424242}"
    run cargo test "${PKG[@]}" --release --test redteam_fuzz --no-fail-fast -- --nocapture --test-threads=5 2>&1 | tee "$LOGS/deep.log" | grep -vE "^\s+(Compiling|Downloaded)" || true
    ;;
  replay)
    export RT_SEED="${RT_SEED:-424242}" RT_REPLAY_IT="${RT_REPLAY_IT:-145566}"
    run cargo test "${PKG[@]}" --test redteam_fuzz fz02_swap_state_fuzz -- --nocapture --test-threads=1 2>&1 | tee "$LOGS/replay.log" | grep -E "^(REPLAY|test |test result|error)" || true
    # the deterministic pins of the same class: every wrong stored bump reverts atomically (rt2.rs)
    run cargo test "${PKG[@]}" --test rt2 -- --test-threads="$THREADS" 2>&1 | tee -a "$LOGS/replay.log" | grep -E "^(running|test result|error)" || true
    ;;
  *)
    echo "usage: $0 [smoke|attacks|fuzz|deep|replay]" >&2; exit 2 ;;
esac
# a pipeline through tee/grep hides cargo's exit status: report it from the saved log
LOG="$LOGS/$([ "$MODE" = smoke ] && echo smoke || echo "$MODE").log"
if grep -qE "^test result: FAILED|^error(\[|:)" "$LOG"; then echo "RESULT: FAILURES (see above)"; exit 1; fi
echo "RESULT: no failing test"
