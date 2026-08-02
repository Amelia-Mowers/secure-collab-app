set -u
cd /mnt/c/dev/secure-collab-app
CLI="$HOME/tw-target-check/release/tidework"
export TIDEWORK_CLI="$CLI" HOMESERVER=http://localhost:8448 TIDEWORK_DATA_DIR=/tmp/tenk

# A separate room, because the point is a 10k-row workspace's shape, not a
# room that grew through three different corpus sizes.
while pgrep -f "bench-seed-edits" >/dev/null; do sleep 15; done
"$CLI" workspace create tenk-ws >/dev/null 2>&1
node ui/e2e/bench-corpus.mjs /tmp/tenk-corpus 10000 500 >/dev/null
echo "== chunks: $(ls -d /tmp/tenk-corpus/chunk-* | wc -l) =="
s=$(date +%s)
for c in /tmp/tenk-corpus/chunk-*; do "$CLI" import tenk-ws "$c" >/dev/null 2>&1; done
echo "== imported 10k rows in $(( $(date +%s) - s ))s =="

# Coverage needs ~cells/16 events. 10k x 7 = ~70k cells -> ~4400 events.
bash ui/e2e/bench-seed-edits.sh tenk-ws Projects 5000 2>&1 | tail -1

timed() { local a b; a=$(date +%s%N); "$@" >/dev/null 2>&1; b=$(date +%s%N); echo $(( (b-a)/1000000 )); }
export TIDEWORK_WALK_STATS=1
echo "== stats =="
"$CLI" --cold table show tenk-ws Projects 2>&1 >/dev/null | tail -1
TIDEWORK_UNBOUNDED_WALK=1 "$CLI" --cold table show tenk-ws Projects 2>&1 >/dev/null | tail -1
"$CLI" table show tenk-ws Projects 2>&1 >/dev/null | tail -1
unset TIDEWORK_WALK_STATS
echo "== timings, ms =="
b=(); for i in 1 2 3; do b+=("$(timed "$CLI" --cold table show tenk-ws Projects)"); done
u=(); for i in 1 2 3; do u+=("$(TIDEWORK_UNBOUNDED_WALK=1 timed "$CLI" --cold table show tenk-ws Projects)"); done
w=(); for i in 1 2 3; do w+=("$(timed "$CLI" table show tenk-ws Projects)"); done
echo "bounded cold:   ${b[*]}"
echo "unbounded cold: ${u[*]}"
echo "warm:           ${w[*]}"
