import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import './OfflineOverlay.css'

/**
 * Interim offline guard (#2). When the browser reports no connection, block
 * interaction behind a modal that offers only "Reload" — because edits made
 * while offline queue in memory and are lost if the page reloads before
 * reconnecting. The overlay clears itself automatically once connectivity
 * returns (the `online` event re-renders this to `null`).
 */
export function OfflineOverlay() {
  const online = useOnlineStatus()
  if (online) return null

  return (
    <div
      className="offline-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-label="You are offline"
    >
      <div className="offline-overlay__card">
        <div className="offline-overlay__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3 1 21h22L12 3z" />
            <line x1="12" y1="9" x2="12" y2="14" />
            <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <h2 className="offline-overlay__title">You're offline</h2>
        <p className="offline-overlay__msg">
          You're not connected to the server, so changes can't be saved right now.
          Reconnect and editing resumes automatically — or reload to start fresh.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  )
}
