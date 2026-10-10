#!/usr/bin/env bash
# AgentAuth devnet deployment runbook, as a script. DRY-RUN BY DEFAULT.
#
#   scripts/devnet-deploy.sh                     read-only checks + the exact commands that WOULD run. Sends nothing.
#   scripts/devnet-deploy.sh --execute ...       really deploy, after an interactive typed confirmation.
#   scripts/devnet-deploy.sh --execute --burn-authority ...
#                                                additionally make the deployed programs NON-UPGRADEABLE FOREVER,
#                                                after a second typed confirmation. IRREVERSIBLE.
#
# What it does in dry-run mode (all read-only; the only network traffic is RPC reads on devnet):
#   * prints `solana config`, the payer / upgrade-authority ADDRESSES and their devnet balances
#   * checks that each .so exists and prints its size and sha256
#   * checks that each program id equals the address of keys/<name>-keypair.json (`solana address -k`; this script
#     never reads, copies or prints a keypair file, it only hands the PATH to the solana CLI)
#   * `solana program show` for each id: current upgrade authority, last deploy slot, data length
#   * `solana program dump` of the current on-chain program, sha256 of the first <local size> bytes compared with the local build
#   * refuses to continue past the checks if the relay .so is the test-amm build
#
# Options:
#   --programs LIST          comma list of: core,relay,mock_amm,gated_example   (default: core,relay)
#   --upgrade-authority PATH keypair FILE of the CURRENT upgrade authority (needed to upgrade the existing core program;
#                            default for new programs: the payer). Only the path is used.
#   --payer PATH             fee payer keypair FILE (default: the keypair in `solana config`)
#   --rpc URL                default https://api.devnet.solana.com   (anything that is not devnet-looking is refused)
#   --target-dir DIR         where scripts/build-all.sh put the programs (default $CARGO_TARGET_DIR or ./target)
#   --keys-dir DIR           default ./keys
#   --execute                actually send transactions (typed confirmation required, TTY required)
#   --burn-authority         after deploying, set the upgrade authority to none (second typed confirmation). Requires --execute.
#   -h, --help
#
# Never run with a mainnet RPC: the script refuses. Unaudited prototype.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="https://api.devnet.solana.com"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
KEYS="$ROOT/keys"
PAYER=""
UPAUTH=""
PROGRAMS="core,relay"
EXECUTE=0
BURN=0

CORE_ID="AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if"
RELAY_ID="33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6"
MOCK_AMM_ID="6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw"
GATED_ID="CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ"
OBSERVED_CORE_AUTHORITY="8SRwaR9wr4n7a3tCWMgejAV5DAJnky8NXQTS8qWgsEyC"

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }
hdr() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
ok() { printf 'ok:   %s\n' "$*"; }
WARNINGS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --programs) PROGRAMS="${2:?}"; shift 2 ;;
    --upgrade-authority) UPAUTH="${2:?}"; shift 2 ;;
    --payer) PAYER="${2:?}"; shift 2 ;;
    --rpc) RPC="${2:?}"; shift 2 ;;
    --target-dir) TARGET="${2:?}"; shift 2 ;;
    --keys-dir) KEYS="${2:?}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --burn-authority) BURN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

case "$RPC" in
  *mainnet*) die "refusing a mainnet RPC ($RPC). This runbook is devnet only." ;;
  *devnet* | http://127.0.0.1* | http://localhost*) ;;
  *) die "RPC '$RPC' does not look like devnet. Refusing." ;;
