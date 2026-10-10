#!/usr/bin/env bash
# Local Solana validator with every AgentAuth program preloaded. Works from any directory.
#
#   scripts/localnet.sh start    start a FRESH validator (ledger is wiped), wait until it is healthy
#   scripts/localnet.sh stop     stop the validator started by this script
#   scripts/localnet.sh reset    stop (if running) and start again on an empty ledger
#   scripts/localnet.sh status   running? health, slot and whether each program is executable
#
#   scripts/localnet.sh env      print the exports (AA_RPC_URL, AA_WS_URL, AA_DEMO_DIR) for this instance
#
# Default ports: rpc 8899, websocket 8900 (rpc + 1), faucet 9900. Refuses to start twice.
# Parallel work (several developers or agents on one machine): AA_LOCALNET_INSTANCE=<0-9> gives each
# instance its own ports (rpc 8899 + 10n, ws rpc + 1, faucet 9900 + n), ledger directory and demo
# directory, so one instance can be reset without touching another:
#   AA_LOCALNET_INSTANCE=2 scripts/localnet.sh start && eval "$(AA_LOCALNET_INSTANCE=2 scripts/localnet.sh env)"
#
# Programs (read from $CARGO_TARGET_DIR, default <repo>/target; build them with scripts/build-all.sh):
#   AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if  deploy/agent_auth.so                 core
#   33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6  deploy-localnet/agent_auth_relay.so relay, test-amm build
#   6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw  deploy/mock_amm.so                   mock AMM (test/demo only)
#   CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ  deploy/gated_example.so              example integrator
# The relay loaded here allowlists the mock AMM. It is a LOCALNET build: never deploy it to devnet.
#
# State (override the directory with AA_LOCALNET_DIR): <dir>/ledger, <dir>/validator.pid, <dir>/validator.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${CARGO_TARGET_DIR:-$ROOT/target}"
INSTANCE="${AA_LOCALNET_INSTANCE:-0}"
case "$INSTANCE" in
  [0-9]) ;;
  *)
    echo "error: AA_LOCALNET_INSTANCE must be a single digit 0-9 (got '$INSTANCE')" >&2
    exit 2
    ;;
esac
if [ "$INSTANCE" = 0 ]; then SUFFIX=""; else SUFFIX="-$INSTANCE"; fi
STATE_DIR="${AA_LOCALNET_DIR:-/tmp/agentauth-localnet$SUFFIX}"
LEDGER="$STATE_DIR/ledger"
PID_FILE="$STATE_DIR/validator.pid"
LOG_FILE="$STATE_DIR/validator.log"

RPC_PORT=$((8899 + 10 * INSTANCE))
WS_PORT=$((RPC_PORT + 1))
FAUCET_PORT=$((9900 + INSTANCE))
RPC_URL="http://127.0.0.1:$RPC_PORT"
DEMO_DIR="$ROOT/.demo$SUFFIX"
# Waits are generous because a loaded machine (parallel builds, other validators) starts slowly; override with
# AA_LOCALNET_TIMEOUT (seconds, applies to the health wait; block production and program waits scale with it).
HEALTH_TIMEOUT_SECS="${AA_LOCALNET_TIMEOUT:-240}"

# Solana CLI installer puts its binaries here; non-interactive shells often lack it on PATH.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROGRAM_NAMES=(core relay mock_amm gated_example)
PROGRAM_IDS=(
  AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if
  33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6
  6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw
  CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ
)
PROGRAM_SOS=(
  "$OUT/deploy/agent_auth.so"
  "$OUT/deploy-localnet/agent_auth_relay.so"
  "$OUT/deploy/mock_amm.so"
  "$OUT/deploy/gated_example.so"
)

die() {
  echo "error: $*" >&2
  exit 1
}

port_open() { # port: true when something accepts TCP connections on 127.0.0.1:port
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

rpc() { # json-rpc body -> response on stdout (empty on failure)
  curl -s -m 3 -X POST -H 'content-type: application/json' -d "$1" "$RPC_URL" 2>/dev/null || true
}

is_healthy() {
  rpc '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"result":"ok"'
}

program_executable() { # program id
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$1\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}" |
    grep -q '"executable":true'
}

pid_alive() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

current_slot() {
  rpc '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | sed -n 's/.*"result":\([0-9]*\).*/\1/p'
}

