#!/usr/bin/env bash
# Everything that can be tested without a running validator:
#   1. scripts/build-all.sh          every on-chain program (needed by the LiteSVM tests)
#   2. cargo test --workspace        Rust unit + LiteSVM tests with every *_SO variable set (scripts/env.sh);
#                                    a missing .so is a HARD failure (set AGENT_AUTH_ALLOW_SKIP=1 to opt out)
#   3. pnpm -r test                  every TypeScript package (offline vitest suites)
#
# The localnet end-to-end check is separate (needs the validator):
#   scripts/localnet.sh start && pnpm --filter @agentauth-sol/demo bootstrap && pnpm --filter @agentauth-sol/demo smoke --relay
#
# Usage: scripts/test-all.sh [extra cargo test args...]      (from any directory; idempotent)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

started=$SECONDS
phase() { echo; echo "=== $* ($((SECONDS - started))s elapsed) ==="; }

phase "1/3 build programs"
"$ROOT/scripts/build-all.sh"

phase "2/3 cargo test --workspace"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"
cargo test --workspace --no-fail-fast "$@"

phase "3/3 pnpm -r test"
pnpm -r --if-present run test

phase "all tests passed"
