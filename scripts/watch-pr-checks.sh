#!/usr/bin/env bash
# Emit one line per PR when its CI finishes, then exit.
#
# NOTE: `gh pr checks --json` needs gh >= 2.20; this repo's environment has
# 2.11.3, where that flag does not exist and the command fails outright. Use
# `gh pr view --json statusCheckRollup`, which works on both.
set -uo pipefail
prs=("$@")
declare -A done_pr
declare -A empty_streak

# Prove the query works BEFORE looping on it. A field this gh doesn't support
# (`headRefOid`, say) exits non-zero into an empty string, and an empty string
# is indistinguishable from "checks haven't started" — so the loop waits
# forever on a PR that is green and mergeable. That has now cost two sessions,
# and both times the symptom was a watcher that looked like slow CI.
if ! gh pr view "${prs[0]}" --json statusCheckRollup -q '.statusCheckRollup|length' >/dev/null 2>&1; then
  echo "watch-pr-checks: 'gh pr view --json statusCheckRollup' failed on PR #${prs[0]}." >&2
  echo "  gh version: $(gh --version 2>&1 | head -1)" >&2
  echo "  Not polling — a query that cannot answer is not the same as a PR that is not ready." >&2
  exit 2
fi
while :; do
  pending=0
  for pr in "${prs[@]}"; do
    [ -n "${done_pr[$pr]:-}" ] && continue
    roll=$(gh pr view "$pr" --json statusCheckRollup -q \
      '[.statusCheckRollup[]|select(.conclusion==null or .conclusion=="")]|length' 2>/dev/null)
    # Empty means the query failed, not that the PR is busy. Tolerate a few
    # (a transient API blip) and then say so, rather than waiting out the
    # timeout in silence.
    if [ -z "$roll" ]; then
      empty_streak[$pr]=$(( ${empty_streak[$pr]:-0} + 1 ))
      if [ "${empty_streak[$pr]}" -ge 5 ]; then
        echo "PR #$pr: statusCheckRollup came back empty 5x — giving up rather than polling silently" >&2
        done_pr[$pr]=1
      else
        pending=1
      fi
      continue
    fi
    empty_streak[$pr]=0
    if [ "$roll" -gt 0 ]; then pending=1; continue; fi
    bad=$(gh pr view "$pr" --json statusCheckRollup -q \
      '[.statusCheckRollup[]|select(.conclusion!="SUCCESS" and .conclusion!="SKIPPED")|.name]|join(", ")' 2>/dev/null)
    if [ -n "$bad" ]; then echo "PR #$pr FAILED: $bad"; else echo "PR #$pr green"; fi
    done_pr[$pr]=1
  done
  [ "$pending" -eq 0 ] && break
  sleep 30
done
