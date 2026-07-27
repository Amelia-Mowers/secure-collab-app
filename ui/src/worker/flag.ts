/**
 * Opt-in switch for running the Matrix client in the SharedWorker (issue
 * 87bf86a6, stage 3).
 *
 * Default OFF. The worker path replaces the whole client lifecycle — session
 * restore, sync, the send queue, the crypto store — so it earns its default by
 * being exercised, not by being written. Two ways in:
 *
 *   ?sharedWorker=1      one page load (also `=0` to force it off)
 *   localStorage         `collab:sharedWorker` = 'on' | 'off', sticky
 *
 * A query parameter also WRITES the sticky value, so a link turns it on for the
 * session rather than just for one navigation — a reload is part of testing this.
 *
 * Read once per page load and cached: the answer must not change between the
 * session being created and the workspace being opened. A tab that built a
 * worker-backed session and then opened an in-tab workspace would create exactly
 * the second client this all exists to prevent.
 */

const STORAGE_KEY = 'collab:sharedWorker'

let cached: boolean | null = null

export function sharedWorkerEnabled(): boolean {
  if (cached !== null) return cached
  cached = read()
  if (cached) console.log('[worker] shared-worker Matrix client ENABLED')
  return cached
}

function read(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get('sharedWorker')
    if (param === '1' || param === 'true' || param === 'on') {
      localStorage.setItem(STORAGE_KEY, 'on')
      return true
    }
    if (param === '0' || param === 'false' || param === 'off') {
      localStorage.setItem(STORAGE_KEY, 'off')
      return false
    }
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    // No window/localStorage (tests, exotic embeddings) — the in-tab path is the
    // safe default because it is what ships today.
    return false
  }
}

/** Reset the cached read. Tests only; a real page load re-reads anyway. */
export function resetSharedWorkerFlag() {
  cached = null
}
