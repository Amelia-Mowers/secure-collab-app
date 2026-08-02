set -u
cd /mnt/c/dev/secure-collab-app
CLI="$HOME/tw-target-check/release/tidework"
export TIDEWORK_CLI="$CLI" HOMESERVER=http://localhost:8448
export TIDEWORK_PASSWORD=bench-pw-2026 BENCH_USER=iv1
out=$(bash ui/e2e/bench-synapse.sh start 2>&1)
KEY=$(printf '%s' "$out" | grep -oP "TIDEWORK_RECOVERY_KEY='\K[^']+" | head -1)
[ -z "$KEY" ] && { printf '%s\n' "$out" | tail -3; exit 1; }
export TIDEWORK_RECOVERY_KEY="$KEY"

echo "########## INTERVAL TEST ##########"
export TIDEWORK_DATA_DIR=/tmp/iv-seed; rm -rf "$TIDEWORK_DATA_DIR"
"$CLI" login --homeserver $HOMESERVER --user iv1 >/dev/null 2>&1
"$CLI" workspace create iv-ws >/dev/null 2>&1
node ui/e2e/bench-corpus.mjs /tmp/iv-corpus 1000 500 >/dev/null
for c in /tmp/iv-corpus/chunk-*; do "$CLI" import iv-ws "$c" >/dev/null 2>&1; done
# 7000 cells -> coverage ~438 events; seed well past it in one burst.
"$CLI" seed-edits iv-ws Projects 3000 >/dev/null 2>&1
burst_end=$(date +%s)
echo "burst done; walking at intervals"
export TIDEWORK_WALK_STATS=1
prev=0
for t in 0 15 30 60 120 300 600; do
  now=$(date +%s); wait=$(( burst_end + t - now ))
  [ "$wait" -gt 0 ] && sleep "$wait"
  line=$("$CLI" --cold table show iv-ws Projects 2>&1 >/dev/null | grep "^walk:" | tail -1)
  echo "  t+${t}s  $line"
done
unset TIDEWORK_WALK_STATS

echo
echo "########## SWEEP (with settle) ##########"
export BENCH_ROOT=/tmp/sweep3-bench BENCH_USER=iv1
bash ui/e2e/bench-coldstart.sh iv1 100 1000 5000 10000