cmd_start() {
  command -v solana-test-validator >/dev/null 2>&1 ||
    die "solana-test-validator not found (install the Solana CLI: https://solana.com/docs/intro/installation)"
  for so in "${PROGRAM_SOS[@]}"; do
    [ -f "$so" ] || die "missing $so (run scripts/build-all.sh first)"
  done
  if pid_alive; then
    die "a validator started by this script is already running (pid $(cat "$PID_FILE")); use 'localnet.sh reset' or 'stop'"
  fi
  for port in "$RPC_PORT" "$WS_PORT" "$FAUCET_PORT"; do
    if port_open "$port"; then
      die "port $port is already in use by another process; stop it first (this script only manages its own validator)"
    fi
  done

  mkdir -p "$STATE_DIR"
  rm -rf "$LEDGER"
  local args=(
    --reset
    --quiet
    --ledger "$LEDGER"
    --rpc-port "$RPC_PORT"
    --faucet-port "$FAUCET_PORT"
    # Every validator binds a gossip port (default 8000) and picks its other ports from a shared range,
    # so two instances collide ("gossip_addr bind_to port 8000: Address already in use") unless each
    # gets its own.
    --gossip-port $((7000 + INSTANCE))
    --dynamic-port-range "$((20000 + 1000 * INSTANCE))-$((20999 + 1000 * INSTANCE))"
    --bind-address 127.0.0.1
    --limit-ledger-size 50000
  )
  local i
  for i in "${!PROGRAM_IDS[@]}"; do
    args+=(--bpf-program "${PROGRAM_IDS[$i]}" "${PROGRAM_SOS[$i]}")
  done

  echo "starting solana-test-validator (log: $LOG_FILE)"
  # nohup keeps it alive after the terminal closes; the cwd is the state dir so no stray test-ledger
  # directory appears in the caller's cwd. `exec` makes $! the validator's own pid.
  local started=$SECONDS
  (cd "$STATE_DIR" && exec nohup solana-test-validator "${args[@]}" >"$LOG_FILE" 2>&1 </dev/null) &
  echo $! >"$PID_FILE"

  local waited=0
  until is_healthy; do
    if ! pid_alive; then
      echo "--- last lines of $LOG_FILE ---" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      die "validator exited during startup"
    fi
    if [ "$waited" -ge "$HEALTH_TIMEOUT_SECS" ]; then
      cmd_stop >/dev/null 2>&1 || true
      die "validator not healthy after ${HEALTH_TIMEOUT_SECS}s (see $LOG_FILE)"
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # The first slots are not ready for transactions (fees are still stabilising): wait for slot 2.
  waited=0
  until [ "$(current_slot)" -ge 2 ] 2>/dev/null; do
    if [ "$waited" -ge "$((HEALTH_TIMEOUT_SECS / 2))" ]; then
      cmd_stop >/dev/null 2>&1 || true
      die "validator did not produce blocks within $((HEALTH_TIMEOUT_SECS / 2))s (see $LOG_FILE)"
    fi
    sleep 1
    waited=$((waited + 1))
  done

  for i in "${!PROGRAM_IDS[@]}"; do
    waited=0
    until program_executable "${PROGRAM_IDS[$i]}"; do
      if [ "$waited" -ge "$((HEALTH_TIMEOUT_SECS / 2))" ]; then
        cmd_stop >/dev/null 2>&1 || true
        die "program ${PROGRAM_NAMES[$i]} (${PROGRAM_IDS[$i]}) is not executable on the validator"
      fi
      sleep 1
      waited=$((waited + 1))
    done
  done

  echo "validator healthy, producing blocks, programs loaded after $((SECONDS - started))s (pid $(cat "$PID_FILE"))"
  cmd_status_programs
  cat <<EOF

  rpc      $RPC_URL
  ws       ws://127.0.0.1:$WS_PORT
  faucet   127.0.0.1:$FAUCET_PORT
  ledger   $LEDGER (wiped on every start)

Next:  eval "\$(AA_LOCALNET_INSTANCE=$INSTANCE scripts/localnet.sh env)" && pnpm --filter @agentauth-sol/demo bootstrap
Stop:  AA_LOCALNET_INSTANCE=$INSTANCE scripts/localnet.sh stop        (or: kill \$(cat $PID_FILE))
EOF
}

cmd_stop() {
  if ! pid_alive; then
    rm -f "$PID_FILE"
    if port_open "$RPC_PORT"; then
      echo "no validator of this script is running, but port $RPC_PORT is in use by another process (not touched)"
    else
      echo "not running"
    fi
    return 0
  fi
  local pid waited=0
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 20 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  rm -f "$PID_FILE"
  echo "stopped validator (pid $pid)"
}

cmd_status_programs() {
  local i state
  for i in "${!PROGRAM_IDS[@]}"; do
    if program_executable "${PROGRAM_IDS[$i]}"; then state="executable"; else state="MISSING"; fi
    printf '  %-14s %s  %s\n' "${PROGRAM_NAMES[$i]}" "${PROGRAM_IDS[$i]}" "$state"
  done
}

cmd_status() {
  if pid_alive; then
    echo "process: running (pid $(cat "$PID_FILE"))"
  else
    echo "process: not started by this script"
  fi
  if is_healthy; then
    echo "rpc:     healthy at $RPC_URL, slot $(current_slot)"
    cmd_status_programs
  else
    echo "rpc:     not reachable at $RPC_URL"
    return 1
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  reset)
    cmd_stop
    cmd_start
    ;;
  status) cmd_status ;;
  env)
    # Meant for: eval "$(scripts/localnet.sh env)". AA_DEMO_DIR keeps each instance's demo keys and
    # state.json apart (a new ledger has a new genesis, so state from another instance is stale).
    echo "export AA_RPC_URL=$RPC_URL"
    echo "export AA_WS_URL=ws://127.0.0.1:$WS_PORT"
    echo "export AA_DEMO_DIR=$DEMO_DIR"
    ;;
  *)
    echo "usage: ${0##*/} start|stop|reset|status|env" >&2
    exit 2
    ;;
esac
