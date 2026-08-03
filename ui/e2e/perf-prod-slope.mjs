/**
 * Production cold-start SLOPE probe: is the ~4.6s cold start fixed overhead or
 * per-event (Megolm decrypt + pagination)?
 *
 * Measures cold start for TWO workspaces of very different size — a freshly
 * created empty one (≈ setup events only) and an existing data-heavy one — and
 * fits a line: cold_start ≈ fixed + slope·events. Cold start is bracketed by the
 * app's "Creating connected workspace for room: <id>" → "Connected workspace
 * initialized with sync" console markers; samples are bucketed by room id.
 *
 * Needs a verified device (PROD_RECOVERY_KEY). Creates ONE throwaway workspace.
 * No secrets logged.
 *
 * Run (Nix shell, from ui/):
 *   PROD_USER=… PROD_PASSWORD=… PROD_RECOVERY_KEY="…" node e2e/perf-prod-slope.mjs
 */
import { chromium } from '@playwright/test'

const APP_URL = process.env.PROD_APP_URL ?? 'https://amelia-mowers.github.io/tidework/'
const USER = process.env.PROD_USER
const PASSWORD = process.env.PROD_PASSWORD
const RECOVERY = process.env.PROD_RECOVERY_KEY
const EXISTING = process.env.PERF_EXISTING_NAME ?? 'testworkspace'
if (!USER || !PASSWORD || !RECOVERY) { console.error('PROD_USER / PROD_PASSWORD / PROD_RECOVERY_KEY required'); process.exit(2) }

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
const context = await browser.newContext()
const page = await context.newPage()
const step = (m) => console.log(`==> ${m}`)

// Bucket cold-start durations by room id, parsed from the start marker.
const byRoom = {}
let open = null
page.on('console', (msg) => {
  const t = msg.text()
  const m = t.match(/Creating connected workspace for room:\s*(\S+)/)
  if (m) { open = { room: m[1], t: Date.now() } }
  else if (t.includes('Connected workspace initialized with sync') && open) {
    ;(byRoom[open.room] ??= []).push(Date.now() - open.t); open = null
  }
})
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const sleep = (ms) => page.waitForTimeout(ms)
async function waitForSamples(room, n) { for (let i = 0; i < 80 && (byRoom[room]?.length ?? 0) < n; i++) await sleep(250) }

async function gotoWorkspaces() {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ timeout: 60_000 })
  await page.locator('.workspace-card').first().waitFor({ timeout: 30_000 })
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

  step('verify device with the master key (one-time; persists for reloads)')
  await page.getByRole('heading', { name: /verify this device/i }).waitFor({ timeout: 90_000 })
  // The "use your master key instead" link only appears when a passkey is also
  // offered; without one the master-key field shows directly. Click if present.
  try { await page.getByRole('button', { name: /use your master key instead/i }).click({ timeout: 5_000 }) } catch {}
  await page.locator('.verify__input').fill(RECOVERY)
  await page.locator('.verify__primary').last().click()
  await page.locator('.verify__overlay').waitFor({ state: 'detached', timeout: 180_000 })
  await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ timeout: 30_000 })

  // ── Phase 1: fresh EMPTY workspace FIRST (session is live right after verify;
  //    no goto, so no token/restore race) — create (auto-opens) + 2 reloads ──
  step('creating + measuring a fresh empty workspace')
  await page.locator('.workspace-card--new').click()
  await page.locator('input[placeholder="Workspace name"]').fill(`perf-empty-${Date.now()}`)
  await page.getByRole('button', { name: /^create$/i }).click()
  await page.waitForURL(/\/workspace\//, { timeout: 60_000 })
  for (let i = 0; i < 80 && Object.keys(byRoom).length < 1; i++) await sleep(250)
  const emptyRoom = Object.keys(byRoom)[0]
  await waitForSamples(emptyRoom, 1)
  for (let r = 0; r < 2; r++) { await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(250); await waitForSamples(emptyRoom, r + 2) }

  // ── Phase 2: existing (large) workspace — back to list + open + 2 reloads ──
  step(`measuring existing workspace "${EXISTING}"`)
  await gotoWorkspaces()
  await page.locator('.workspace-card', { has: page.locator('.workspace-card__name', { hasText: EXISTING }) }).first().click({ timeout: 30_000 })
  await page.waitForURL(/\/workspace\//, { timeout: 30_000 })
  const bigRoom = Object.keys(byRoom).find((r) => r !== emptyRoom)
  await waitForSamples(bigRoom, 1)
  for (let r = 0; r < 2; r++) { await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(250); await waitForSamples(bigRoom, r + 2) }

  // ── Event counts per room via CS API (read-only) ──
  const counts = await page.evaluate(async (rooms) => {
    const acct = JSON.parse(localStorage.getItem('collab:accounts'))[0]
    const hs = acct.homeserverUrl.replace(/\/$/, '')
    const token = JSON.parse(acct.matrixSessionData).accessToken
    const out = {}
    for (const room of rooms) {
      if (!room) continue
      let from = '', events = 0, pages = 0
      for (;;) {
        const u = new URL(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`)
        u.searchParams.set('dir', 'b'); u.searchParams.set('limit', '100'); if (from) u.searchParams.set('from', from)
        const mr = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
        if (mr.status !== 200) { out[room] = { fetch_status: mr.status }; break }
        const j = await mr.json(); pages++; events += (j.chunk || []).length
        if (!j.end || !j.chunk?.length || j.end === from) { out[room] = { events }; break }
        from = j.end; if (pages > 60) { out[room] = { events, capped: true }; break }
      }
    }
    return out
  }, Object.keys(byRoom))

  const rooms = Object.entries(byRoom).map(([room, samples]) => ({
    room, samples, median_ms: median(samples), events: counts[room]?.events ?? null,
  })).filter((r) => r.events != null).sort((a, b) => a.events - b.events)

  const result = { rooms }
  if (rooms.length >= 2) {
    const a = rooms[0], b = rooms[rooms.length - 1]
    const slope = (b.median_ms - a.median_ms) / (b.events - a.events)
    const fixed = Math.round(a.median_ms - slope * a.events)
    result.fit = {
      small: { events: a.events, median_ms: a.median_ms },
      large: { events: b.events, median_ms: b.median_ms },
      slope_ms_per_event: Number(slope.toFixed(2)),
      fixed_overhead_ms: fixed,
      verdict: slope > 5 ? 'per-event dominated (decrypt/fetch)' : (fixed > 2000 ? 'mostly FIXED overhead' : 'mixed'),
    }
  }
  // Cleanup: leave + forget the throwaway empty workspace we created.
  if (emptyRoom) {
    await page.evaluate(async (room) => {
      try {
        const acct = JSON.parse(localStorage.getItem('collab:accounts'))[0]
        const hs = acct.homeserverUrl.replace(/\/$/, '')
        const token = JSON.parse(acct.matrixSessionData).accessToken
        const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/leave`, { method: 'POST', headers: H, body: '{}' })
        await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/forget`, { method: 'POST', headers: H, body: '{}' })
      } catch {}
    }, emptyRoom).catch(() => {})
    result.cleaned_up = emptyRoom
  }

  console.log('\n=== PROD COLD-START SLOPE ===')
  console.log(JSON.stringify(result, null, 2))
} catch (err) {
  console.error('\nPROD SLOPE: FAIL —', err.message)
  await page.screenshot({ path: 'prod-slope-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
