import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * Kanban and card views must render VALUES, not the identifiers behind them.
 *
 * Both hand-rolled their cell output — `{k}` as the label and `String(v)` as
 * the value — instead of using the shared registry the grid and entry view go
 * through. So a reference column printed `row_1785603483495_1_2`, a member
 * column printed a raw MXID, and a date printed an ISO string. The tell was
 * that a kanban card rendered its assignee TWICE, raw in the field list and
 * correctly as an avatar chip three lines below.
 *
 * The assertion here is deliberately the crude one — no `row_…` anywhere in
 * the rendered board — because that is the actual user-visible symptom, and it
 * cannot be satisfied by a renderer that merely looks plausible.
 */

const rowIdPattern = /row_\d{6,}/

async function seedDemo(page: Page, name: string) {
  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Workspace name').fill(name)
  await expect
    .poll(async () => dialog.locator('.nwm__tile').count(), { timeout: 60_000 })
    .toBeGreaterThan(2)
  await dialog.locator('.nwm__tile', { hasText: /^Demo Workspace/ }).click()
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 120_000 })
}

test('kanban cards show names and labels, never row ids', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('kanban'))
  await captureMasterKey(page)
  await seedDemo(page, 'Kanban Rendering')

  // The demo ships a "Board" kanban over Projects, whose rows carry a
  // reference (Client), a multi-reference (Stakeholders) and a date.
  await page.locator('.sidebar__item-label', { hasText: /^Board$/ }).click()
  await expect(page.locator('.kcard').first()).toBeVisible({ timeout: 120_000 })

  const board = await page.locator('.kanban-board').innerText()

  // The symptom, stated plainly.
  expect(
    board,
    `a raw row id is visible on the board:\n${board.slice(0, 600)}`,
  ).not.toMatch(rowIdPattern)

  // References resolve to their display column…
  expect(board).toContain('Dana Whitfield')

  // …and labels are display names, not column ids.
  expect(board).toContain('Due date')
  expect(board, 'the raw column id leaked as a label').not.toContain('due_date')

  // The assignee was the giveaway: it rendered raw in the field list while the
  // footer chip resolved correctly. A bare MXID anywhere means that is back.
  expect(board, 'a raw MXID is visible').not.toMatch(/@[a-z0-9._-]+:[a-z]/i)
})

test('card view shows names and labels, never row ids', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('cardv'))
  await captureMasterKey(page)
  await seedDemo(page, 'Card Rendering')

  await page.locator('.sidebar__item-label', { hasText: /^Projects$/ }).click()
  await expect(page).toHaveURL(/\/table\//, { timeout: 120_000 })

  // The card view is a route on the table rather than a saved view.
  await page.goto(page.url().replace(/\/table\/([^/]+).*$/, '/table/$1/cards'))
  await expect(page.locator('.entry-card').first()).toBeVisible({ timeout: 120_000 })

  const grid = await page.locator('.card-grid').innerText()
  expect(grid, `a raw row id is visible on the cards:\n${grid.slice(0, 600)}`).not.toMatch(
    rowIdPattern,
  )
  expect(grid, 'the raw column id leaked as a label').not.toContain('due_date')
})
