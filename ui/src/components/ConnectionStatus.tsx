import { useConnectionHealth } from '../hooks/useConnectionHealth'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import './ConnectionStatus.css'

/**
 * What the user sees when the connection wobbles. One component, because
 * "browser offline" and "homeserver silent" are the same fact to the person
 * editing — only the severity differs (issue row_1785005414406).
 *
 * A brief interruption gets a **badge**: unobtrusive, corner of the screen,
 * editing continues. Unsent edits persist in the encrypted outbox (ADR 0003
 * phase 1), so a short blip genuinely costs nothing and interrupting for it
 * was the bug.
 *
 * A sustained one gets the **write lock** — the ADR's product decision to
 * bound divergence rather than reconcile an unbounded offline session. Five
 * minutes, so it means something when it appears.
 */
export function ConnectionStatus({ workspace }: { workspace?: any }) {
  const state = useConnectionHealth(workspace)
  const online = useOnlineStatus()

  if (state === 'ok') return null

  const label = online ? 'Reconnecting…' : 'Offline'

  if (state === 'degraded') {
    return (
      <div className="conn-badge" role="status" aria-live="polite">
        <span className="conn-badge__dot" aria-hidden="true" />
        {label}
      </div>
    )
  }

  return (
    <div
      className="conn-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-label={online ? 'Disconnected from the server' : 'You are offline'}
    >
      <div className="conn-overlay__card">
        <div className="conn-overlay__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 12.5a7 7 0 0 1 14 0" />
            <path d="M8.5 15.5a3.8 3.8 0 0 1 7 0" />
            <circle cx="12" cy="18.5" r="0.8" fill="currentColor" stroke="none" />
            <line x1="4" y1="4" x2="20" y2="20" />
          </svg>
        </div>
        <h2 className="conn-overlay__title">{online ? 'Still reconnecting' : "You're offline"}</h2>
        <p className="conn-overlay__msg">
          There&apos;s been no answer from the server for several minutes, so editing
          is paused to keep everyone&apos;s changes in step. Your unsent edits are
          saved on this device; everything resumes automatically once the
          connection returns.
        </p>
      </div>
    </div>
  )
}
