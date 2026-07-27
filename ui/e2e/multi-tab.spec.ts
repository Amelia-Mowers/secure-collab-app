import { test, expect, type Page } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
} from './helpers'

/**
 * The same account in two TABS (issues 9e9efe94, 87bf86a6).
 *
 * Distinct from `collaboration.spec.ts`, which is two accounts in two isolated
 * browser contexts. Here both tabs live in ONE context, so they share
 * localStorage, the session blob, and — the part that used to break — the same
 * IndexedDB crypto store.
 *
 * The two tests at the bottom of this file were `test.fixme` until the client
 * moved into a SharedWorker (issue 87bf86a6). They are the point of that work, so
 * the history is worth keeping: two tabs are the SAME Matrix device, and two
 * matrix-rust-sdk clients over one crypto store do not work. The sync stream has a
 * single holder, so the second tab's `initialSync` timed out and everything it
 * wrote queued into a client that never got to send — with no error, so the edit
 * merely LOOKED applied. Now one client lives in the worker and every tab drives
 * it, so both tabs write and both writes stick.
 *
 * What this pins:
 *
 *  1. A second tab restores the session without a verification gate. It is the
 *     same device; being asked to verify again would be a bug — and there is now
 *     only one client, so there is nothing to verify against.
 *  2. Edits cross tabs, in BOTH directions, and survive a reload — which is the
 *     only assertion that means anything here, since the old bug rendered the
 *     edit locally and dropped it silently.
 *  3. A backgrounded tab catches up. Assertions bring a tab to the front before
 *     checking it, which is the honest contract rather than a workaround.
 */

function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
}

/**
 * Surface a tab's worker lines and anything that failed.
 *
 * Not decoration: with the client in a SharedWorker, its console is not the
 * tab's, and a silent console is how the last two bugs here hid. Everything in
 * this file is a two-tab interaction, where "the row just didn't change" is the
 * symptom of half a dozen different causes.
 */
function trace(page: Page, label: string) {
  page.on('console', m => {
    const text = m.text()
    if (text.startsWith('[worker]') || m.type() === 'error') console.log(`[${label}] ${text}`)
  })
  page.on('pageerror', e => console.log(`[${label} error] ${e.message}`))
}

/** Edit a text cell in place, committing on Enter. */
async function editCell(page: Page, currentText: string, next: string) {
  // Wait for the row before reaching into it: a tab that has just been brought
  // to the front re-reads on `visibilitychange`, so its grid can lag a moment.
  const row = gridRow(page, currentText)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.locator('.cell-click').first().click()
  const editor = page.locator('input.cell-input[type="text"]')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await editor.fill(next)
  await editor.press('Enter')
}

test('two tabs, one account: no re-verification, and A→B propagation', async ({
  browser,
}) => {
  test.setTimeout(600_000)

  const context = await browser.newContext()
  const tabA = await context.newPage()
  trace(tabA, 'A')

  await registerDevice(tabA, homeserverUrl(), uniqueUser('mtab'))
  await captureMasterKey(tabA)
  await createWorkspace(tabA, 'Two Tabs')
  await createTable(tabA, 'Items')

  await test.step('seed two rows in tab A', async () => {
    for (const name of ['Alpha', 'Beta']) {
      await tabA.getByRole('button', { name: 'New entry' }).click()
      await expect(tabA.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
      await tabA.getByPlaceholder('Enter name').fill(name)
      await tabA.getByPlaceholder('Enter name').press('Enter')
      await tabA.getByRole('button', { name: 'Return' }).click()
      await expect(gridRow(tabA, name)).toBeVisible({ timeout: 30_000 })
    }
  })

  const tableUrl = tabA.url()

  // ── A second tab of the same device ────────────────────────────────────────
  const tabB = await context.newPage()
  trace(tabB, 'B')

  await test.step('tab B opens the same table without a verification gate', async () => {
    await tabB.goto(tableUrl)
    // The gate would be a dialog asking to verify this device. Same device,
    // same store: there is nothing to verify, so the data should just appear.
    await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })
    await expect(gridRow(tabB, 'Beta')).toBeVisible({ timeout: 60_000 })
    await expect(
      tabB.getByRole('dialog').getByRole('heading', { name: /verify this device/i }),
    ).toBeHidden()
  })

  await test.step('an edit in A shows up in B when B is focused', async () => {
    await tabA.bringToFront()
    await editCell(tabA, 'Alpha', 'Alpha from A')
    await expect(gridRow(tabA, 'Alpha from A')).toBeVisible({ timeout: 30_000 })

    await tabB.bringToFront()
    await expect(gridRow(tabB, 'Alpha from A')).toBeVisible({ timeout: 120_000 })
  })

  await context.close()
})

