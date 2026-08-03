/**
 * Bounded production write-throughput / fetch-latency probe.
 *
 * SSO-signs-in as a test account (PROD_USER/PROD_PASSWORD), extracts the access
 * token the app persisted, and drives the Matrix client-server API directly to
 * measure REAL prod capacity against the live homeserver's rate limits:
 *   1. single-event send throughput (where rc_message throttles);
 *   2. one batch event of N cells (validates the batching fix #57 vs prod limits);
 *   3. /messages backward pagination latency over an existing room.
 *
 * Bounded + clean: writes ~70 events into ONE throwaway, non-encrypted room, then
 * leaves+forgets it. Rate limits are per-user, so this only affects the test
 * account. No secrets are logged.
 *
 * Run in the Nix dev shell, from ui/:
 *   PROD_USER=... PROD_PASSWORD=... node e2e/perf-prod.mjs
 */
import { chromium } from '@playwright/test'

const APP_URL = process.env.PROD_APP_URL ?? 'https://amelia-mowers.github.io/tidework/'
const USER = process.env.PROD_USER
const PASSWORD = process.env.PROD_PASSWORD
const READ_ROOM = process.env.PERF_READ_ROOM ?? '!pFyyGiiyVkWnZvESZs:tidework.io'
const SINGLES = Number(process.env.PERF_SINGLES ?? 40)
const BATCH_CELLS = Number(process.env.PERF_BATCH_CELLS ?? 33)
if (!USER || !PASSWORD) { console.error('PROD_USER / PROD_PASSWORD required'); process.exit(2) }

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
const context = await browser.newContext()
const page = await context.newPage()
const step = (m) => console.log(`==> ${m}`)

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

  step('waiting for the persisted session (token) to land in localStorage')
  await page.waitForFunction(() => {
    try {
      const a = JSON.parse(localStorage.getItem('collab:accounts') || '[]')
      return a.length > 0 && a[0].matrixSessionData
    } catch { return false }
  }, { timeout: 90_000 })

  step('running CS-API perf probe from the authenticated page')
  const results = await page.evaluate(async ({ readRoom, singles, batchCells }) => {
    const acct = JSON.parse(localStorage.getItem('collab:accounts'))[0]
    const hs = acct.homeserverUrl.replace(/\/$/, '')
    const token = JSON.parse(acct.matrixSessionData).accessToken
    const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    const out = { user: acct.userId }
    let txn = Date.now()
    const cell = (i) => ({ version: 1, table_id: 'perf', row_id: `r${i}`, column_id: 'c', value: '"x"', timestamp: i })

    // Fresh throwaway, non-encrypted room.
    const cr = await fetch(`${hs}/_matrix/client/v3/createRoom`, {
      method: 'POST', headers: H, body: JSON.stringify({ preset: 'private_chat', name: 'perf-throwaway' }),
    })
    const room = (await cr.json()).room_id
    out.room = room
    const send = async (type, body) => {
      const r = await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${type}/${++txn}`, {
        method: 'PUT', headers: H, body: JSON.stringify(body),
      })
      let retry = 0
      if (r.status === 429) { try { retry = (await r.json()).retry_after_ms || 0 } catch {} }
      return { status: r.status, retry }
    }

    // 1. Single events, back-to-back; record throttling.
    const t1 = performance.now()
    let throttled = 0, maxRetry = 0, sent = 0
    for (let i = 0; i < singles; i++) {
      const r = await send('io.tidework.cell.update', cell(i))
      if (r.status === 429) { throttled++; maxRetry = Math.max(maxRetry, r.retry) }
      else if (r.status < 300) sent++
    }
    out.singles = { n: singles, sent_ok: sent, throttled_429: throttled, max_retry_ms: maxRetry, total_ms: Math.round(performance.now() - t1) }

    // 2. One batch event carrying batchCells cells.
    const t2 = performance.now()
    const br = await send('io.tidework.cell.batch', { version: 1, cells: Array.from({ length: batchCells }, (_, i) => cell(i)) })
    out.batch = { cells: batchCells, status: br.status, retry_ms: br.retry, total_ms: Math.round(performance.now() - t2) }

    // 3. /messages backward pagination over an existing room (read-only).
    const t3 = performance.now()
    let from = '', pages = 0, events = 0
    for (;;) {
      const u = new URL(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(readRoom)}/messages`)
      u.searchParams.set('dir', 'b'); u.searchParams.set('limit', '100')
      if (from) u.searchParams.set('from', from)
      const mr = await fetch(u, { headers: H })
      if (mr.status !== 200) { out.read_error = mr.status; break }
      const j = await mr.json()
      pages++; events += (j.chunk || []).length
      if (!j.end || !j.chunk || j.chunk.length === 0 || j.end === from) break
      from = j.end
      if (pages > 50) break
    }
    out.fetch = { room: readRoom, pages, events, total_ms: Math.round(performance.now() - t3) }

    // Cleanup: leave + forget the throwaway room.
    await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/leave`, { method: 'POST', headers: H, body: '{}' })
    await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/forget`, { method: 'POST', headers: H, body: '{}' })
    out.cleaned_up = true
    return out
  }, { readRoom: READ_ROOM, singles: SINGLES, batchCells: BATCH_CELLS })

  console.log('\n=== PROD PERF RESULTS ===')
  console.log(JSON.stringify(results, null, 2))
} catch (err) {
  console.error('\nPROD PERF: FAIL —', err.message)
  await page.screenshot({ path: 'prod-perf-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
