import { test, expect } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
  addColumn,
} from './helpers'

/**
 * The column ⋯ menu has to be clickable, which is not the same as existing.
 *
 * It reported as "column settings render behind the grid". The cause was not
 * z-index: the menu is anchored inside a <th> that clips (`overflow: hidden`,
 * so header text truncates) and inside `.table-scroll` (`overflow: auto`). A
 * clipping ancestor cannot be escaped by raising z-index — the dropdown was
 * being cut off by the grid, not painted under it. It is now portalled to
 * <body> and positioned from the anchor's rect.
 *
 * So the assertion here is a HIT TEST, not visibility: `elementFromPoint` at
 * the menu item's own centre must land inside the dropdown. A clipped element
 * can still report as "visible" to a naive check while being unreachable to a
 * click, which is exactly the failure being fixed.
 */
test('the column menu opens over the grid and its items are clickable', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('colmenu'))
  await captureMasterKey(page)

  await createWorkspace(page, 'Column Menu WS')
  await createTable(page, 'Things')
  // Enough columns that the header row is busy and the menu opens against a
  // cell edge rather than in open space.
  await addColumn(page, 'Owner', 'Text')
  await addColumn(page, 'Stage', 'Select', 'Todo, Doing, Done')

  const header = page.locator('th', { hasText: 'Stage' })
  await header.hover()
  await header.getByRole('button', { name: /column options/i }).click()

  const dropdown = page.locator('.col-menu__dropdown')
  await expect(dropdown).toBeVisible()

  // Not clipped, and nothing is over it: the point at the centre of "Edit
  // column…" must actually belong to the dropdown.
  const item = dropdown.getByRole('button', { name: /edit column/i })
  const box = await item.boundingBox()
  expect(box, 'the menu item should have a layout box').not.toBeNull()

  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return {
        insideDropdown: !!el?.closest('.col-menu__dropdown'),
        got: el?.className ?? '(nothing)',
      }
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2] as const,
  )
  expect(
    hit.insideDropdown,
    `the point over "Edit column…" hit ${hit.got} instead of the dropdown — it is clipped or covered`,
  ).toBe(true)

  // And it works end to end: the item opens the edit modal.
  await item.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByRole('heading', { name: /edit column/i })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /save changes/i })).toBeVisible()
})
