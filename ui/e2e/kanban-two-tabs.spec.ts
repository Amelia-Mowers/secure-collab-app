/**
 * Two tabs, one user, one kanban board — the shape the existing kanban drag
 * test does not have.
 *
 * Reported from production: dragging a card between columns took the wasm
 * module down with a bare `unreachable executed` (a Rust panic, unattributable
 * because the release profile is panic=abort + strip) and POISONED it — every
 * later call failed, so the tab was dead until reload. The console showed
 * `[broadcast] Change signal from sibling tab, triggering re-read` immediately
 * before each panic, which is exactly what `workflows.spec.ts` cannot produce:
 * it drives a single page, and a single page never broadcasts to itself.
 *
 * So the variable under test is not the drag. It is a drag while a second tab
 * is reading the same workspace, through the same shared worker. Everything
 * else is copied from the passing test on purpose.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  registerDevice,
  uniqueUser,
  homeserverUrl,
  createWorkspace,
  createTable,
  addColumn,
  captureMasterKey,
} from './helpers'

/** Drag with intermediate mouse positions — a one-shot dragTo silently no-ops
 *  against dnd-kit (same reason workflows.spec.ts hand-rolls this). */
async function dragCardToColumn(page: Page, cardText: string, columnTitle: string) {
  const card = page.getByText(cardText, { exact: true }).first()
  const column = page.getByText(columnTitle, { exact: true }).first()
  const from = await card.boundingBox()
  const to = await column.boundingBox()
  if (!from || !to) throw new Error(`missing bounding box for drag: ${cardText} → ${columnTitle}`)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / 8,
      from.y + ((to.y - from.y) * i) / 8 + 40,
      { steps: 2 },
    )
  }
  await page.mouse.up()
}

test('kanban: dragging with a sibling tab open does not kill the wasm module', async ({
  browser,
}) => {
  test.setTimeout(600_000)

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Any Rust panic reaches the console as this, with or without a message.
  // Watch BOTH tabs: the module they share is what gets poisoned.
  const panics: string[] = []
  const watch = (p: Page, label: string) => {
    p.on('console', (m) => {
      const t = m.text()
      if (t.includes('unreachable executed') || t.includes('panicked at')) {
        panics.push(`[${label}] ${t}`)
      }
    })
    p.on('pageerror', (e) => {
      const t = String(e)
      if (t.includes('unreachable') || t.includes('panicked')) panics.push(`[${label}] ${t}`)
    })
  }
  watch(page, 'tab1')

  await registerDevice(page, homeserverUrl(), uniqueUser('ktabs'))
  await captureMasterKey(page)
  await createWorkspace(page, 'Kanban Two Tabs')
  await createTable(page, 'Work')
  await addColumn(page, 'Status', 'Select', 'Todo, Doing, Done')

  // Five cards, not two: a drop rewrites the `_order` key of every card that
  // shifted, so a fuller column means a burst of writes rather than one.
  for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
    await page.getByRole('button', { name: 'New entry' }).click()
    await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
    await page.getByPlaceholder('Enter name').fill(title)
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.locator('select.cell-input--select').selectOption('Todo')
    await page.getByRole('button', { name: 'Return' }).click()
    await expect(page.locator('tbody tr', { hasText: title })).toBeVisible({ timeout: 30_000 })
  }

  await test.step('create a board grouped by Status', async () => {
    await page.getByRole('button', { name: 'New view' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('My View').fill('Board')
    await dialog.locator('.nvm__type-tile', { hasText: 'Kanban' }).first().click()
    await dialog
      .locator('.nvm__form-group', { hasText: 'Group by column' })
      .locator('select')
      .selectOption({ label: 'Status' })
    await dialog
      .locator('.nvm__form-group', { hasText: 'Card title column' })
      .locator('select')
      .selectOption({ label: 'Name' })
    await dialog.getByRole('button', { name: 'Create view' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await expect(page).toHaveURL(/\/view\//, { timeout: 60_000 })
  })

  // THE VARIABLE: a second tab on the same board, reading while tab 1 writes.
  const sibling = await ctx.newPage()
  watch(sibling, 'tab2')
  await sibling.goto(page.url())
  await expect(sibling.getByText('Alpha', { exact: true }).first()).toBeVisible({ timeout: 90_000 })

  await test.step('drag, twice, with the sibling watching', async () => {
    await dragCardToColumn(page, 'Alpha', 'Doing')
    await page.waitForTimeout(2500)
    await dragCardToColumn(page, 'Beta', 'Done')
    await page.waitForTimeout(2500)
  })

  expect(panics, `wasm panicked during the drag:\n${panics.join('\n')}`).toEqual([])

  // A poisoned module answers nothing, so prove the workspace still works
  // rather than only that nothing was logged.
  await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()
  await sibling.reload()
  await expect(sibling.getByText('Alpha', { exact: true }).first()).toBeVisible({ timeout: 90_000 })

  await ctx.close()
})