esac
[ "$BURN" = 1 ] && [ "$EXECUTE" = 0 ] && die "--burn-authority only makes sense with --execute (the dry run prints the command anyway)"
command -v solana >/dev/null 2>&1 || die "solana CLI not found"
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || die "need shasum or sha256sum"
getv() { local n="$1_$2"; printf %s "${!n:-}"; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# --- program table: name|program id|.so path|keypair file (for first deploy) ---
so_of() {
  case "$1" in
    core) echo "$TARGET/deploy/agent_auth.so" ;;
    relay) echo "$TARGET/deploy/agent_auth_relay.so" ;;
    mock_amm) echo "$TARGET/deploy/mock_amm.so" ;;
    gated_example) echo "$TARGET/deploy/gated_example.so" ;;
  esac
}
id_of() {
  case "$1" in
    core) echo "$CORE_ID" ;; relay) echo "$RELAY_ID" ;; mock_amm) echo "$MOCK_AMM_ID" ;; gated_example) echo "$GATED_ID" ;;
  esac
}
key_of() {
  case "$1" in
    core) echo "" ;; # the original core deploy keypair is NOT in keys/; upgrades only need the program id
    relay) echo "$KEYS/agent_auth_relay-keypair.json" ;;
    mock_amm) echo "$KEYS/mock_amm-keypair.json" ;;
    gated_example) echo "$KEYS/gated_example-keypair.json" ;;
  esac
}

IFS=',' read -r -a SELECTED <<<"$PROGRAMS"
for p in "${SELECTED[@]}"; do
  case "$p" in core | relay | mock_amm | gated_example) ;; *) die "unknown program '$p'" ;; esac
done

SOLANA=(solana -u "$RPC")

hdr "mode"
if [ "$EXECUTE" = 1 ]; then say "EXECUTE: will send devnet transactions after confirmation"; else say "DRY RUN: nothing is sent. Re-run with --execute to deploy."; fi
say "rpc: $RPC"
say "programs: $PROGRAMS"
say "target dir: $TARGET"

hdr "solana config (read-only)"
solana config get 2>&1 | sed 's/^/  /'
[ -z "$PAYER" ] && PAYER="$(solana config get 2>/dev/null | awk '/Keypair Path/ {print $3}')"
[ -n "$PAYER" ] && [ -f "$PAYER" ] || warn "payer keypair file not found: '${PAYER:-unset}' (use --payer PATH)"
PAYER_ADDR=""
[ -f "$PAYER" ] && PAYER_ADDR="$(solana address -k "$PAYER" 2>/dev/null)"
UPAUTH_ADDR=""
if [ -n "$UPAUTH" ]; then
  [ -f "$UPAUTH" ] || warn "upgrade-authority keypair file not found: $UPAUTH"
  [ -f "$UPAUTH" ] && UPAUTH_ADDR="$(solana address -k "$UPAUTH" 2>/dev/null)"
fi

hdr "signers and balances (addresses only; keypair files are never read by this script)"
if [ -n "$PAYER_ADDR" ]; then
  say "  payer              $PAYER_ADDR   $("${SOLANA[@]}" balance "$PAYER_ADDR" 2>&1 | head -1)"
fi
if [ -n "$UPAUTH_ADDR" ]; then
  say "  upgrade authority  $UPAUTH_ADDR   $("${SOLANA[@]}" balance "$UPAUTH_ADDR" 2>&1 | head -1)"
else
  say "  upgrade authority  (not given: new programs will use the payer; the EXISTING core needs --upgrade-authority)"
fi
say "  devnet faucet limits are small and rate limited; a core upgrade needs about the rent difference only, a first relay deploy needs rent for ~2x the .so size plus fees."
for p in "${SELECTED[@]}"; do
  so="$(so_of "$p")"
  if [ -f "$so" ]; then
    sz="$(wc -c <"$so" | tr -d ' ')"
    say "  rent-exempt minimum for $p ($sz B .so, programdata about $((sz + 45)) B): $("${SOLANA[@]}" rent "$((sz + 45))" 2>&1 | grep -i 'rent-exempt' | head -1)"
  fi
done

hdr "local artifacts"
for p in "${SELECTED[@]}"; do
  so="$(so_of "$p")"
  if [ ! -f "$so" ]; then
    warn "$p: $so does not exist. Run scripts/build-all.sh first."
    continue
  fi
  printf -v "LOCAL_SHA_$p" %s "$(sha256 "$so")"
  printf -v "LOCAL_SZ_$p" %s "$(wc -c <"$so" | tr -d ' ')"
  say "  $p  $(getv LOCAL_SHA "$p")  $(getv LOCAL_SZ "$p") B  $so"
