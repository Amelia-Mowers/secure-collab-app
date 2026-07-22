import { useConnectionHealth } from '../hooks/useConnectionHealth'
import './OfflineOverlay.css'

/**
 * Server-unresponsive write lock (ADR 0003 phase 2). The browser-offline case
 * is covered by OfflineOverlay (`navigator.onLine`); this one catches the
 * network-up-but-homeserver-down case via the bridge's sync health, and locks
 * editing so a dead connection can't accumulate a long divergent session —
 * the product choice from the ADR: bound divergence instead of merging it.
 *
 * Softer than the offline modal: unsent edits now survive in the persistent
 * outbox (phase 1), so this is a status, not a data-loss warning. It clears
 * itself on the next sync response.
 */
export function DisconnectedOverlay({ workspace }: { workspace: any }) {
  const state = useConnectionHealth(workspace)
  if (state === 'ok') return null

  return (
    <div
      className="offline-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-label="Disconnected from the server"
    >
      <div className="offline-overlay__card">
        <div className="offline-overlay__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 12.5a7 7 0 0 1 14 0" />
            <path d="M8.5 15.5a3.8 3.8 0 0 1 7 0" />
            <circle cx="12" cy="18.5" r="0.8" fill="currentColor" stroke="none" />
            <line x1="4" y1="4" x2="20" y2="20" />
          </svg>
        </div>
        <h2 className="offline-overlay__title">Reconnecting…</h2>
        <p className="offline-overlay__msg">
          The server hasn&apos;t responded for a while, so editing is paused to keep
          everyone&apos;s changes in step. Your unsent edits are saved on this device;
          everything resumes automatically once the connection returns.
        </p>
      </div>
    </div>
  )
}
