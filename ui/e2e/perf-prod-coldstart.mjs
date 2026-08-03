/**
 * Production cold-start latency probe (decrypt-inclusive).
 *
 * SSO-signs-in as a test account, VERIFIES the fresh device with its master key
 * (PROD_RECOVERY_KEY) so it can decrypt history, opens the workspace, and times
 * the real cold start: `ConnectedWorkspace::create()` paginates the room
 * timeline, the SDK Megolm-decrypts each event, and the workspace materializes.
 * Bracketed by two console markers the app already emits:
 *   "Creating connected workspace for room:"  →  "Connected workspace initialized with sync"
 *
 * Read-only (no writes). Measures one workspace over reloads; the room's event
 * count is reported so the per-event cost can be derived. No secrets logged.
 *
 * Run (Nix shell, from ui/):
 *   PROD_USER=… PROD_PASSWORD=… PROD_RECOVERY_KEY="…" node e2e/perf-prod-coldstart.mjs
 */
import { chromium } from '@playwright/test'

const APP_URL = process.env.PROD_APP_URL ?? 'https://amelia-mowers.github.io/tidework/'
const USER = process.env.PROD_USER
const PASSWORD = process.env.PROD_PASSWORD
const RECOVERY = process.env.PROD_RECOVERY_KEY
const RELOADS = Number(process.env.PERF_RELOADS ?? 3)
const WORKSPACE_NAME = process.env.PERF_WORKSPACE_NAME ?? 'testworkspace'
if (!USER || !PASSWORD || !RECOVERY) {
  console.error('PROD_USER / PROD_PASSWORD / PROD_RECOVERY_KEY required')
  process.exit(2)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
const context = await browser.newContext()
const page = await context.newPage()
const step = (m) => console.log(`==> ${m}`)

// Capture cold-start markers with arrival timestamps; remember the opened room.
const marks = []
let openedRoom = null
page.on('console', (msg) => {
  const t = msg.text()
  const m = t.match(/Creating connected workspace for room:\s*(\S+)/)
  if (m) { openedRoom = m[1]; marks.push({ kind: 'start', t: Date.now() }) }
  else if (t.includes('Connected workspace initialized with sync')) marks.push({ kind: 'done', t: Date.now() })
})
function pairDurations() {
  const out = []
  let start = null
  for (const m of marks) {
    if (m.kind === 'start') start = m.t
    else if (m.kind === 'done' && start != null) { out.push(m.t - start); start = null }
  }
  return out
}

try {
  step(`loading deployed app: ${APP_URL}`)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('oauth-signin').waitFor({ state: 'visible', timeout: 60_000 })

  step('SSO sign-in via MAS popup')
  const popupPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /continue with secure sign-in/i }).click()
  const popup = await popupPromise
  await popup.getByLabel(/username/i).fill(USER)
  await popup.getByLabel(/password/i).fill(PASSWORD)
  await popup.getByRole('button', { name: /continue|sign in|log in/i }).click()
  try { await popup.getByRole('button', { name: /continue|allow|approve/i }).click({ timeout: 15_000 }) } catch {}

  step('verify-this-device gate: restoring with the master key')
  await page.getByRole('heading', { name: /verify this device/i }).waitFor({ timeout: 90_000 })
  // With a passkey the gate shows a "use your master key instead" link; without
  // one it shows the master-key field directly. Click the link only if present.
  try { await page.getByRole('button', { name: /use your master key instead/i }).click({ timeout: 5_000 }) } catch {}
  await page.locator('.verify__input').fill(RECOVERY)
  await page.locator('.verify__primary').last().click()

  step('waiting for backup restore + device verification to finish (overlay detaches)')
  // The "Restoring…" step fetches + decrypts the key backup; can take a while.
  // The heading renders *behind* the modal, so wait for the overlay to detach.
  await page.locator('.verify__overlay').waitFor({ state: 'detached', timeout: 180_000 })
  await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ timeout: 30_000 })

  step(`opening workspace "${WORKSPACE_NAME}" (cold start: fetch + decrypt + materialize)`)
  // Target the named workspace card (an account may have several).
  await page.locator('.workspace-card', { has: page.locator('.workspace-card__name', { hasText: WORKSPACE_NAME }) })
    .first().click({ timeout: 30_000 })
  await page.waitForURL(/\/workspace\//, { timeout: 30_000 }).catch(() => {})

  // Wait for the first cold-start pair, then reload to get warm-store numbers.
  for (let i = 0; i < 60 && pairDurations().length < 1; i++) await page.waitForTimeout(250)

  for (let r = 0; r < RELOADS; r++) {
    const before = pairDurations().length
    await page.reload({ waitUntil: 'domcontentloaded' })
    for (let i = 0; i < 80 && pairDurations().length <= before; i++) await page.waitForTimeout(250)
  }

  const durations = pairDurations()
  // Event count of the room we actually opened (from the cold-start marker),
  // via the access token (read-only).
  const meta = await page.evaluate(async (room) => {
    try {
      const acct = JSON.parse(localStorage.getItem('collab:accounts'))[0]
      const hs = acct.homeserverUrl.replace(/\/$/, '')
      const token = JSON.parse(acct.matrixSessionData).accessToken
      if (!room) return { room: null }
      let from = '', events = 0, pages = 0
      for (;;) {
        const u = new URL(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`)
        u.searchParams.set('dir', 'b'); u.searchParams.set('limit', '100'); if (from) u.searchParams.set('from', from)
        const mr = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
        if (mr.status !== 200) return { room, fetch_status: mr.status }
        const j = await mr.json(); pages++; events += (j.chunk || []).length
        if (!j.end || !j.chunk?.length || j.end === from) break
        from = j.end; if (pages > 50) break
      }
      return { room, events, pages }
    } catch (e) { return { error: String(e) } }
  }, openedRoom)

  console.log('\n=== PROD COLD-START RESULTS ===')
  console.log(JSON.stringify({
    workspace_room: meta.room ?? null,
    room_events: meta.events ?? null,
    fetch_status: meta.fetch_status ?? 200,
    coldstart_ms: durations,
    note: 'coldstart_ms[0] is the first open (may include SDK fetch); later are reload/warm-store',
  }, null, 2))
  if (durations.length === 0) { console.error('No cold-start markers captured'); process.exitCode = 1 }
} catch (err) {
  console.error('\nPROD COLD-START: FAIL —', err.message)
  await page.screenshot({ path: 'prod-coldstart-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
