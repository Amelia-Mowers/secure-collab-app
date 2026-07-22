import { useEffect, useState } from 'react'
import './UpdateBanner.css'

/**
 * New-deploy detection (issue 9ac89444). A deploy replaces the hashed assets,
 * so a client from before it breaks the next time it lazy-loads a chunk or
 * its wasm ("unreachable code" style errors). Two signals:
 *
 * - Polling: `/version.json` (emitted per build) vs the `__BUILD_ID__` baked
 *   into this bundle, every 5 minutes and when the tab becomes visible.
 *   Mismatch → a banner offering Reload / Later; Later snoozes one poll
 *   cycle so nobody gets yanked mid-form.
 * - `vite:preloadError`: a chunk failed to load — this client is ALREADY
 *   broken, so the banner appears immediately with firmer copy (no data is
 *   at risk either way: unsent edits persist in the outbox and re-apply
 *   after reload — ADR 0003 phase 1).
 */

declare const __BUILD_ID__: string

export const CHECK_INTERVAL_MS = 5 * 60_000

async function fetchDeployedBuild(): Promise<string | null> {
  try {
    const base = import.meta.env.BASE_URL ?? '/'
    const res = await fetch(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body.build === 'string' ? body.build : null
  } catch {
    return null // offline etc. — never nag on a failed check
  }
}

export function UpdateBanner() {
  const [state, setState] = useState<'hidden' | 'update' | 'broken'>('hidden')
  const [snoozedUntil, setSnoozedUntil] = useState(0)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      if (cancelled || Date.now() < snoozedUntil) return
      const deployed = await fetchDeployedBuild()
      if (cancelled || deployed === null) return
      if (deployed !== __BUILD_ID__) {
        setState(s => (s === 'broken' ? s : 'update'))
      }
    }

    // A failed dynamic import means this client is already broken.
    const onPreloadError = (e: Event) => {
      e.preventDefault() // suppress vite's unhandled rejection
      setState('broken')
    }
    const onVisible = () => {
      if (!document.hidden) void check()
    }

    void check()
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS)
    window.addEventListener('vite:preloadError', onPreloadError)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('vite:preloadError', onPreloadError)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [snoozedUntil])

  if (state === 'hidden') return null

  const snooze = () => {
    setSnoozedUntil(Date.now() + CHECK_INTERVAL_MS)
    setState('hidden')
  }

  return (
    <div className="update-banner" role="alert">
      <span className="update-banner__text">
        {state === 'broken'
          ? 'TideWork was updated and this tab needs a reload to keep working.'
          : 'A new version of TideWork is available.'}{' '}
        Unsaved edits are kept on this device and re-apply after the reload.
      </span>
      <div className="update-banner__actions">
        <button className="update-banner__reload" onClick={() => window.location.reload()}>
          Reload
        </button>
        {state === 'update' && (
          <button className="update-banner__later" onClick={snooze}>
            Later
          </button>
        )}
      </div>
    </div>
  )
}
