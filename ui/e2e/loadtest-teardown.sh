#!/usr/bin/env bash
# Remove the <PREFIX>N accounts created by loadtest-provision.sh. Run ON the
# droplet AFTER load testing.  Usage: loadtest-teardown.sh [N] [PREFIX]
# (N defaults to 100, PREFIX to "loadtest" — pass the prefix you provisioned).
#
#   - Best-effort: full deactivate+erase via the Synapse admin API (removes the
#     user from all rooms and frees data). The admin token is read from the
#     rendered config server-side and never printed.
#   - Guaranteed: MAS kill-sessions + lock-user (revokes the mct_ tokens and
#     disables the account) even if the admin API path is unavailable.
set -u
N="${1:-100}"
PREFIX="${2:-loadtest}"
MAS=tidework-mas-1
CFG=/config/config.yaml
SYN_CFG=/srv/tidework/synapse/homeserver.yaml

ADMIN_TOKEN=$(grep -E '^[[:space:]]*admin_token:' "$SYN_CFG" 2>/dev/null \
  | head -1 | sed -E 's/.*admin_token:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/')

mas() { local sub="$1"; shift; docker exec "$MAS" mas-cli manage "$sub" -c "$CFG" "$@"; }

deactivated=0; locked=0; fail=0
for i in $(seq 1 "$N"); do
  u="${PREFIX}$i"
  uid="@$u:tidework.io"
  if [ -n "$ADMIN_TOKEN" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d '{"erase": true}' \
      "http://127.0.0.1:8008/_synapse/admin/v1/deactivate/$uid")
    [ "$code" = "200" ] && deactivated=$((deactivated+1))
  fi
  mas kill-sessions "$u" >/dev/null 2>&1
  if mas lock-user "$u" >/dev/null 2>&1; then locked=$((locked+1)); else fail=$((fail+1)); fi
done
echo "teardown: deactivated(admin-api 200)=$deactivated  locked(mas)=$locked  lock-fail=$fail  (of $N)"
