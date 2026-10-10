#!/usr/bin/env bash
# Rebuild always_ok.so and copy it next to this script.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${CARGO_TARGET_DIR:-$(mktemp -d)}"
CARGO_TARGET_DIR="$target" cargo build-sbf --manifest-path "$here/Cargo.toml"
cp "$target/deploy/always_ok.so" "$here/always_ok.so"
ls -l "$here/always_ok.so"
