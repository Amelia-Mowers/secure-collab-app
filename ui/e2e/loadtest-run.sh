#!/usr/bin/env bash
# Run the load-test driver ON the droplet inside a throwaway node container,
# hitting Synapse directly at 127.0.0.1:8008 (no nginx, no TLS, no client RTT)
# for clean server-capacity numbers. The driver + accounts JSON live in /tmp,
# mounted into the container at /work.
#
# Usage: bash loadtest-run.sh <mode> <accounts> <rate> <duration> [room]
set -u
MODE="${1:?mode (capacity|collab)}"
ACCT="${2:?accounts}"
RATE="${3:?rate per account}"
DUR="${4:?duration seconds}"
ROOM="${5:-}"
EXTRA=""
[ -n "$ROOM" ] && EXTRA="--room $ROOM"

docker run --rm --network host \
  -v /tmp:/work \
  -e LOADTEST_ACCOUNTS=/work/loadtest-accounts.json \
  -e HOMESERVER=http://127.0.0.1:8008 \
  node:20-alpine \
  node /work/loadtest-prod.mjs --mode "$MODE" --accounts "$ACCT" --rate "$RATE" --duration "$DUR" $EXTRA
