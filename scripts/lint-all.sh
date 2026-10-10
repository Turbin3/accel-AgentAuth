#!/usr/bin/env bash
# Static checks, no validator needed:
#   1. cargo fmt --check
#   2. cargo clippy --workspace --all-targets -D warnings   (the core crate at the repo root is in the workspace)
#   3. pnpm -r typecheck, pnpm -r lint (tsc, prettier --check, eslint for the dashboard)
# Every phase runs even if an earlier one fails; the exit code is non-zero if any phase failed.
#
# Usage: scripts/lint-all.sh      (from any directory)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"

failed=()
run() { # name command...
  local name="$1"
  shift
  echo
  echo "=== $name ==="
  if ! "$@"; then failed+=("$name"); fi
}

run "cargo fmt --check" cargo fmt --all --check
run "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings
run "pnpm typecheck" pnpm -r --if-present run typecheck
run "pnpm lint" pnpm -r --if-present run lint

echo
if [ "${#failed[@]}" -ne 0 ]; then
  echo "lint FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "lint passed"
