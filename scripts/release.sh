#!/usr/bin/env bash
#
# Cut a release: bump the version, tag it, push the tag. The tag is what
# deploys — merging to main proves a change is good, tagging is the separate,
# deliberate act of putting it in front of users.
#
#   scripts/release.sh 0.1.2
#
# Everything it refuses to do, it refuses BEFORE touching anything, so a failed
# run leaves the tree exactly as it found it.
#
# It will not cut a release when:
#   * the working tree is dirty, or you are not on main
#   * main is behind the remote, or the tag already exists
#   * main's CI is not green — a tag that ships a red build is the whole thing
#     this pipeline exists to prevent
#   * CHANGELOG.md has no entry for the version. The app shows that entry to
#     users on their next visit; a release without one ships a blank what's-new.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

# Find a real Python 3, by RUNNING each candidate rather than trusting that it
# exists. Both halves of that were learned the hard way on the first use of this
# script: `python3` is absent from Git Bash on Windows, and worse, Windows ships
# a `python3` stub on PATH that only prints an advert for the Microsoft Store —
# so `command -v python3` succeeds and the interpreter does not.
PY_BIN=""
for candidate in python3 python py; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  "$resolved" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'     >/dev/null 2>&1 || continue
  PY_BIN="$resolved"
  break
done
[ -n "$PY_BIN" ] || die "python 3 is required (tried python3, python, py)"

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: scripts/release.sh <version>   e.g. 0.1.2"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version must be MAJOR.MINOR.PATCH (got '$VERSION')"

TAG="v$VERSION"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Refuse early ────────────────────────────────────────────────────────────
[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on '$BRANCH'; releases are cut from main"

git fetch origin --quiet
LOCAL="$(git rev-parse main)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] || die "main and origin/main differ; pull or push first"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "$TAG already exists locally"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "$TAG already exists on origin"
fi

grep -q "^## $VERSION — " CHANGELOG.md \
  || die "CHANGELOG.md has no '## $VERSION — <date>' entry. Write one first — it is what users are shown."

# ── Is main green? ──────────────────────────────────────────────────────────
# `gh pr view --json statusCheckRollup` is the PR-side query; for a branch it is
# the commit's check runs. Anything other than success or skipped blocks.
echo "checking CI for $LOCAL ..."
STATES="$(gh api "repos/{owner}/{repo}/commits/$LOCAL/check-runs" \
  --jq '.check_runs[] | "\(.conclusion // "pending") \(.name)"' 2>/dev/null || true)"
[ -n "$STATES" ] || die "could not read check runs for $LOCAL (gh auth? network?)"

BAD="$(printf '%s\n' "$STATES" | grep -Ev '^(success|skipped|neutral) ' || true)"
if [ -n "$BAD" ]; then
  echo "main is not green:" >&2
  printf '  %s\n' "$BAD" >&2
  die "refusing to tag a build that is not green"
fi
echo "  main is green"

# ── Bump the version everywhere it is stated ────────────────────────────────
# Three files say the version and nothing links them; the app reads the npm one
# to decide which changelog entry to show, so drift there is user-visible.
"$PY_BIN" - "$VERSION" <<'PY'
import pathlib, re, sys
version = sys.argv[1]

def sub(path, pattern, repl, count=1):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    s2, n = re.subn(pattern, repl, s, count=count, flags=re.M)
    if n != count:
        raise SystemExit(f"error: {path}: expected {count} version line(s), replaced {n}")
    p.write_text(s2, encoding="utf-8", newline="\n")

sub("Cargo.toml", r'^version = "[^"]+"', f'version = "{version}"')
sub("ui/package.json", r'^  "version": "[^"]+"', f'  "version": "{version}"')
print(f"  bumped Cargo.toml and ui/package.json to {version}")
PY

# package-lock carries the version too; keep it consistent without a full install.
if [ -f ui/package-lock.json ]; then
  "$PY_BIN" - "$VERSION" <<'PY'
import json, pathlib, sys
version = sys.argv[1]
p = pathlib.Path("ui/package-lock.json")
data = json.loads(p.read_text(encoding="utf-8"))
data["version"] = version
if "" in data.get("packages", {}):
    data["packages"][""]["version"] = version
p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
print("  bumped ui/package-lock.json")
PY
fi

git add Cargo.toml ui/package.json ui/package-lock.json
# A re-cut of the same version has nothing to bump, and `git commit` with no
# staged change exits non-zero — which under `set -e` aborts a release that is
# otherwise perfectly valid. That happens whenever a tag's CI fails and the tag
# is deleted and re-cut, which is exactly when you least want the tooling to
# argue with you.
if git diff --cached --quiet; then
  echo "  version files already say $VERSION — nothing to bump"
else
  git commit -q -m "chore(release): $VERSION"
fi

# The tag message is the changelog entry, so `git show $TAG` and the GitHub
# release say the same thing as the app's what's-new.
NOTES="$(awk -v v="## $VERSION — " '
  index($0, v) == 1 { grab = 1; next }
  grab && /^## / { exit }
  grab { print }
' CHANGELOG.md)"

git tag -a "$TAG" -m "TideWork $VERSION
$NOTES"

echo
echo "About to push:"
echo "  commit  $(git rev-parse --short HEAD)  chore(release): $VERSION"
echo "  tag     $TAG   -> DEPLOYS TO PRODUCTION"
echo
read -r -p "push? [y/N] " reply
case "$reply" in
  y | Y) ;;
  *)
    git tag -d "$TAG" >/dev/null
    git reset --hard HEAD~1 >/dev/null
    die "aborted; version bump and tag undone"
    ;;
esac

git push origin main
git push origin "$TAG"

echo
echo "pushed. the tag's CI run deploys when it goes green:"
echo "  https://github.com/Amelia-Mowers/tidework/actions"
echo
echo "afterwards, publish the GitHub release:"
echo "  gh release create $TAG --title \"TideWork $VERSION\" --notes \"\$(git tag -l --format='%(contents:body)' $TAG)\""
