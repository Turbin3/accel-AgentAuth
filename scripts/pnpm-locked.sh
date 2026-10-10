#!/usr/bin/env bash
# Runs pnpm from the repo root while holding a machine-wide lock, so that parallel developers (or agents)
# never run `pnpm install` / `pnpm add` at the same time on the shared workspace (pnpm-lock.yaml and
# node_modules are shared). Read-only commands (`pnpm test`, `pnpm exec`, `pnpm --filter x run y`) do not
# need it.
#
#   scripts/pnpm-locked.sh install
#   scripts/pnpm-locked.sh add --filter @agentauth-sol/cli commander@15
set -euo pipefail

LOCK="${AA_PNPM_LOCK:-/tmp/agentauth-pnpm.lock}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  # A lock older than 15 minutes belongs to a crashed run.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    continue
  fi
  sleep 2
  waited=$((waited + 2))
  if [ "$waited" -ge 1200 ]; then
    echo "error: waited 20 minutes for $LOCK" >&2
    exit 1
  fi
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$ROOT"
pnpm "$@"
