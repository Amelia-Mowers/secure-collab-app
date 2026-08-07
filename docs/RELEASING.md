# Releasing

**Merging to main does not deploy.** A version tag deploys.

That split is deliberate. Main is continuously integrated and continuously
tested; putting something in front of users is a separate, deliberate act with a
time of day attached to it. Before this, every merge shipped — which meant the
only way to avoid deploying at an awkward moment was to avoid merging, so
finished work sat in branches for the wrong reason.

## Cutting a release

```sh
# 1. Write the entry FIRST. It is what users are shown.
$EDITOR CHANGELOG.md

# 2. Commit it through the normal PR flow, and let it land on main.

# 3. Cut the release.
scripts/release.sh 0.1.2
```

`scripts/release.sh` refuses before it touches anything if:

- the working tree is dirty, or you are not on `main`
- `main` and `origin/main` differ
- the tag already exists, locally or on the remote
- **main's CI is not green** — a tag that ships a red build is what this whole
  pipeline exists to prevent
- `CHANGELOG.md` has no entry for the version — a release without one shows
  users a blank what's-new

Then it bumps the version in `Cargo.toml`, `ui/package.json` and the lockfile,
commits, tags with the changelog entry as the tag message, shows you exactly
what it is about to push, and asks. Answering anything but `y` undoes the bump
and the tag.

Pushing the tag starts a CI run that builds and tests everything and, if green,
deploys. Nothing is skipped for a release: the path filters that let a
docs-only PR avoid the expensive jobs do not apply to a tag.

Afterwards, publish the GitHub release — the command is printed for you.

## Rhythm

There is no schedule in CI on purpose. The rhythm is whenever you run the
script, which is the point: a release happens when someone decides it should,
not when a clock fires while nobody is watching. Evenings and weekends are the
intent; nothing enforces it.

## Hotfixes

Two options, both fine:

- Cut a patch version the normal way. Preferred — it leaves a changelog entry
  and a version users can name.
- Run the workflow manually (Actions → CI → Run workflow) against `main`. This
  deploys without cutting a version, so it leaves no trace in the changelog.
  Use it when the fix is invisible to users, like an infrastructure change.

## What users see

The app shows the changelog entry for any version a user has not seen yet, once,
dismissible (`ui/src/components/WhatsNewModal.tsx`).

- Someone opening TideWork for the first time is shown **nothing** — their
  current version is recorded silently, and they see the next release.
- A tab running an older bundle is never told about a newer release, because the
  list is bounded by the running version as well as the seen one.

So changelog entries are read by people who do not build the product. Write them
that way: what changed for them, not which module changed.
