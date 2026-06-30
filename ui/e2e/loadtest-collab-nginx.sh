#!/usr/bin/env bash
# Collab propagation with /sync correctly routed THROUGH nginx to the sync
# workers (HOMESERVER = public URL, not :8008 — capacity mode never calls /sync,
# so only this collab path exercises the workers). Hits the public hostname from
# the droplet (hairpin) so there is no client RTT, making the numbers directly
# comparable to loadtest-suite.sh's :8008 collab scenarios. Samples per-process
# CPU so you can see the sync workers actually take load. Run ON the droplet.
set -u
HS="${HOMESERVER:-https://matrix.tidework.io}"
PROCS="tidework-synapse-1 tidework-synapse-sync1-1 tidework-synapse-sync2-1"
DRIVER="docker run --rm --network host -v /tmp:/work -e LOADTEST_ACCOUNTS=/work/loadtest-accounts.json -e HOMESERVER=$HS node:20-alpine node /work/loadtest-prod.mjs"

run() {
  local label="$1" acct="$2" rate="$3" dur="$4"
  echo; echo "#### $label  (collab accounts=$acct rate=$rate dur=$dur via $HS) ####"
  local f=/tmp/lt-cn.$$; : > "$f"
  ( while :; do docker stats --no-stream --format "{{.Name}} {{.CPUPerc}}" $PROCS 2>/dev/null | tr "\n" " "; echo; sleep 1; done ) > "$f" &
  local sp=$!
  # shellcheck disable=SC2086
  $DRIVER --mode collab --accounts "$acct" --rate "$rate" --duration "$dur" 2>/dev/null
  kill "$sp" 2>/dev/null
  echo "-- per-process CPU peak (main / sync1 / sync2 / combined of 200%) --"
  awk '{gsub(/%/,""); if($2+0>m)m=$2; if($4+0>a)a=$4; if($6+0>b)b=$6; if($2+$4+$6+0>t)t=$2+$4+$6} END{printf "main=%.0f%% sync1=%.0f%% sync2=%.0f%% combined=%.0f%%\n",m,a,b,t}' "$f"
  rm -f "$f"
}

echo "=== COLLAB VIA NGINX (workers serve /sync) ==="
run "CN1 collab 25@0.5" 25 0.5 30
run "CN2 collab 50@0.5" 50 0.5 30
echo; echo "=== DONE ==="
