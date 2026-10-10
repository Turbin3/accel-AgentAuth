#!/usr/bin/env bash
# End-to-end test of the agentauth CLI against a REAL local validator (no mocks).
#
#   AA_LOCALNET_INSTANCE=1 packages/cli/test/e2e.sh
#
# Starts (and wipes!) the localnet instance you name, bootstraps the demo cast, then drives the whole
# story through the CLI: mandate from a preset, a payment, three kinds of blocked attempt, a live
# per-program revoke, a swap that still works, the one-transaction unwind and the failed follow-up.
# Every step asserts the exit code and the decoded program error. The transcript is written to
# $AA_E2E_TRANSCRIPT (default packages/cli/docs/e2e-transcript.txt). Stops its validator on exit.
#
# Requires: a built CLI (pnpm --filter @agentauth-sol/cli build), target/deploy-localnet programs
# (scripts/build-all.sh), solana-test-validator on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INSTANCE="${AA_LOCALNET_INSTANCE:?set AA_LOCALNET_INSTANCE=<0-9> (this script wipes that instance)}"
TRANSCRIPT="${AA_E2E_TRANSCRIPT:-$ROOT/packages/cli/docs/e2e-transcript.txt}"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
[ -f packages/cli/dist/index.js ] || pnpm --filter @agentauth-sol/cli build >/dev/null
AA=(node "$ROOT/packages/cli/dist/index.js")

cleanup() {
  [ "${AA_E2E_EXTERNAL:-0}" = 1 ] || AA_LOCALNET_INSTANCE="$INSTANCE" scripts/localnet.sh stop >/dev/null 2>&1 || true
  [ -n "${DEMO_TMP:-}" ] && rm -rf "$DEMO_TMP"
}
trap cleanup EXIT

# AA_E2E_EXTERNAL=1: the caller already started the instance (for example on a machine so busy that the
# 30 s budget of localnet.sh start is not enough); the script then neither starts nor stops it.
if [ "${AA_E2E_EXTERNAL:-0}" != 1 ]; then
  # A busy machine can miss the start script's 30 s budget: retry a few times (each start wipes the instance).
  started=0
  for attempt in 1 2 3 4 5 6 7 8; do
    if AA_LOCALNET_INSTANCE="$INSTANCE" scripts/localnet.sh start >/dev/null 2>&1; then
      started=1
      break
    fi
    echo "validator start attempt $attempt failed; retrying" >&2
    AA_LOCALNET_INSTANCE="$INSTANCE" scripts/localnet.sh stop >/dev/null 2>&1 || true
    sleep 5
  done
  [ "$started" -eq 1 ] || { echo "could not start the localnet validator" >&2; exit 1; }
fi
eval "$(AA_LOCALNET_INSTANCE="$INSTANCE" scripts/localnet.sh env)"
DEMO_TMP="$(mktemp -d /private/tmp/aa-cli-e2e.XXXXXX 2>/dev/null || mktemp -d)"
export AA_DEMO_DIR="$DEMO_TMP"
pnpm --filter @agentauth-sol/demo bootstrap >/dev/null

# bootstrap can return before its last writes are visible at the commitment the CLI reads (slow machine):
# wait until the owner really holds some demo dollars.
ready=0
for _ in $(seq 1 60); do
  if "${AA[@]}" --no-color doctor 2>/dev/null | grep -Eq 'owner holds [1-9][0-9.]* DUSD'; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || { echo "demo environment never became readable" >&2; exit 1; }

: >"$TRANSCRIPT"
PASSED=0
fail() {
  echo "E2E FAILED at step: $STEP (got exit $CODE, wanted $WANT, pattern: $PAT)" | tee -a "$TRANSCRIPT" >&2
  exit 1
}

# run <expected-exit> <regex that must appear in stdout+stderr> <agentauth args...>
run() {
  WANT="$1" PAT="$2"
  shift 2
  STEP="agentauth $*"
  {
    echo "\$ agentauth $*"
  } | tee -a "$TRANSCRIPT"
  local out
  set +e
  out="$("${AA[@]}" --no-color "$@" 2>&1)"
  CODE=$?
  set -e
  printf '%s\n[exit %s]\n\n' "$out" "$CODE" | tee -a "$TRANSCRIPT"
  [ "$CODE" -eq "$WANT" ] || fail
  grep -Eq -- "$PAT" <<<"$out" || fail
  PASSED=$((PASSED + 1))
}

