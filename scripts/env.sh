# shellcheck shell=bash
# Source me:  source scripts/env.sh   (after scripts/build-all.sh)
# Points every Rust integration test at the programs built into $CARGO_TARGET_DIR (default ./target).
# A missing .so is a HARD test failure (set AGENT_AUTH_ALLOW_SKIP=1 to opt out).
_aa_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
_aa_out="${CARGO_TARGET_DIR:-$_aa_root/target}"
export PATH="$HOME/.cargo/bin:$PATH"
export AGENT_AUTH_SO="$_aa_out/deploy/agent_auth.so"
export AGENT_AUTH_RELAY_SO="$_aa_out/deploy/agent_auth_relay.so"
export AGENT_AUTH_RELAY_TESTAMM_SO="$_aa_out/deploy-localnet/agent_auth_relay.so"
export MOCK_AMM_SO="$_aa_out/deploy/mock_amm.so"
export GATED_EXAMPLE_SO="$_aa_out/deploy/gated_example.so"
export EVIL_TOKEN_SO="$_aa_out/deploy/evil_token.so"
export FIXTURE_CALLER_SO="$_aa_out/deploy/fixture_caller.so"
export FIXTURE_YES_MAN_SO="$_aa_out/deploy/fixture_yes_man.so"
unset _aa_root _aa_out
