import { useEffect, useState } from 'react'
import { APP_VERSION, entriesSince, type ChangelogEntry } from '@/lib/changelog'
import './WhatsNewModal.css'

const SEEN_KEY = 'tw:whatsNewSeen'

/**
 * Renders the subset of markdown the changelog actually uses: `- ` bullets and
 * `**bold**`. Deliberately not a markdown library — the app has seven
 * dependencies and a what's-new dialog is a poor reason to make it eight, and a
 * renderer that only handles what we write cannot be surprised by what we
 * write. Anything unrecognised falls through as plain text rather than
 * disappearing.
 */
function renderInline(text: string, keyBase: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={`${keyBase}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  )
}

function EntryBody({ body }: { body: string }) {
  const blocks: React.ReactNode[] = []
  let bullets: string[] = []

  const flush = () => {
    if (!bullets.length) return
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {bullets.map((b, i) => (
          <li key={i}>{renderInline(b, `b${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    )
    bullets = []
  }

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2))
    } else if (!line) {
      flush()
    } else if (bullets.length) {
      // A wrapped continuation of the bullet above, which is how the file is
      // written — joining it keeps the sentence whole.
      bullets[bullets.length - 1] += ` ${line}`
    } else {
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line, `p${blocks.length}`)}</p>)
    }
  }
  flush()
  return <>{blocks}</>
}

/**
 * "What's new", shown once per version.
 *
 * Two rules keep it from being an annoyance:
 *
 *  - A user with nothing recorded is NOT shown anything. Someone opening
 *    TideWork for the first time does not want release notes for a product they
 *    have not used; their current version is recorded silently and they see the
 *    next one.
 *  - It is bounded by the running version, so a tab on a stale bundle is never
 *    told about a release it does not have.
 */
export function WhatsNewModal() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])

  useEffect(() => {
    let seen: string | null = null
    try {
      seen = localStorage.getItem(SEEN_KEY)
    } catch {
      return // Storage denied — never block the app over release notes.
    }

    if (!seen) {
      try {
        localStorage.setItem(SEEN_KEY, APP_VERSION)
      } catch {
        /* ignore */
      }
      return
    }
    setEntries(entriesSince(seen))
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, APP_VERSION)
    } catch {
      /* ignore */
    }
    setEntries([])
  }

  if (!entries.length) return null

  return (
    <div className="whats-new__scrim" onClick={dismiss}>
      <div
        className="whats-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        onClick={e => e.stopPropagation()}
      >
        <header className="whats-new__head">
          <h2 id="whats-new-title">What&rsquo;s new</h2>
          <button className="whats-new__close" onClick={dismiss} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="whats-new__body">
          {entries.map(entry => (
            <section key={entry.version} className="whats-new__entry">
              <h3>
                {entry.version} <span className="whats-new__date">{entry.date}</span>
              </h3>
              <EntryBody body={entry.body} />
            </section>
          ))}
        </div>

        <footer className="whats-new__foot">
          <button className="whats-new__ok" onClick={dismiss}>
            Got it
          </button>
        </footer>
      </div>
    </div>
  )
}