say() { printf '\n# %s\n\n' "$1" | tee -a "$TRANSCRIPT"; }

say "1. First look: environment and registry"
run 0 'program agent_auth_relay +deployed' doctor
run 0 'spl-token' registry list
run 0 'default-deny' registry show spl-token
run 0 'Allows' registry preset payments-usdc

say "2. Lint a plan before creating anything (static, no chain)"
run 0 'no findings' lint packages/cli/test/fixtures/plan-good.json --max-expiry 30d
run 1 'AA003' lint packages/cli/test/fixtures/plan-bad.json --max-expiry 30d

say "3. Create the mandate from a preset (preview with warnings, then send)"
run 0 'Simulation only: nothing was sent' mandate create --preset payments-usdc --per-call "5 DUSD" --budget "20 DUSD" \
  --recipient @recipientDusd --swap-pool demo --swap-per-call 5 --swap-budget 10 --delegate "50 DUSD" \
  --allow-override --simulate
run 0 'Mandate created' mandate create --preset payments-usdc --per-call "5 DUSD" --budget "20 DUSD" \
  --recipient @recipientDusd --swap-pool demo --swap-per-call 5 --swap-budget 10 --delegate "50 DUSD" \
  --allow-override --yes
run 0 'SPL delegation +50 DUSD' mandate show
run 0 'HARD' mandate explain

say "4. Normal work: a payment through the relay (hard-enforced), signed by the AGENT key"
run 0 'Paid 3 DUSD' relay pay --to @recipientDusd --amount "3 DUSD"
run 0 'allowed' check --program spl-token --instruction transfer_checked --amount 3

say "5. Blocked: a wrong recipient (the pre-flight stops it; --no-preflight lands it so the chain records it)"
run 2 'relay:104 RecipientNotAllowed' relay pay --to @attackerDusd --amount "40 DUSD"
run 3 'relay:104 RecipientNotAllowed' relay pay --to @attackerDusd --amount "40 DUSD" --no-preflight

say "6. Blocked: over the per-call cap to the allowed recipient"
run 2 'agent_auth:8 PerTxExceeded' relay pay --to @recipientDusd --amount "40 DUSD"
run 3 'agent_auth:8 PerTxExceeded' relay pay --to @recipientDusd --amount "40 DUSD" --no-preflight

say "7. Live per-program revoke: remove the Token permission, the swap keeps working"
run 0 'Done' permission remove spl-token --yes
run 2 'agent_auth:6 ProgramNotAllowed' relay pay --to @recipientDusd --amount "1 DUSD"
run 3 'agent_auth:6 ProgramNotAllowed' relay pay --to @recipientDusd --amount "1 DUSD" --no-preflight
run 0 'Swapped 5 DUSD for' relay swap --amount-in "5 DUSD"

say "8. What happened: the activity feed shows ok rows and BLOCKED attempts with the decoded reason"
run 0 'BLOCKED relay:104 RecipientNotAllowed' activity --limit 20
run 0 'BLOCKED agent_auth:6 ProgramNotAllowed' activity --limit 20

say "9. One-transaction unwind, then the agent tries again"
run 0 'fits in one transaction' mandate revoke --yes
run 2 'relay:101 InvalidPolicy' relay pay --to @recipientDusd --amount "1 DUSD"
run 3 'relay:101 InvalidPolicy' relay pay --to @recipientDusd --amount "1 DUSD" --no-preflight --source @ownerDusd --mint @dusd
run 1 'no mandate exists' mandate show
# the audit trail of the unwound mandate stays readable (the hint of the failure names its address)
CLOSED_MANDATE="$("${AA[@]}" --no-color mandate show 2>&1 | sed -n 's/.*activity --address \([1-9A-HJ-NP-Za-km-z]*\).*/\1/p' | head -n 1 || true)"
[ -n "$CLOSED_MANDATE" ] || { echo "no mandate address in the hint" >&2; fail; }
run 0 'mandate revoked' activity --address "$CLOSED_MANDATE" --limit 50

say "10. Machine-readable output"
run 0 '"schema":"agentauth-cli/1"' --json registry decode spl-token 0c40420f000000000006

echo "E2E OK: $PASSED steps passed. Transcript: $TRANSCRIPT"
