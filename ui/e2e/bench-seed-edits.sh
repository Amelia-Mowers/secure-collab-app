#!/usr/bin/env bash
# Seed a workspace the way a PERSON does: one edit at a time, through
# `tidework row set`, so the room accumulates the event shape a real workspace
# has — and so compaction bumps actually land in it.
#
#   bash bench-seed-edits.sh <workspace> <table> <edits>
#
# WHY THIS EXISTS. The other corpus is built with `import`, which packs ~35 rows
# into a single event and never bumps (it uses `update_cell_returning`). A room
# seeded that way has ~1/250th the events of a hand-edited one and contains zero
# compaction bumps, so every "after compaction" figure measured against it is
# arithmetic rather than observation.
#
# SLOW BY CONSTRUCTION, and that is the point: each `row set` is its own process
# doing its own load, which is exactly the cost being measured. Budget roughly
# one edit per second and seed hundreds, not thousands.
set -u

WS="${1:?usage: bench-seed-edits.sh <workspace> <table> <edits>}"
TABLE="${2:?}"
EDITS="${3:-200}"
CLI="${TIDEWORK_CLI:-./target/release/tidework}"
HS="${HOMESERVER:?set HOMESERVER}"

[ -x "$CLI" ] || { echo "no CLI at $CLI (set TIDEWORK_CLI)" >&2; exit 1; }

# The rows to edit must already exist; this rewrites cells rather than creating
# rows, because it is the WRITE path being exercised, not the create path.
rows=$("$CLI" table show "$WS" "$TABLE" 2>/dev/null | awk '/^row_/ {print $1}')
count=$(printf '%s\n' "$rows" | grep -c . || true)
[ "$count" -gt 0 ] || { echo "no rows in $WS/$TABLE — seed with import first" >&2; exit 1; }
echo "editing $EDITS cells across $count rows"

start=$(date +%s)
i=0
while [ "$i" -lt "$EDITS" ]; do
  row=$(printf '%s\n' "$rows" | sed -n "$(( (i % count) + 1 ))p")
  # Every edit is its own process — one Workspace, one write, one event. The
  # per-write bumps ride along with it, which is the whole reason for this
  # script.
  "$CLI" row set "$WS" "$TABLE" "$row" "Title=edited $i" >/dev/null 2>&1 \
    || { echo "row set failed at edit $i" >&2; exit 1; }
  i=$((i + 1))
  if [ $((i % 25)) -eq 0 ]; then
    echo "  $i/$EDITS  ($(( $(date +%s) - start ))s)"
  fi
done
echo "done: $EDITS edits in $(( $(date +%s) - start ))s"
