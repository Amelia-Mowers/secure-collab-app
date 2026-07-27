import { test, expect } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
} from './helpers'

/**
 * Recovery from a connection that HANGS (issue dc8bbbb8).
 *
 * The distinction this pins is the one two previous fixes missed. #174/#175
 * restart the sync stream when it ENDS — a dropped connection, a token hiccup, a
 * homeserver blip. They cannot help when the stream never ends at all, and in the
 * browser that is the common case: matrix-rust-sdk's WASM HTTP client ignores its
 * request config (`_config: RequestConfig` in http_client/wasm.rs), so there is no
 * request timeout, and `fetch()` has none of its own. A request issued over a
 * connection that died without a TCP reset — sleep/resume, a dropped Wi-Fi link, a
 * NAT rebind — simply never settles.
 *
 * Nothing returned, so nothing restarted: `last_sync_ok_ms` froze, the badge stuck
 * at "Reconnecting…", and five minutes later `ConnectionStatus` put up its
 * page-blocking overlay and left it there until the user reloaded.
 *
 * `sync_loop` now supervises LIVENESS: each `/sync` is bounded by a watchdog, and
 * a stalled one is abandoned and reissued. So the two things asserted here are
 * (1) another attempt is made at all, and (2) the UI recovers on its own once the
 * connection works again — no reload.
 *
 * Route interception is what makes a hang reproducible: a handler that never
 * fulfils leaves the request pending exactly as a dead socket does.
 * `context.setOffline` would NOT reproduce it — that fails requests fast, which
 * is the case the earlier fixes already handle.
 *
 * RUNS ON THE IN-TAB CLIENT (`?sharedWorker=0`), deliberately. Playwright's
 * `context.route` does not intercept requests issued from a SharedWorker, so on
 * the default path the hang cannot be induced at all: the badge never appears and
 * the test fails for a reason with nothing to do with reconnection. The loop under
 * test is the same either way — `sync_loop` in
 * `crates/app-core/src/bridge_matrix.rs`, compiled into the one wasm module both
 * paths load — so this is testing the real thing, just where the harness can reach
 * the socket. If a way to intercept worker traffic appears, move it.
 */

/** Must exceed `SYNC_WATCHDOG_MS` (90s) plus a retry, with room to spare. */
const RETRY_WINDOW_MS = 150_000
/** Recovery needs the in-flight stalled attempt to time out first. */
const RECOVERY_WINDOW_MS = 240_000

test('recovers from a hung sync without a reload', async ({ browser }) => {
  test.setTimeout(900_000)

  const context = await browser.newContext()
  // Force the in-tab client, so `context.route` below can actually see /sync.
  await context.addInitScript(() => {
    localStorage.setItem('collab:sharedWorker', 'off')
  })
  const page = await context.newPage()

  await registerDevice(page, homeserverUrl(), uniqueUser('hang'))
  await captureMasterKey(page)
  await createWorkspace(page, 'Hung Sync')
  await createTable(page, 'Items')

  // ── Hang every /sync, the way a dead-but-open socket does ──────────────────
  let attempts = 0
  let hanging = true
  await context.route('**/_matrix/client/*/sync**', async route => {
    if (!hanging) {
      await route.continue()
      return
    }
    attempts++
    // Never fulfil, never abort, never continue: the request stays pending.
    await new Promise(() => {})
  })

  await test.step('the badge appears once sync stops answering', async () => {
    // 90s of silence (DEGRADED_AFTER_MS) is the deliberate threshold — long
    // enough that one slow long-poll never trips it.
    await expect(page.getByRole('status').filter({ hasText: /Reconnecting|Offline/ })).toBeVisible({
      timeout: RETRY_WINDOW_MS,
    })
  })

  await test.step('the loop abandons the stalled request and tries again', async () => {
    // THE regression assertion. Before the watchdog there was exactly one
    // attempt, forever: the loop sat awaiting a fetch that never settled, so no
    // supervision could see anything wrong.
    const first = attempts
    await expect
      .poll(() => attempts, { timeout: RETRY_WINDOW_MS, intervals: [2_000] })
      .toBeGreaterThan(first)
  })

  await test.step('and the UI recovers on its own once sync answers again', async () => {
    hanging = false
    // No reload here, deliberately — needing one is the bug.
    //
    // Assert on the OVERLAY, not just the badge. They are one component at two
    // thresholds (90s → badge, 300s → blocking overlay), so once the state has
    // reached `down` the badge is not rendered at all and a `toBeHidden` check on
    // it passes for entirely the wrong reason. That is what this test did, and it
    // is why it appeared to verify recovery while actually verifying nothing —
    // then failed one step later on a click the overlay was intercepting.
    //
    // The overlay clearing is also the user-visible symptom this whole issue was
    // reported as: a page-blocking dialog promising automatic recovery that never
    // came. This is the assertion that pins it.
    await expect(page.locator('.conn-overlay')).toBeHidden({ timeout: RECOVERY_WINDOW_MS })
    await expect(page.getByRole('status').filter({ hasText: /Reconnecting|Offline/ })).toBeHidden({
      timeout: RECOVERY_WINDOW_MS,
    })
  })

  await test.step('and the workspace is usable again', async () => {
    await page.getByRole('button', { name: 'New entry' }).click()
    await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
    await page.getByPlaceholder('Enter name').fill('After recovery')
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.getByRole('button', { name: 'Return' }).click()
    await expect(page.locator('tbody tr', { hasText: 'After recovery' })).toBeVisible({
      timeout: 60_000,
    })
  })

  await context.close()
})
