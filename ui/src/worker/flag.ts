/**
 * Whether the Matrix client runs in the SharedWorker (issue 87bf86a6, stage 4).
 *
 * Default **ON**. The worker is now the normal path: it is the only one where two
 * tabs of an account don't fight over one crypto store, and the two behaviours
 * `multi-tab.spec.ts` used to quarantine only pass with it.
 *
 * There is deliberately **no automatic fallback**. Silently reverting to an
 * in-tab client would hand the user back the exact bug — a second tab whose
 * writes vanish with no error — and it would do so in precisely the situations
 * nobody is watching. A browser that cannot run the worker must say so; see
 * `assertWorkerSupport`.
 *
 * The escape hatch stays for debugging, and only that:
 *
 *   ?sharedWorker=0      force the in-tab client (also `=1` to force it on)
 *   localStorage         `collab:sharedWorker` = 'on' | 'off', sticky
 *
 * A query parameter also WRITES the sticky value, so a link survives the reload
 * that testing this needs.
 *
 * Read once per page load and cached: the answer must not change between the
 * session being created and the workspace being opened. A tab that built a
 * worker-backed session and then opened an in-tab workspace would create exactly
 * the second client this exists to prevent.
 */

const STORAGE_KEY = 'collab:sharedWorker'

let cached: boolean | null = null

export function sharedWorkerEnabled(): boolean {
  if (cached !== null) return cached
  cached = read()
  if (!cached) {
    console.warn(
      '[worker] shared-worker client DISABLED by override — a second tab of this ' +
        'account will silently fail to write (issue 87bf86a6)',
    )
  }
  return cached
}

function read(): boolean {
  // Unit tests (jsdom) drive the in-tab client: there is no SharedWorker there,
  // and no second tab either, so the hazard this guards against cannot arise.
  //
  // Checked as an explicit test-mode carve-out rather than by feature-detecting
  // SharedWorker, because those are NOT the same question. A real browser with no
  // SharedWorker must fail loudly — silently using an in-tab client is how the
  // multi-tab data-loss bug comes back. jsdom must not. Only the environment
  // distinguishes them.
  //
  // (Setting the flag from `test/setup.ts` was tried first and is not reliable:
  // tests that `localStorage.clear()` in their own `beforeEach` wipe it, and that
  // runs after the global setup.)
  if (import.meta.env.MODE === 'test') return false
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
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    // No window/localStorage (unit tests, exotic embeddings). Default to the
    // in-tab client: those environments have no SharedWorker either, and the
    // multi-tab hazard needs multiple tabs, which they do not have.
    return false
  }
}

/**
 * Why this browser cannot run the worker path, or `null` if it can.
 *
 * Checked up front so an unsupported browser fails with a sentence a user can
 * act on, rather than part-way through a sign-in. What the worker path needs is a
 * **module** SharedWorker — `new SharedWorker(url, { type: 'module' })` — which
 * is narrower than SharedWorker alone: Chrome/Edge 80+, Firefox 114+ (dynamic
 * import in workers landed in 113, module shared workers in 114), Safari 16+.
 *
 * Feature-detected rather than sniffed for the version, because the constructor
 * either exists or it doesn't, and a UA string tells you less than that.
 */
export function workerSupportGap(): string | null {
  if (typeof SharedWorker === 'undefined') {
    return 'This browser does not support shared workers, which TideWork needs to keep multiple tabs of one account in step. Chrome, Edge, Firefox 114+ and Safari 16+ all work.'
  }
  return null
}
