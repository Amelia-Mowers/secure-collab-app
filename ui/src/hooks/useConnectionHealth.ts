/**
 * Connection-health policy over the bridge's raw signal (ADR 0003 phase 2).
 *
 * `ConnectedWorkspace.connectionHealth()` reports how long it's been since the
 * homeserver last answered anything. Send failures deliberately do NOT feed
 * this: a rate-limited or rejected send while sync is answering means the
 * server is up (that's phase 3's failure-classification territory).
 *
 * Three states, because a blip and an outage deserve different responses
 * (issue row_1785005414406 — the single blocking modal was disruptive and
 * fired far too eagerly):
 *
 * - `ok`        — nothing shown.
 * - `degraded`  — brief. A quiet status badge; **editing stays enabled**,
 *                 because unsent edits persist in the outbox (phase 1) and a
 *                 20-second hiccup is not worth interrupting anyone over.
 * - `down`      — sustained. The write lock from ADR 0003: bound divergence
 *                 rather than merge it. Five minutes of silence, not 45
 *                 seconds.
 *
 * ## Why the old threshold was flaky
 *
 * Sync long-polls with a 30 s timeout (`DEFAULT_SYNC_TIMEOUT` in matrix-sdk),
 * and the old 45 s threshold left just 15 s of margin — one slow response and
 * the whole app went behind a modal. Worse, a backgrounded tab has its timers
 * throttled and a slept machine stops the loop entirely, so waking up meant
 * arriving at a blocking dialog for a connection that was fine.
 *
 * Hence `sinceResume`: time that the tab was not actually running doesn't
 * count as time the server was silent. On becoming visible again the clock
 * restarts, and the state can only degrade once we've genuinely watched a
 * stale connection while awake.
 */

import { useEffect, useRef, useState } from 'react'
import { useOnlineStatus } from './useOnlineStatus'

export type ConnectionState = 'ok' | 'degraded' | 'down'

/** No sync response for this long → `degraded`. 3× the 30 s long-poll cycle. */
export const DEGRADED_AFTER_MS = 90_000
/** …and for this long → `down`, which locks writes. */
export const DOWN_AFTER_MS = 300_000
const POLL_MS = 5_000

export function useConnectionHealth(workspace: any): ConnectionState {
  const [state, setState] = useState<ConnectionState>('ok')
  const online = useOnlineStatus()
  /** When the tab last became visible — the start of the observable window. */
  const resumedAtRef = useRef(Date.now())

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resumedAtRef.current = Date.now()
        // Whatever we thought while suspended is not evidence.
        setState('ok')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

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
        // Silence we could not have observed (tab hidden, machine asleep)
        // doesn't count against the server.
        const stale = Math.min(h.msSinceLastSyncOk, Date.now() - resumedAtRef.current)
        setState(stale > DOWN_AFTER_MS ? 'down' : stale > DEGRADED_AFTER_MS ? 'degraded' : 'ok')
      } catch {
        /* unreadable health → assume ok; this must never wedge the app */
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

  // A browser that reports itself offline is at least degraded, immediately —
  // that signal is definitive in a way a missed long-poll isn't. It still takes
  // a sustained outage to reach the write lock.
  if (!online && state === 'ok') return 'degraded'
  return state
}
