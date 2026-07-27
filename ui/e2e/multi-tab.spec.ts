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
 * The same account in two TABS (issue 9e9efe94).
 *
 * Distinct from `collaboration.spec.ts`, which is two accounts in two isolated
 * browser contexts. Here both tabs live in ONE context, so they share
 * localStorage, the session blob, and — the part that can actually break — the
 * same IndexedDB crypto store. Two matrix-rust-sdk clients over one store,
 * each running its own sync loop.
 *
 * Three things this pins:
 *
 *  1. A second tab restores the session without a verification gate. It is the
 *     same device; being asked to verify again would be a bug.
 *  2. Edits cross tabs. The write path broadcasts a data-free "something
 *     changed" ping (`notifyWorkspaceChanged`) and each tab re-reads from its
 *     own workspace — no plaintext ever crosses the channel.
 * What is NOT asserted as passing — and is quarantined at the bottom of this
 * file with the evidence — is anything involving the second tab's WRITE path,
 * or tab A's write path once a second tab exists. Both are broken today.
 *
 * Note the assertions bring a tab to the front before checking it. That is the
 * actual contract, not a workaround: `useTable` deliberately marks a HIDDEN tab
 * as needing a refresh and re-reads on `visibilitychange` rather than
 * re-rendering in the background. So the guarantee is "a backgrounded tab
 * catches up when you return to it" — asserting instant propagation into a
 * hidden tab would be testing behaviour the app intentionally does not have.
 * (Found the hard way: the first draft of this spec failed on exactly that.)
 */

function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
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
 * KNOWN LIMITATION, deliberately quarantined rather than deleted (issue filed
 * 2026-07-26): a SECOND tab can read and stay in sync, but its writes never
 * reach the server.
 *
 * Evidence, from the second tab's own console:
 *
 *   [auth] initialSync timed out (another tab may hold the sync stream).
 *          Continuing with cached session — workspace init will retry.
 *
 * The account has one Matrix client per IndexedDB crypto store, and the first
 * tab holds the sync stream. The second tab materializes state fine — it
 * receives events and re-reads — but nothing it writes is ever sent, and it
 * reports no error, so the edit simply looks applied. That is the dangerous
 * part: silent, not visibly broken.
 *
 * Left as `fixme` so the day it starts working, this fails loudly and gets
 * promoted, rather than the gap quietly persisting untested.
 */
test.fixme('writes from a second tab reach the server', async ({ browser }) => {
  const context = await browser.newContext()
  const tabA = await context.newPage()
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
  await tabB.goto(tabA.url())
  await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })

  await editCell(tabB, 'Alpha', 'Alpha from B')
  await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 30_000 })

  // A reload reads the server's copy, not tab B's optimistic state.
  await tabB.reload()
  await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 180_000 })

  await context.close()
})

/**
 * KNOWN LIMITATION #2, from the same investigation: once a second tab has
 * initialized, tab A's grid can lose its rows entirely — the row it wrote
 * itself is no longer found, 60s after being brought back to the front.
 *
 * NOT root-caused. It is recorded here rather than guessed at, because the two
 * candidate explanations have very different severity: benign (tab A's re-read
 * races the sibling's store activity and recovers) versus serious (a second tab
 * corrupts the first tab's materialized state). Deciding that needs the store
 * layer instrumented, which is issue work, not test work.
 */
test.fixme('tab A keeps writing while tab B is open', async ({ browser }) => {
  const context = await browser.newContext()
  const tabA = await context.newPage()
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
  await tabB.goto(tabA.url())
  await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })

  await tabA.bringToFront()
  await editCell(tabA, 'Beta', 'Beta from A')

  // A reload reads the server's copy, not tab A's optimistic state.
  await tabA.reload()
  await expect(gridRow(tabA, 'Beta from A')).toBeVisible({ timeout: 180_000 })

  await context.close()
})