done
# the localnet relay build (test-amm) must never be deployed to devnet
LOCALNET_RELAY="$TARGET/deploy-localnet/agent_auth_relay.so"
if [ -f "$LOCALNET_RELAY" ] && [ -n "$(getv LOCAL_SHA relay)" ]; then
  if [ "$(sha256 "$LOCALNET_RELAY")" = "$(getv LOCAL_SHA relay)" ]; then
    die "deploy/agent_auth_relay.so is byte-identical to the test-amm localnet build. Refusing: rebuild with scripts/build-all.sh (default features)."
  fi
  ok "relay .so differs from the test-amm localnet build (good: the mock AMM is not allowlisted)"
fi

hdr "program ids vs keys/*-keypair.json (public addresses only)"
for p in "${SELECTED[@]}"; do
  id="$(id_of "$p")"
  kf="$(key_of "$p")"
  if [ -z "$kf" ]; then
    say "  $p  $id  (no keypair in keys/: this program already exists on devnet and is upgraded by id; needs its upgrade authority)"
  elif [ -f "$kf" ]; then
    addr="$(solana address -k "$kf" 2>/dev/null)"
    if [ "$addr" = "$id" ]; then ok "$p  keys file address == $id"; else warn "$p  keys file address $addr != expected $id"; fi
  else
    warn "$p  keypair file missing: $kf (needed for the FIRST deploy of this program id)"
  fi
done

hdr "on-chain state (read-only: solana program show / dump)"
DUMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/aa-devnet-dump.XXXXXX")"
trap 'rm -rf "$DUMPDIR"' EXIT
for p in "${SELECTED[@]}"; do
  id="$(id_of "$p")"
  say "-- $p $id"
  if out="$("${SOLANA[@]}" program show "$id" 2>&1)"; then
    printf -v "EXISTS_$p" %s 1
    echo "$out" | sed 's/^/     /'
    auth="$(echo "$out" | awk '/^Authority:/ {print $2}')"
    if [ "$auth" = "none" ]; then
      warn "$p: upgrade authority is NONE on devnet. The program is immutable; it cannot be upgraded."
    elif [ -n "$UPAUTH_ADDR" ] && [ -n "$auth" ] && [ "$auth" != "$UPAUTH_ADDR" ]; then
      warn "$p: on-chain authority $auth != the --upgrade-authority address $UPAUTH_ADDR. The upgrade will fail."
    elif [ -z "$UPAUTH_ADDR" ] && [ "$p" = "core" ]; then
      say "     note: authority $auth must sign the upgrade; pass --upgrade-authority PATH (observed 2026-10-11: $OBSERVED_CORE_AUTHORITY)"
    fi
    if "${SOLANA[@]}" program dump "$id" "$DUMPDIR/$p.so" >/dev/null 2>&1 && [ -n "$(getv LOCAL_SZ "$p")" ]; then
      onchain="$(head -c "$(getv LOCAL_SZ "$p")" "$DUMPDIR/$p.so" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)"
      say "     on-chain sha256 (first $(getv LOCAL_SZ "$p") B): $onchain"
      say "     local    sha256:                     $(getv LOCAL_SHA "$p")"
      if [ "$onchain" = "$(getv LOCAL_SHA "$p")" ]; then ok "$p: on-chain program already equals the local build"; else say "     DIFFERENT: a deploy would change the on-chain program"; fi
    else
      say "     (could not dump or no local build to compare)"
    fi
  else
    printf -v "EXISTS_$p" %s 0
    say "     not deployed on this cluster ($(echo "$out" | head -1))"
  fi
done

# --- build the command list ---
CMDS=()
DEPLOYED=()
for p in "${SELECTED[@]}"; do
  id="$(id_of "$p")"
  so="$(so_of "$p")"
  kf="$(key_of "$p")"
  auth_args=()
  [ -n "$UPAUTH" ] && auth_args=(--upgrade-authority "$UPAUTH")
  if [ "$(getv EXISTS "$p")" = 1 ]; then
    [ "$p" = core ] && [ -z "$UPAUTH" ] && warn "core: no --upgrade-authority given; the payer will be tried as the authority"
    CMDS+=("solana -u $RPC program deploy $so --program-id $id --keypair ${PAYER:-<payer>} ${auth_args[*]:-}")
  else
    [ -z "$kf" ] && { warn "$p: not on devnet and no keypair in keys/: cannot do a first deploy of $id"; continue; }
    CMDS+=("solana -u $RPC program deploy $so --program-id $kf --keypair ${PAYER:-<payer>} ${auth_args[*]:-}")
  fi
  DEPLOYED+=("$p")
