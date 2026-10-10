#!/usr/bin/env bash
# Build every on-chain program with `cargo build-sbf`. Idempotent: cargo's incremental cache makes a
# repeat run a no-op.
#
# Output (under $CARGO_TARGET_DIR, default ./target):
#   deploy/agent_auth.so            core program, ID AKkih5Yd...
#   deploy/agent_auth_relay.so      relay, DEFAULT features = the devnet build
#   deploy/mock_amm.so              Raydium-CPMM-shaped test AMM (test/demo only)
#   deploy/gated_example.so         third-party example integrator of `verify`
#   deploy/evil_token.so            test-only Token stub (LiteSVM tests only)
#   deploy/fixture_caller.so, deploy/fixture_yes_man.so
#                                   test fixtures of crates/agent-auth-cpi (LiteSVM tests only)
#   deploy-localnet/agent_auth_relay.so
#                                   relay built with --features test-amm (the mock AMM is allowlisted).
#                                   LOCALNET/TEST ONLY: never deploy this file to devnet or mainnet.
#
# Usage: scripts/build-all.sh      (from any directory)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Homebrew's cargo shadows rustup's proxy and breaks `cargo build-sbf`: put rustup first.
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"
OUT="${CARGO_TARGET_DIR:-$ROOT/target}"

if ! command -v cargo-build-sbf >/dev/null 2>&1 && ! cargo build-sbf --version >/dev/null 2>&1; then
  echo "error: cargo build-sbf not found (install the Solana CLI: https://solana.com/docs/intro/installation)" >&2
  exit 1
fi

build() { # manifest [extra cargo build-sbf args...]
  local manifest="$1"
  shift
  local started=$SECONDS
  echo "==> cargo build-sbf --manifest-path $manifest $*"
  cargo build-sbf --manifest-path "$manifest" "$@"
  echo "    done in $((SECONDS - started))s"
}

TOTAL_START=$SECONDS
build Cargo.toml
build programs/relay/Cargo.toml
build programs/relay/Cargo.toml --features test-amm --sbf-out-dir "$OUT/deploy-localnet"
build programs/mock-amm/Cargo.toml
build programs/gated-example/Cargo.toml
build programs/evil-token/Cargo.toml
echo "==> crates/agent-auth-cpi/build-fixtures.sh"
"$ROOT/crates/agent-auth-cpi/build-fixtures.sh" >/dev/null

EXPECTED=(
  "$OUT/deploy/agent_auth.so"
  "$OUT/deploy/agent_auth_relay.so"
  "$OUT/deploy-localnet/agent_auth_relay.so"
  "$OUT/deploy/mock_amm.so"
  "$OUT/deploy/gated_example.so"
  "$OUT/deploy/evil_token.so"
  "$OUT/deploy/fixture_caller.so"
  "$OUT/deploy/fixture_yes_man.so"
)

echo
echo "Built programs (sha256, bytes, path):"
missing=0
for f in "${EXPECTED[@]}"; do
  if [ -f "$f" ]; then
    printf '  %s  %8s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(wc -c <"$f" | tr -d ' ')" "$f"
  else
    echo "  MISSING  $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "error: at least one program was not produced" >&2
  exit 1
fi
echo
echo "Total build time: $((SECONDS - TOTAL_START))s"
echo "Rust tests:   source scripts/env.sh   (sets every *_SO variable)"
echo "Local chain:  scripts/localnet.sh start"
