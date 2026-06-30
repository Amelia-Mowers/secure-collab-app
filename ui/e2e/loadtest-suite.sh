#!/usr/bin/env bash
# Capacity + collab load-test suite, run ON the droplet against Synapse directly
# (127.0.0.1:8008). For each scenario it samples the synapse container's CPU/mem
# while the driver runs, then prints the driver's JSON result + the peak sample.
# Long-running (~7 min) — launch backgrounded and read /tmp/lt-suite.log.
set -u
SYN=tidework-synapse-1
DRIVER="docker run --rm --network host -v /tmp:/work -e LOADTEST_ACCOUNTS=/work/loadtest-accounts.json -e HOMESERVER=http://127.0.0.1:8008 node:20-alpine node /work/loadtest-prod.mjs"

run() {
  local label="$1" mode="$2" acct="$3" rate="$4" dur="$5" room="${6:-}"
  echo
  echo "############################################################"
  echo "## $label"
  echo "## mode=$mode accounts=$acct rate=$rate/s/acct duration=${dur}s aggregate_target=$(awk "BEGIN{print $acct*$rate}")/s"
  echo "############################################################"
  local statf="/tmp/lt-stats.$$"
  : > "$statf"
  ( while :; do
      docker stats --no-stream --format '{{.CPUPerc}} mem={{.MemUsage}}' "$SYN" 2>/dev/null >> "$statf"
      sleep 1
    done ) &
  local spid=$!
  local extra=""
  [ -n "$room" ] && extra="--room $room"
  # shellcheck disable=SC2086
  $DRIVER --mode "$mode" --accounts "$acct" --rate "$rate" --duration "$dur" $extra 2>/dev/null
  kill "$spid" 2>/dev/null
  echo "-- synapse peak CPU during scenario --"
  sort -t% -k1 -nr "$statf" 2>/dev/null | head -1
  rm -f "$statf"
}

echo "=== TIDEWORK LOAD-TEST SUITE  start ==="
docker stats --no-stream --format 'baseline synapse: {{.CPUPerc}} {{.MemUsage}}' "$SYN"

run "S1  capacity 25 @1/s   (25/s aggregate, low concurrency)"  capacity 25  1   25
run "S2  capacity 50 @0.5/s (25/s aggregate, 2x concurrency)"   capacity 50  0.5 25
run "S3  capacity 50 @1/s   (50/s aggregate)"                   capacity 50  1   25
run "S4  capacity 100 @1/s  (100/s aggregate)"                  capacity 100 1   25
run "S5  capacity 100 @2/s  (200/s aggregate target)"           capacity 100 2   25
run "S6  capacity 100 @4/s  (400/s aggregate target / push)"    capacity 100 4   20
run "S7  collab 25 @0.5/s   (propagation latency)"              collab   25  0.5 30
run "S8  collab 50 @0.5/s   (propagation latency)"              collab   50  0.5 30

echo
echo "=== SUITE COMPLETE ==="
