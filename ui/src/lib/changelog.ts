/**
 * The changelog, as the app sees it.
 *
 * `CHANGELOG.md` at the repo root is the single source: the release script
 * refuses to cut a tag without an entry, the tag message is that entry, and the
 * what's-new dialog renders it. One file, so the git history, the GitHub
 * release and the thing a user is shown cannot drift apart.
 */

declare const __CHANGELOG__: string
declare const __APP_VERSION__: string

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

const CHANGELOG_TEXT = typeof __CHANGELOG__ === 'string' ? __CHANGELOG__ : ''

export interface ChangelogEntry {
  version: string
  /** As written — `2026-08-07`. Not parsed into a Date; it is only displayed. */
  date: string
  /** The entry body, still markdown. */
  body: string
}

/** `## 0.1.1 — 2026-08-07`, em dash, as the file's own header states. */
const HEADING = /^## (\d+\.\d+\.\d+)\s+[—-]\s+(.+)$/

/** Newest first, matching the file. */
export function parseChangelog(text: string = CHANGELOG_TEXT): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null

  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line.trim())
    if (heading) {
      if (current) entries.push(current)
      current = { version: heading[1], date: heading[2].trim(), body: '' }
      continue
    }
    if (current) current.body += `${line}\n`
  }
  if (current) entries.push(current)

  return entries.map(e => ({ ...e, body: e.body.trim() }))
}

/** Numeric semver compare. `0.1.10` is newer than `0.1.9`, which a string
 *  comparison gets backwards — the reason this is not a `<`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Entries newer than `seen`, up to and including the running version.
 *
 * Bounded at the top by the running version on purpose: a user on a stale
 * bundle must not be told about a release their tab does not have yet, which is
 * possible for the minutes between a deploy and a reload.
 */
export function entriesSince(seen: string | null, current = APP_VERSION): ChangelogEntry[] {
  if (!seen) return []
  return parseChangelog().filter(
    e => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0,
  )
}
