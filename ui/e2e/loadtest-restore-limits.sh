#!/usr/bin/env bash
# Revert loadtest-relax-limits.sh: restore the original Synapse config from the
# backup and restart. Run ON the droplet AFTER load testing.
set -eu
CFG=/srv/tidework/synapse/homeserver.yaml
# Every Synapse process shares this config file, so every one of them has to be
# restarted to pick it up. Restarting only the monolith left the workers running
# the OLD limits — which for a config change whose entire purpose is to lift a
# limit means the change may simply not be in force where it matters.
SYN=$(docker ps --format '{{.Names}}' | grep -E '^tidework-synapse' | sort | paste -sd' ' -)

if [ ! -f "$CFG.preloadtest.bak" ]; then
  echo "NO BACKUP at $CFG.preloadtest.bak — refusing to guess; check $CFG by hand" >&2
  exit 1
fi
cp "$CFG.preloadtest.bak" "$CFG"
echo "restored original config from backup"
echo "restarting: $SYN"
# shellcheck disable=SC2086
docker restart $SYN >/dev/null
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8008/_matrix/client/versions || true)
  if [ "$code" = "200" ]; then echo "synapse healthy (versions=200) after ${i}s"; exit 0; fi
  sleep 1
done
echo "WARNING: synapse did not return 200 within 40s" >&2
exit 1