done
BURNCMDS=()
for p in ${DEPLOYED[@]+"${DEPLOYED[@]}"}; do
  id="$(id_of "$p")"
  burn_auth="${UPAUTH:-${PAYER:-<payer>}}"
  BURNCMDS+=("solana -u $RPC program set-upgrade-authority $id --final --upgrade-authority $burn_auth --keypair ${PAYER:-<payer>}")
done

hdr "commands that would run (deploy)"
for c in ${CMDS[@]+"${CMDS[@]}"}; do say "  $c"; done
hdr "verification afterwards (read-only)"
for p in ${DEPLOYED[@]+"${DEPLOYED[@]}"}; do
  say "  solana -u $RPC program show $(id_of "$p")"
done
hdr "optional, IRREVERSIBLE: make the programs non-upgradeable (only with --execute --burn-authority)"
for c in ${BURNCMDS[@]+"${BURNCMDS[@]}"}; do say "  $c"; done
say "  A burned upgrade authority cannot be restored. Bugs found later cannot be fixed in place; you would need a NEW program id."
say "  The alternative is to move the authority to a multisig (solana program set-upgrade-authority <id> --new-upgrade-authority <multisig vault>), see docs/DEPLOY-DEVNET.md section 6."

hdr "summary"
say "warnings: $WARNINGS"
if [ "$EXECUTE" = 0 ]; then
  say "DRY RUN complete. Nothing was sent, no key was read or printed."
  exit 0
fi

# ------------------------------- EXECUTE PATH -------------------------------
[ -t 0 ] || die "--execute needs an interactive terminal (typed confirmation). Nothing was sent."
[ "$WARNINGS" -gt 0 ] && say "There were $WARNINGS warning(s) above. Read them before confirming."
[ "${#CMDS[@]}" -gt 0 ] || die "nothing to deploy"
say
say "You are about to SEND transactions to $RPC and deploy/upgrade: ${DEPLOYED[*]:-}"
say "Type exactly:  deploy to devnet"
read -r reply
[ "$reply" = "deploy to devnet" ] || die "confirmation did not match. Nothing was sent."

for c in ${CMDS[@]+"${CMDS[@]}"}; do
  say "+ $c"
  # shellcheck disable=SC2086
  eval "$c" || die "deploy command failed; stopping. Check 'solana program show' before retrying."
done
hdr "post-deploy state"
for p in ${DEPLOYED[@]+"${DEPLOYED[@]}"}; do "${SOLANA[@]}" program show "$(id_of "$p")" 2>&1 | sed 's/^/  /'; done

if [ "$BURN" = 1 ]; then
  say
  say "################################################################################"
  say "#  IRREVERSIBLE: this makes these programs NON-UPGRADEABLE FOREVER:            #"
  say "#  ${DEPLOYED[*]:-}"
  say "#  Nobody, including you, can ever fix a bug in them in place.                 #"
  say "################################################################################"
  say "Type exactly:  burn upgrade authority forever"
  read -r reply2
  [ "$reply2" = "burn upgrade authority forever" ] || die "second confirmation did not match. Programs were deployed but NOT burned."
  for c in ${BURNCMDS[@]+"${BURNCMDS[@]}"}; do
    say "+ $c"
    eval "$c" || die "burn command failed; check 'solana program show'."
  done
  hdr "post-burn state (screenshot this: Authority must read 'none')"
  for p in ${DEPLOYED[@]+"${DEPLOYED[@]}"}; do "${SOLANA[@]}" program show "$(id_of "$p")" 2>&1 | sed 's/^/  /'; done
fi
say "done."
