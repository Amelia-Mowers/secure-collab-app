/**
 * Connection-health policy over the bridge's raw signal (ADR 0003 phase 2).
 *
 * `ConnectedWorkspace.connectionHealth()` reports how long it's been since the
 * homeserver last answered anything. "Disconnected" here means exactly that:
 * **no sync response for over DOWN_AFTER_MS** — sync long-polls (~30 s hold on
 * a quiet room), so the threshold is one missed cycle plus margin. Send
 * failures alone deliberately do NOT trip this: a rate-limited or rejected
 * send while sync is answering means the server is up (that's phase 3's
 * failure-classification territory, not a disconnect).
 *
 * The consumer (DisconnectedOverlay) locks writes while 'down' — with the
 * persistent outbox this bounds offline divergence to roughly one threshold
 * window rather than an unbounded editing session.
 */

import { useEffect, useState } from 'react'

export type ConnectionState = 'ok' | 'down'

/** No sync response for this long → 'down'. One ~30s long-poll cycle + margin. */
export const DOWN_AFTER_MS = 45_000
const POLL_MS = 5_000

export function useConnectionHealth(workspace: any): ConnectionState {
  const [state, setState] = useState<ConnectionState>('ok')

  useEffect(() => {
    if (!workspace || typeof workspace.connectionHealth !== 'function') {
      setState('ok')
      return
    }
    let cancelled = false
    const check = () => {
      if (cancelled) return
      try {
        const h = JSON.parse(workspace.connectionHealth())
        setState(h.msSinceLastSyncOk > DOWN_AFTER_MS ? 'down' : 'ok')
      } catch {
        /* unreadable health → assume ok; the overlay must never wedge the app */
        setState('ok')
      }
    }
    check()
    const interval = setInterval(check, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspace])

  return state
}
