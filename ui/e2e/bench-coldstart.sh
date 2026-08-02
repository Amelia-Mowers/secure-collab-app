#!/usr/bin/env bash
# Cold-start benchmark (ADR 0006, M1): how long until a workspace of N rows is
# usable, measured through the real client code.
#
#   HOMESERVER=http://localhost:8008 TIDEWORK_PASSWORD=... \
#   TIDEWORK_RECOVERY_KEY=... bash bench-coldstart.sh <user> [sizes...]
#
# WHY THE CLI IS THE INSTRUMENT: one invocation is exactly one full cycle —
# restore, sync_once, paginate the whole room, replay every update, render,
# exit. There is no UI and nothing cached between runs, so process wall-clock
# IS time-to-usable-state with nothing to subtract. See ADR 0006 for why the
# Node driver and Playwright are the wrong instruments for this particular
# question.
#
# REQUIRES A HOMESERVER WITH PASSWORD LOGIN. Prod disables it and --sso needs a
# browser per sandbox, so point this at the integration harness's Synapse.
set -u

HS="${HOMESERVER:-http://localhost:8008}"
USER_NAME="${1:?usage: bench-coldstart.sh <user> [sizes...]}"
shift
SIZES=("$@")
[ ${#SIZES[@]} -eq 0 ] && SIZES=(100 1000 5000)
# The table the corpus seeds. It comes from the template bench-corpus.mjs
# multiplies, so it is the template's table name, not one we chose.
TABLE="${BENCH_TABLE:-Projects}"

CLI="${TIDEWORK_CLI:-./target/release/tidework}"
ROOT="${BENCH_ROOT:-/tmp/tidework-bench}"
CORPUS="$ROOT/corpus"

[ -x "$CLI" ] || { echo "no CLI at $CLI (set TIDEWORK_CLI)" >&2; exit 1; }

# The corpus generator uses modern syntax, and a bare WSL shell has Node 12 —
# which fails to PARSE it, generates nothing, and leaves the failure to surface
# two steps later as "import failed". Check here, where the message is useful.
node_major=$(node --version 2>/dev/null | sed "s/^v//" | cut -d. -f1)
if [ -z "$node_major" ] || [ "$node_major" -lt 18 ] 2>/dev/null; then
  echo "node 18+ required (found "$(node --version 2>&1)"). Run inside the Nix dev shell." >&2
  exit 1
fi
: "${TIDEWORK_PASSWORD:?set TIDEWORK_PASSWORD}"
: "${TIDEWORK_RECOVERY_KEY:?set TIDEWORK_RECOVERY_KEY — login always verifies against backup}"

# Every measurement gets its own state dir. Without this the second run would
# reuse the first's SQLite store and stop being a cold start — which is the
# entire measurement. (TIDEWORK_DATA_DIR, not HOME: hijacking HOME also
# redirects every other tool this script touches.)
fresh_dir() { local d="$ROOT/state-$1"; rm -rf "$d"; mkdir -p "$d"; echo "$d"; }

# Wall-clock of one command, in milliseconds. `date +%s%N` rather than `time`,
# so the number is parseable rather than pretty.
timed() {
  local start end
  start=$(date +%s%N)
  "$@" >/dev/null 2>&1
  local rc=$?
  end=$(date +%s%N)
  echo $(( (end - start) / 1000000 ))
  return $rc
}

echo "instrument=cli  homeserver=$HS  cli=$CLI"
echo

for rows in "${SIZES[@]}"; do
  ws="bench-$rows"
  echo "=== $rows rows ==="

  # ── Seed. One login for the whole seeding phase, reused across chunks.
  seed_dir=$(fresh_dir "seed-$rows")
  export TIDEWORK_DATA_DIR="$seed_dir"
  if ! "$CLI" login --homeserver "$HS" --user "$USER_NAME" >/dev/null 2>&1; then
    echo "  login failed — is password auth enabled on $HS?" >&2
    exit 1
  fi
  "$CLI" workspace create "$ws" >/dev/null 2>&1

  node "$(dirname "$0")/bench-corpus.mjs" "$CORPUS/$rows" "$rows" 500 >/dev/null
  # Chunked because `import` sends one archive as ONE send_cell_batch, i.e. one
  # Matrix event — a few thousand rows in a single archive meets the 64 KiB
  # event limit.
  seed_ms=0
  for chunk in "$CORPUS/$rows"/chunk-*; do
    ms=$(timed "$CLI" import "$ws" "$chunk") || { echo "  import failed: $chunk" >&2; exit 1; }
    seed_ms=$((seed_ms + ms))
  done
  echo "  seed: ${seed_ms}ms across $(ls -d "$CORPUS/$rows"/chunk-* | wc -l) chunks"

  # ── Measure. A fresh state dir per sample, so every one is genuinely cold.
  samples=()
  for i in 1 2 3; do
    d=$(fresh_dir "cold-$rows-$i")
    export TIDEWORK_DATA_DIR="$d"
    "$CLI" login --homeserver "$HS" --user "$USER_NAME" >/dev/null 2>&1
    ms=$(timed "$CLI" table show "$ws" Bench) || { echo "  table show failed" >&2; exit 1; }
    samples+=("$ms")
    rm -rf "$d"
  done

  # Median of three: enough to reject one unlucky sample without pretending
  # three runs support a percentile.
  median=$(printf '%s\n' "${samples[@]}" | sort -n | sed -n 2p)
  echo "  cold start: ${samples[0]}ms ${samples[1]}ms ${samples[2]}ms  -> median ${median}ms"

  # ── The M2 comparison, free while we are here: run it AGAIN in the same
  #    state dir. Today this should be indistinguishable from a cold start,
  #    because the native path has no incremental load (ADR 0006). When that
  #    lands, this line is the number that should fall.
  d=$(fresh_dir "warm-$rows")
  export TIDEWORK_DATA_DIR="$d"
  "$CLI" login --homeserver "$HS" --user "$USER_NAME" >/dev/null 2>&1
  first=$(timed "$CLI" table show "$ws" Bench)
  second=$(timed "$CLI" table show "$ws" Bench)
  echo "  same-state-dir: first ${first}ms, second ${second}ms  (equal => no incremental load)"
  rm -rf "$d"
  echo
done

unset TIDEWORK_DATA_DIR
