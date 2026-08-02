#!/usr/bin/env bash
# Provision N throwaway load-test accounts on the prod MAS and emit a JSON
# array [{username, token, device}] to stdout (mas-cli compatibility tokens —
# usable directly against the Synapse CS-API; no login/OAuth needed).
#
# Run ON the droplet:  bash loadtest-provision.sh [N] [PASSWORD] [PREFIX]
# PREFIX (default "loadtest") names the accounts <PREFIX>1..<PREFIX>N — use a
# fresh prefix to avoid colliding with a previous run's torn-down accounts.
# Pair with loadtest-prod.mjs (the driver) and loadtest-teardown.sh (cleanup).
set -u
N="${1:-100}"
PW="${2:-loadtest-pw-2026}"
PREFIX="${3:-loadtest}"
MAS=tidework-mas-1
CFG=/config/config.yaml

mas() { local sub="$1"; shift; docker exec "$MAS" mas-cli manage "$sub" -c "$CFG" "$@"; }

first_token=""
echo "["
first=1
for i in $(seq 1 "$N"); do
  u="${PREFIX}$i"
  mas register-user --yes --ignore-password-complexity -p "$PW" "$u" >/dev/null 2>&1
  out=$(mas issue-compatibility-token "$u" 2>&1)
  tok=$(printf '%s' "$out" | grep -oE 'mct_[A-Za-z0-9_]+' | head -1)
  dev=$(printf '%s' "$out" | grep -oE 'compat_session\.device=[A-Za-z0-9]+' | head -1 | cut -d= -f2)
  if [ -n "$tok" ]; then
    [ "$first" -eq 0 ] && printf ',\n'
    first=0
    [ -z "$first_token" ] && first_token="$tok"
    printf '  {"username":"%s","token":"%s","device":"%s"}' "$u" "$tok" "$dev"
  fi
done
printf '\n]\n'

# Prove the issued token actually authenticates, and fail LOUDLY if it does not.
#
# Re-running with a prefix that a previous teardown DEACTIVATED re-registers the
# accounts happily and issues tokens Synapse rejects as "Token is not active".
# The driver then reports 0 sends for every scenario, which reads like a result
# rather than a broken setup — that cost a whole suite run on 2026-08-01. A
# silent all-zero run is the worst output this script can produce, so check.
if [ -n "$first_token" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $first_token" \
    http://127.0.0.1:8008/_matrix/client/v3/account/whoami)
  if [ "$code" != "200" ]; then
    {
      echo "FATAL: the issued tokens do not work (HTTP $code)."
      echo "       The '$PREFIX' accounts were most likely deactivated by an"
      echo "       earlier teardown. Re-run with a FRESH prefix, e.g.:"
      echo "         bash loadtest-provision.sh $N '$PW' ${PREFIX}b"
    } >&2
    exit 1
  fi
  echo "token check: OK" >&2
fi
