#!/usr/bin/env bash
# Revert loadtest-relax-limits.sh: restore the original Synapse config from the
# backup and restart. Run ON the droplet AFTER load testing.
set -eu
CFG=/srv/tidework/synapse/homeserver.yaml
SYN=tidework-synapse-1

if [ ! -f "$CFG.preloadtest.bak" ]; then
  echo "NO BACKUP at $CFG.preloadtest.bak — refusing to guess; check $CFG by hand" >&2
  exit 1
fi
cp "$CFG.preloadtest.bak" "$CFG"
echo "restored original config from backup"
echo "restarting $SYN ..."
docker restart "$SYN" >/dev/null
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8008/_matrix/client/versions || true)
  if [ "$code" = "200" ]; then echo "synapse healthy (versions=200) after ${i}s"; exit 0; fi
  sleep 1
done
echo "WARNING: synapse did not return 200 within 40s" >&2
exit 1
