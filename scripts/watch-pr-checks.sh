#!/usr/bin/env bash
# Emit one line per PR when its CI finishes, then exit.
#
# NOTE: `gh pr checks --json` needs gh >= 2.20; this repo's environment has
# 2.11.3, where that flag does not exist and the command fails outright. Use
# `gh pr view --json statusCheckRollup`, which works on both.
set -uo pipefail
prs=("$@")
declare -A done_pr
while :; do
  pending=0
  for pr in "${prs[@]}"; do
    [ -n "${done_pr[$pr]:-}" ] && continue
    roll=$(gh pr view "$pr" --json statusCheckRollup -q \
      '[.statusCheckRollup[]|select(.conclusion==null or .conclusion=="")]|length' 2>/dev/null)
    if [ -z "$roll" ]; then pending=1; continue; fi
    if [ "$roll" -gt 0 ]; then pending=1; continue; fi
    bad=$(gh pr view "$pr" --json statusCheckRollup -q \
      '[.statusCheckRollup[]|select(.conclusion!="SUCCESS" and .conclusion!="SKIPPED")|.name]|join(", ")' 2>/dev/null)
    if [ -n "$bad" ]; then echo "PR #$pr FAILED: $bad"; else echo "PR #$pr green"; fi
    done_pr[$pr]=1
  done
  [ "$pending" -eq 0 ] && break
  sleep 30
done
