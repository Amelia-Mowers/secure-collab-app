import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
} from './helpers'

/**
 * The two behaviours `multi-tab.spec.ts` quarantines as `test.fixme`, run with
 * the Matrix client in the SharedWorker (issue 87bf86a6, stage 3).
 *
 * This is the whole point of the exercise, so it is asserted the only way that
 * means anything: **reload the tab and read the server's copy**. Materialized
 * state proves nothing here — the bug is that a second tab's write looks applied
 * locally, reports no error, and never leaves the device.
 *
 * When the worker path becomes the default (stage 4) this spec and the two
 * `fixme`s in `multi-tab.spec.ts` collapse into one.
 */

/** A context whose pages all opt into the worker path before any app code runs. */
async function workerContext(browser: {
  newContext: () => Promise<BrowserContext>
}): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    localStorage.setItem('collab:sharedWorker', 'on')
  })
  return context
}

function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
}

/** Edit a text cell in place, committing on Enter. */
async function editCell(page: Page, currentText: string, next: string) {
  const row = gridRow(page, currentText)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.locator('.cell-click').first().click()
  const editor = page.locator('input.cell-input[type="text"]')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await editor.fill(next)
  await editor.press('Enter')
}

async function addRow(page: Page, name: string) {
  await page.getByRole('button', { name: 'New entry' }).click()
  await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
  await page.getByPlaceholder('Enter name').fill(name)
  await page.getByPlaceholder('Enter name').press('Enter')
  await page.getByRole('button', { name: 'Return' }).click()
  await expect(gridRow(page, name)).toBeVisible({ timeout: 30_000 })
}

test('two tabs on the shared worker: both tabs write, and the writes stick', async ({ browser }) => {
  test.setTimeout(900_000)

  const context = await workerContext(browser)
  const tabA = await context.newPage()
  tabA.on('console', m => {
    const text = m.text()
    if (text.startsWith('[worker]')) console.log(`[A] ${text}`)
  })

  await registerDevice(tabA, homeserverUrl(), uniqueUser('mtw'))
  await captureMasterKey(tabA)
  await createWorkspace(tabA, 'Worker Tabs')
  await createTable(tabA, 'Items')
  await addRow(tabA, 'Alpha')
  await addRow(tabA, 'Beta')

  const tableUrl = tabA.url()

  const tabB = await context.newPage()
  tabB.on('console', m => {
    const text = m.text()
    if (text.startsWith('[worker]')) console.log(`[B] ${text}`)
  })

  await test.step('tab B joins the running client — no second one, no verify gate', async () => {
    await tabB.goto(tableUrl)
    // Same device, same store: being asked to verify again would be a bug, and
    // with one client there is not even a second store to reconcile.
    await expect(gridRow(tabB, 'Alpha')).toBeVisible({ timeout: 180_000 })
    await expect(gridRow(tabB, 'Beta')).toBeVisible({ timeout: 60_000 })
    await expect(
      tabB.getByRole('dialog').getByRole('heading', { name: /verify this device/i }),
    ).toBeHidden()
  })

  await test.step("a write from the SECOND tab survives a reload — fixme #1", async () => {
    // The quarantined case. Its old symptom: the edit rendered, no error
    // appeared, and the write never reached the server — so the reload below
    // showed the ORIGINAL value.
    await tabB.bringToFront()
    await editCell(tabB, 'Alpha', 'Alpha from B')
    await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 30_000 })

    await tabB.reload()
    await expect(gridRow(tabB, 'Alpha from B')).toBeVisible({ timeout: 180_000 })
  })

  await test.step("and tab A keeps writing while tab B is open — fixme #2", async () => {
    await tabA.bringToFront()
    await editCell(tabA, 'Beta', 'Beta from A')
    await expect(gridRow(tabA, 'Beta from A')).toBeVisible({ timeout: 30_000 })

    await tabA.reload()
    await expect(gridRow(tabA, 'Beta from A')).toBeVisible({ timeout: 180_000 })
    // Tab A's own row is still there too — the other quarantined symptom was
    // tab A's grid losing its rows once a second tab existed.
    await expect(gridRow(tabA, 'Alpha from B')).toBeVisible({ timeout: 60_000 })
  })

  await test.step("each tab sees the other's edit without being reloaded", async () => {
    // Not just "eventually consistent after a reload": the worker pushes state to
    // every subscribed tab as soon as a write lands, so this needs no round-trip
    // through the homeserver and no visibility change.
    await tabB.bringToFront()
    await expect(gridRow(tabB, 'Beta from A')).toBeVisible({ timeout: 120_000 })

    await tabA.bringToFront()
    await editCell(tabA, 'Alpha from B', 'Alpha edited by A')
    await tabB.bringToFront()
    await expect(gridRow(tabB, 'Alpha edited by A')).toBeVisible({ timeout: 120_000 })
  })

  await context.close()
})