/**
 * Was `test.fixme` until the client moved into the SharedWorker (issue 87bf86a6).
 *
 * The bug it records: the account had one Matrix client per IndexedDB crypto
 * store, the first tab held the sync stream, and the second tab's own console
 * said so —
 *
 *   [auth] initialSync timed out (another tab may hold the sync stream).
 *          Continuing with cached session — workspace init will retry.
 *
 * It materialized state fine and reported NO error, so the edit simply looked
 * applied. Silent, not visibly broken, which is why the reload below is the
 * assertion that matters: it reads the server's copy, not the tab's optimistic
 * state.
 */
test('writes from a second tab reach the server', async ({ browser }) => {
  // Registration, a workspace, a table, a row, a second tab, an edit AND a reload
  // do not fit in the default 180s — and when they don't, the failure looks
  // exactly like the bug this test exists to catch. Same budget as the first test
  // in this file.
  test.setTimeout(600_000)

  const context = await browser.newContext()
  const tabA = await context.newPage()
  trace(tabA, 'A')
  await registerDevice(tabA, homeserverUrl(), uniqueUser('mtabw'))
  await captureMasterKey(tabA)
  await createWorkspace(tabA, 'Second Tab Writes')
  await createTable(tabA, 'Items')
  await tabA.getByRole('button', { name: 'New entry' }).click()
  await tabA.getByPlaceholder('Enter name').fill('Alpha')
  await tabA.getByPlaceholder('Enter name').press('Enter')
  await tabA.getByRole('button', { name: 'Return' }).click()
  await expect(gridRow(tabA, 'Alpha')).toBeVisible({ timeout: 30_000 })

  const tabB = await context.newPage()
  trace(tabB, 'B')
  await tabB.goto(tabA.url())
  await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })

  await tabB.bringToFront()
  await editCell(tabB, 'Alpha', 'Alpha from B')
  await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 30_000 })

  // A reload reads the server's copy, not tab B's optimistic state.
  await tabB.reload()
  await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 180_000 })

  await context.close()
})

/**
 * Also `test.fixme` until 87bf86a6. Its symptom was the other half of one crypto
 * store having two writers: once a second tab existed, tab A's grid could lose its
 * rows entirely — the row it had written itself was no longer found, 60s after
 * being brought back to the front. Never root-caused at the store layer, because
 * the fix removed the second writer instead.
 */
test('tab A keeps writing while tab B is open', async ({ browser }) => {
  test.setTimeout(600_000)

  const context = await browser.newContext()
  const tabA = await context.newPage()
  trace(tabA, 'A')
  await registerDevice(tabA, homeserverUrl(), uniqueUser('mtaba'))
  await captureMasterKey(tabA)
  await createWorkspace(tabA, 'First Tab Writes')
  await createTable(tabA, 'Items')
  for (const name of ['Alpha', 'Beta']) {
    await tabA.getByRole('button', { name: 'New entry' }).click()
    await tabA.getByPlaceholder('Enter name').fill(name)
    await tabA.getByPlaceholder('Enter name').press('Enter')
    await tabA.getByRole('button', { name: 'Return' }).click()
    await expect(gridRow(tabA, name)).toBeVisible({ timeout: 30_000 })
  }

  const tabB = await context.newPage()
  trace(tabB, 'B')
  await tabB.goto(tabA.url())
  await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })

  await tabA.bringToFront()
  await editCell(tabA, 'Beta', 'Beta from A')

  // A reload reads the server's copy, not tab A's optimistic state.
  await tabA.reload()
  await expect(gridRow(tabA, 'Beta from A')).toBeVisible({ timeout: 180_000 })
  // And tab A still has the row it wrote before tab B existed — the second
  // symptom of two writers over one store.
  await expect(gridRow(tabA, 'Alpha')).toBeVisible({ timeout: 60_000 })

  await test.step("tab B sees tab A's edit without a reload", async () => {
    // Stronger than "eventually consistent": the worker pushes state to every
    // subscribed tab as soon as the write lands, so this needs neither a
    // homeserver round-trip nor the visibility-change catch-up.
    await tabB.bringToFront()
    await expect(gridRow(tabB, 'Beta from A')).toBeVisible({ timeout: 120_000 })
  })

  await context.close()
})
