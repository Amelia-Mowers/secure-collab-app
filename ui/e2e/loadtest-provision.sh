#!/usr/bin/env bash
# Provision N throwaway load-test accounts on the prod MAS and emit a JSON
# array [{username, token, device}] to stdout (mas-cli compatibility tokens —
# usable directly against the Synapse CS-API; no login/OAuth needed).
#
# Run ON the droplet:  bash loadtest-provision.sh [N] [PASSWORD]
# Pair with loadtest-prod.mjs (the driver) and loadtest-teardown.sh (cleanup).
set -u
N="${1:-100}"
PW="${2:-loadtest-pw-2026}"
MAS=tidework-mas-1
CFG=/config/config.yaml

mas() { local sub="$1"; shift; docker exec "$MAS" mas-cli manage "$sub" -c "$CFG" "$@"; }

echo "["
first=1
for i in $(seq 1 "$N"); do
  u="loadtest$i"
  mas register-user --yes --ignore-password-complexity -p "$PW" "$u" >/dev/null 2>&1
  out=$(mas issue-compatibility-token "$u" 2>&1)
  tok=$(printf '%s' "$out" | grep -oE 'mct_[A-Za-z0-9_]+' | head -1)
  dev=$(printf '%s' "$out" | grep -oE 'compat_session\.device=[A-Za-z0-9]+' | head -1 | cut -d= -f2)
  if [ -n "$tok" ]; then
    [ "$first" -eq 0 ] && printf ',\n'
    first=0
    printf '  {"username":"%s","token":"%s","device":"%s"}' "$u" "$tok" "$dev"
  fi
done
printf '\n]\n'
