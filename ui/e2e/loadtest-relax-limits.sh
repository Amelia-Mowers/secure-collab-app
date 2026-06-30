#!/usr/bin/env bash
# Temporarily relax Synapse rate limits on prod so a load test can find the
# server's RAW capacity (CPU/DB ceiling) instead of bouncing off the configured
# policy. Backs up the live rendered config and appends a clearly-marked block;
# `loadtest-restore-limits.sh` reverts it. Run ON the droplet.
#
# Why each limiter: rc_message gates cell-update sends; rc_invites.per_user
# (stock 0.003/s burst 5) + rc_joins_per_room (stock 1/s burst 10) otherwise
# make collab-mode setup (one host inviting ~100 accounts into one room)
# impossible.
set -eu
CFG=/srv/tidework/synapse/homeserver.yaml
SYN=tidework-synapse-1
MARK="# === LOAD TEST"

if grep -q "$MARK" "$CFG"; then
  echo "relax block already present; not appending again"
else
  cp -n "$CFG" "$CFG.preloadtest.bak"
  cat >> "$CFG" <<'YAML'

# === LOAD TEST (temporary; remove this block + restart synapse to revert) ===
rc_message:
  per_second: 1000
  burst_count: 5000
rc_joins:
  local:
    per_second: 1000
    burst_count: 5000
  remote:
    per_second: 1000
    burst_count: 5000
rc_joins_per_room:
  per_second: 1000
  burst_count: 5000
rc_invites:
  per_room:
    per_second: 1000
    burst_count: 5000
  per_user:
    per_second: 1000
    burst_count: 5000
  per_issuer:
    per_second: 1000
    burst_count: 5000
# === END LOAD TEST ===
YAML
  echo "appended relax block; original backed up at $CFG.preloadtest.bak"
fi

echo "restarting $SYN ..."
docker restart "$SYN" >/dev/null
echo "waiting for synapse ..."
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8008/_matrix/client/versions || true)
  if [ "$code" = "200" ]; then echo "synapse healthy (versions=200) after ${i}s"; exit 0; fi
  sleep 1
done
echo "WARNING: synapse did not return 200 within 40s" >&2
exit 1
