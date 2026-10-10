#!/usr/bin/env bash
# Build the two SBF programs the LiteSVM tests load (real agent_auth.so + the fixture caller).
# Usage: crates/agent-auth-cpi/build-fixtures.sh   (then `cargo test -p agent-auth-cpi`)
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"   # rustup cargo, not Homebrew's (breaks build-sbf)
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo/target}"   # both programs land in $CARGO_TARGET_DIR/deploy
out="$CARGO_TARGET_DIR"
( cd "$repo" && cargo build-sbf --manifest-path Cargo.toml )
( cd "$here/tests/fixture-caller" && cargo build-sbf )
( cd "$here/tests/fixture-yes-man" && cargo build-sbf )
echo "AGENT_AUTH_SO=$out/deploy/agent_auth.so"
echo "FIXTURE_CALLER_SO=$out/deploy/fixture_caller.so"
echo "FIXTURE_YES_MAN_SO=$out/deploy/fixture_yes_man.so"
