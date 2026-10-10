#!/usr/bin/env bash
# Build every on-chain program. Output: $CARGO_TARGET_DIR (default ./target)/deploy/*.so and
# .../deploy-localnet/agent_auth_relay.so (relay built with the `test-amm` feature: the mock AMM is allowlisted;
# NEVER deploy that build to devnet/mainnet).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Homebrew's cargo shadows rustup's proxy and breaks `cargo build-sbf`; put rustup first.
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"
OUT="${CARGO_TARGET_DIR:-$ROOT/target}"

build() { # manifest [extra args...]
  local manifest="$1"; shift
  local dir; dir="$(dirname "$manifest")"
  if [ "$manifest" != "Cargo.toml" ] && ! grep -rqs "program_entrypoint\|entrypoint!" "$dir/src"; then
    echo "skip $manifest (no entrypoint yet)"; return 0
  fi
  echo "==> cargo build-sbf --manifest-path $manifest $*"
  cargo build-sbf --manifest-path "$manifest" "$@"
}

build Cargo.toml
build programs/relay/Cargo.toml
build programs/relay/Cargo.toml --features test-amm --sbf-out-dir "$OUT/deploy-localnet"
build programs/mock-amm/Cargo.toml
build programs/gated-example/Cargo.toml
build programs/evil-token/Cargo.toml

echo
echo "Built programs (sha256, bytes):"
for f in "$OUT"/deploy/agent_auth.so "$OUT"/deploy/agent_auth_relay.so "$OUT"/deploy-localnet/agent_auth_relay.so \
         "$OUT"/deploy/mock_amm.so "$OUT"/deploy/gated_example.so "$OUT"/deploy/evil_token.so; do
  [ -f "$f" ] && printf '  %s  %7s  %s\n' "$(shasum -a 256 "$f" | cut -c1-16)" "$(wc -c < "$f" | tr -d ' ')" "${f#$ROOT/}"
done
echo
echo "Test env:  source scripts/env.sh"
