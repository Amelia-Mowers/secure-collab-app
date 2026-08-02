#!/usr/bin/env bash
# Capacity + collab load-test suite, run ON the droplet against Synapse directly
# (127.0.0.1:8008). For each scenario it samples the synapse container's CPU/mem
# while the driver runs, then prints the driver's JSON result + the peak sample.
# Long-running (~7 min) — launch backgrounded and read /tmp/lt-suite.log.
set -u
# Every Synapse process, not just the old monolith name. Once workers were
# deployed this sampled one of four containers and, because `docker stats` fails
# on an unknown name, printed an EMPTY peak line for every scenario — so a run
# could look complete while reporting no CPU at all. Discovered by name so a new
# worker is included the day it is added.
SYN_PROCS=$(docker ps --format '{{.Names}}' | grep -E '^tidework-synapse' | sort | paste -sd' ' -)
SYN=${SYN_PROCS%% *}
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
      # shellcheck disable=SC2086
      docker stats --no-stream --format '{{.Name}}={{.CPUPerc}}' $SYN_PROCS 2>/dev/null | paste -sd' ' - >> "$statf"
      echo >> "$statf"
      sleep 1
    done ) &
  local spid=$!
  local extra=""
  [ -n "$room" ] && extra="--room $room"
  # shellcheck disable=SC2086
  $DRIVER --mode "$mode" --accounts "$acct" --rate "$rate" --duration "$dur" $extra 2>/dev/null
  kill "$spid" 2>/dev/null
  echo "-- peak CPU per synapse process, and combined --"
  awk '{ tot = 0
         for (i = 1; i <= NF; i++) {
           split($i, kv, "=")
           gsub(/%/, "", kv[2])
           if (kv[2] + 0 > peak[kv[1]]) peak[kv[1]] = kv[2] + 0
           tot += kv[2] + 0
         }
         if (tot > combined) combined = tot }
       END { out = ""
             for (k in peak) out = out k "=" int(peak[k] + 0.5) "% "
             print out "| combined=" int(combined + 0.5) "%" }' "$statf"
  rm -f "$statf"
}

echo "=== TIDEWORK LOAD-TEST SUITE  start ==="
echo "synapse processes: $SYN_PROCS"
# shellcheck disable=SC2086
docker stats --no-stream --format 'baseline {{.Name}}: {{.CPUPerc}} {{.MemUsage}}' $SYN_PROCS

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
