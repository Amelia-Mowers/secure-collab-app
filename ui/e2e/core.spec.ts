import { test, expect, type Page, type Locator } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * Core single-device product behaviour (TODO.md "E2E — Core behaviour"):
 * workspace → table → columns across types → entries → inline grid edit →
 * header sort → global filter → kanban/card views → view switching → and the
 * load-bearing assertion that it all **persists across a reload** (cold-start
 * materialization from the encrypted room timeline, review §4.4).
 *
 * One journey, one registration: every step builds on real prior state, which
 * is exactly what the unit tests (MockWorkspace) can't cover.
 */

// ── Flow helpers ────────────────────────────────────────────────────────────

async function createWorkspace(page: Page, name: string) {
  await page.locator('.workspace-card--new').click()
  await page.getByPlaceholder('Workspace name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // Room creation + encryption enablement + initial sync.
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'New table' })).toBeVisible({ timeout: 90_000 })
}

async function createTable(page: Page, name: string) {
  await page.getByRole('button', { name: 'New table' }).click()
  const input = page.getByPlaceholder('Table name...')
  await input.fill(name)
  await input.press('Enter')
  // createTable navigates to the new table's grid on success.
  await expect(page).toHaveURL(new RegExp(`/table/${name.toLowerCase()}`), { timeout: 90_000 })
}

/** Add a column via the toolbar "Add column" button + modal. */
async function addColumn(page: Page, name: string, typeLabel: string, options?: string) {
  await page.getByRole('button', { name: 'Add column' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('e.g. Priority').fill(name)
  // Anchored: a plain "Select" substring would also match the "Multi-select" row.
  await dialog.locator('.acm__type-row', { hasText: new RegExp(`^${typeLabel}`) }).click()
  if (options !== undefined) {
    await dialog.getByPlaceholder('Todo, In Progress, Done').fill(options)
  }
  await dialog.getByRole('button', { name: 'Add column' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 30_000 })
}

/** A data row in the grid (excludes the virtualizer's aria-hidden spacer rows). */
function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
}

// ── The journey ─────────────────────────────────────────────────────────────

test('core journey: table, typed cells, sort/filter, views, reload persistence', async ({ page }) => {
  // Many real Matrix round-trips (room creation, ~40 cell events, reload +
  // cold start) — give the whole journey more than the default 180s.
  test.setTimeout(420_000)

  await test.step('register and create a workspace', async () => {
    await registerDevice(page, homeserverUrl(), uniqueUser('core'))
    await captureMasterKey(page)
    await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })
    await createWorkspace(page, 'Core E2E')
  })

  await test.step('create a table and add a column of each type', async () => {
    await createTable(page, 'Tasks')
    // The new table starts with a "Name" text column.
    await expect(page.locator('th', { hasText: 'Name' })).toBeVisible({ timeout: 30_000 })
    await addColumn(page, 'Priority', 'Select', 'Low, Medium, High')
    await addColumn(page, 'Points', 'Number')
    await addColumn(page, 'Done', 'Checkbox')
    await addColumn(page, 'Due', 'Date')
    await addColumn(page, 'Tags', 'Multi-select', 'alpha, beta')
  })

  await test.step('create entries through the entry view', async () => {
    await page.getByRole('button', { name: 'New entry' }).click()
    await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })

    // First entry exercises every editor type (commit on blur/Enter/toggle).
    await page.getByPlaceholder('Enter name').fill('Alpha task')
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.locator('select.cell-input--select').selectOption('High')
    await page.locator('input.cell-input--number').fill('3')
    await page.locator('input.cell-input--number').press('Enter')
    await page.locator('.cell-checkbox input').check()
    await page.locator('input.cell-input--date').fill('2026-06-11')
    await page.locator('input.cell-input--date').blur()
    await page.locator('.cell-multiselect__input').fill('alpha')
    await page.locator('.cell-multiselect__input').press('Enter')

    // Chain two more entries from the entry view's "New entry" action.
    await page.getByRole('button', { name: 'New entry' }).click()
    await page.getByPlaceholder('Enter name').fill('Beta task')
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.locator('select.cell-input--select').selectOption('Low')

    await page.getByRole('button', { name: 'New entry' }).click()
    await page.getByPlaceholder('Enter name').fill('Gamma task')
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.locator('select.cell-input--select').selectOption('Medium')

    await page.getByRole('button', { name: 'Return' }).click()
  })

  await test.step('grid renders the typed cell values', async () => {
    const alpha = gridRow(page, 'Alpha task')
    await expect(alpha).toBeVisible({ timeout: 30_000 })
    await expect(alpha.locator('.cell-pill', { hasText: 'High' })).toBeVisible()
    await expect(alpha).toContainText('3')
    await expect(alpha.locator('.cell-display--bool')).toHaveText('✓')
    await expect(alpha).toContainText('2026-06-11')
    await expect(alpha.locator('.cell-tag', { hasText: 'alpha' })).toBeVisible()
    await expect(gridRow(page, 'Beta task')).toBeVisible()
    await expect(gridRow(page, 'Gamma task')).toBeVisible()
  })

  await test.step('inline edit commits one update on Enter', async () => {
    await gridRow(page, 'Beta task').locator('.cell-click', { hasText: 'Beta task' }).click()
    const editor = page.locator('input.cell-input[type="text"]')
    await expect(editor).toBeVisible()
    await editor.fill('Beta task v2')
    await editor.press('Enter')
    await expect(gridRow(page, 'Beta task v2')).toBeVisible({ timeout: 30_000 })
  })

  await test.step('header click sorts ascending then descending', async () => {
    const nameHeader = page.locator('th', { hasText: 'Name' })
    const dataRows = page.locator('tbody tr', { hasText: 'task' })
    await nameHeader.click()
    await expect(dataRows.first()).toContainText('Alpha task')
    await nameHeader.click()
    await expect(dataRows.first()).toContainText('Gamma task')
  })

  await test.step('global filter narrows rows and reports matches', async () => {
    await page.getByRole('button', { name: 'Filter' }).click()
    await page.getByPlaceholder(/Search all columns/).fill('beta')
    await expect(page.locator('.table-filter-count')).toHaveText('1 row')
    await expect(gridRow(page, 'Beta task v2')).toBeVisible()
    await expect(gridRow(page, 'Alpha task')).toBeHidden()
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(gridRow(page, 'Alpha task')).toBeVisible()
  })

  await test.step('a per-column filter saves into a view and re-opens filtered from the sidebar', async () => {
    // Filter to High-priority rows via a per-column "where" condition.
    await page.getByRole('button', { name: 'Filter' }).click()
    await page.getByRole('button', { name: /Add condition/ }).click()
    await page.locator('.filter-condition__col').selectOption({ label: 'Priority' })
    await page.locator('.filter-condition__value').selectOption('High')
    await expect(gridRow(page, 'Alpha task')).toBeVisible()
    await expect(gridRow(page, 'Beta task v2')).toBeHidden()

    // Save as a view; the navigation lands on the (still-filtered) saved view.
    await page.getByRole('button', { name: 'Save as view' }).click()
    await page.getByPlaceholder('View name').fill('High priority')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(/\/view\//, { timeout: 30_000 })
    await expect(gridRow(page, 'Alpha task')).toBeVisible({ timeout: 30_000 })
    await expect(gridRow(page, 'Beta task v2')).toBeHidden()

    // Leave to the raw (unfiltered) table, then RE-OPEN the saved view from the
    // sidebar: a table view must route to /view/:id (not the raw table) so its
    // filter re-applies. This is the exact regression we hit.
    await page
      .locator('.sidebar__section', { hasText: 'Tables' })
      .getByRole('button', { name: 'Tasks' })
      .click()
    await expect(gridRow(page, 'Beta task v2')).toBeVisible({ timeout: 30_000 })
    await page
      .locator('.sidebar__section', { hasText: 'Views' })
      .getByText('High priority', { exact: true })
      .click()
    await expect(page).toHaveURL(/\/view\//, { timeout: 30_000 })
    await expect(gridRow(page, 'Alpha task')).toBeVisible({ timeout: 30_000 })
    await expect(gridRow(page, 'Beta task v2')).toBeHidden()
  })

  await test.step('create a kanban view grouped by Priority', async () => {
    await page.getByRole('button', { name: 'New view' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('My View').fill('Board')
    // Kanban is the default view type; pick the group/title axes.
    await dialog
      .locator('.nvm__form-group', { hasText: 'Group by column' })
      .locator('select')
      .selectOption({ label: 'Priority' })
    await dialog
      .locator('.nvm__form-group', { hasText: 'Card title column' })
      .locator('select')
      .selectOption({ label: 'Name' })
    await dialog.getByRole('button', { name: 'Create view' }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    await expect(page).toHaveURL(/\/view\/tasks-board/, { timeout: 30_000 })
    for (const col of ['Low', 'Medium', 'High']) {
      await expect(page.locator('.kcol__title', { hasText: col })).toBeVisible({ timeout: 30_000 })
    }
    const highColumn = page.locator('.kcol', { hasText: 'High' })
    await expect(highColumn.locator('.kcard__title', { hasText: 'Alpha task' })).toBeVisible()
  })

  await test.step('create a card view', async () => {
    await page.getByRole('button', { name: 'New view' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('My View').fill('Gallery')
    await dialog.getByRole('button', { name: 'Card', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create view' }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    // CardView derives its title from the alphabetically-first column key, so
    // 'Alpha task' (the `name` cell) renders as a card field — assert the card.
    await expect(page.locator('.entry-card', { hasText: 'Alpha task' })).toBeVisible({
      timeout: 30_000,
    })
  })

  await test.step('switch between views from the sidebar', async () => {
    await page.getByTestId('view-item-tasks-board').click()
    await expect(page.locator('.kanban-board')).toBeVisible({ timeout: 30_000 })
    // Back to the raw table via the Tables section.
    await page
      .locator('.sidebar__section', { hasText: 'Tables' })
      .getByRole('button', { name: 'Tasks' })
      .click()
    await expect(gridRow(page, 'Alpha task')).toBeVisible({ timeout: 30_000 })
  })

  await test.step('state persists across reload (cold-start materialization)', async () => {
    await page.reload()
    // Session restore + workspace init + timeline cold start + Megolm decrypt.
    const alpha = gridRow(page, 'Alpha task')
    await expect(alpha).toBeVisible({ timeout: 120_000 })
    // Cell values survived, including the post-replay inline edit (HLC §4.1:
    // the edit must not lose LWW against its own history after reload).
    await expect(gridRow(page, 'Beta task v2')).toBeVisible()
    await expect(alpha.locator('.cell-pill', { hasText: 'High' })).toBeVisible()
    await expect(alpha.locator('.cell-display--bool')).toHaveText('✓')
    await expect(alpha).toContainText('2026-06-11')
    // Schema survived (columns added after table creation).
    await expect(page.locator('th', { hasText: 'Priority' })).toBeVisible()
    await expect(page.locator('th', { hasText: 'Tags' })).toBeVisible()
    // Views survived and still materialize.
    await page.getByTestId('view-item-tasks-board').click()
    const highColumn = page.locator('.kcol', { hasText: 'High' })
    await expect(highColumn.locator('.kcard__title', { hasText: 'Alpha task' })).toBeVisible({
      timeout: 30_000,
    })
    await page
      .locator('.sidebar__section', { hasText: 'Tables' })
      .getByRole('button', { name: 'Tasks' })
      .click()
  })

  await test.step('delete a row from the grid', async () => {
    await gridRow(page, 'Gamma task').getByTitle('Delete row').click()
    await expect(gridRow(page, 'Gamma task')).toBeHidden({ timeout: 30_000 })
    await expect(gridRow(page, 'Alpha task')).toBeVisible()
  })
})

// Regression guard for row-deletion persistence: deleting a row writes a
// row-level tombstone cell (`_deleted = true`) that syncs to Matrix, so the
// deletion survives a cold-start reload instead of resurrecting from the
// timeline. See bridge_matrix.rs `delete_row` / ROW_DELETED_COLUMN.
test('a deleted row stays deleted after reload', async ({ page }) => {
  test.setTimeout(300_000)
  await registerDevice(page, homeserverUrl(), uniqueUser('del'))
  await captureMasterKey(page)
  await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })
  await createWorkspace(page, 'Delete E2E')
  await createTable(page, 'Items')

  await page.getByRole('button', { name: 'New entry' }).click()
  await page.getByPlaceholder('Enter name').fill('Doomed row')
  await page.getByPlaceholder('Enter name').press('Enter')
  await page.getByRole('button', { name: 'Return' }).click()

  const row = gridRow(page, 'Doomed row')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByTitle('Delete row').click()
  await expect(row).toBeHidden({ timeout: 30_000 })

  // The grid removes the row optimistically and sends the `_deleted` tombstone
  // to Matrix in the background. Let those background sends drain before we
  // reload — otherwise we'd race the network (reloading mid-send) and the cold
  // start would legitimately not yet see the tombstone. This is a property of
  // the optimistic write model, not of the deletion itself.
  await page.waitForTimeout(4000)

  await page.reload()
  await expect(page.locator('th', { hasText: 'Name' })).toBeVisible({ timeout: 120_000 })
  await expect(gridRow(page, 'Doomed row')).toBeHidden()
})

// Table-level delete + reorder persistence (issue c36f496d). Deleting a table
// writes a `_tables` registry tombstone (+ deleted_at cutoff) and reordering
// writes a fractional `_order` cell — both sync to Matrix, so they survive a
// cold-start reload (the durability the MockWorkspace unit tests can't cover).
test('table delete and reorder persist after reload', async ({ page }) => {
  test.setTimeout(300_000)
  page.on('dialog', dialog => dialog.accept()) // auto-accept the delete confirm

  await registerDevice(page, homeserverUrl(), uniqueUser('tbl'))
  await captureMasterKey(page)
  await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })
  await createWorkspace(page, 'Tables E2E')

  await createTable(page, 'Apples')
  await createTable(page, 'Bananas')

  const tablesSection = page.locator('.sidebar__section', { hasText: 'Tables' })
  const items = tablesSection.locator('.sidebar__item--table')
  await expect(items).toHaveCount(2, { timeout: 30_000 })
  // Default order is by id: apples, then bananas.
  await expect(items.nth(0)).toContainText('Apples')
  await expect(items.nth(1)).toContainText('Bananas')

  // Drag 'Bananas' up onto 'Apples' to reorder. dnd-kit needs real pointer
  // movement past its 6px activation threshold, so drive the mouse in steps
  // rather than Playwright's one-shot dragTo.
  const dragUp = async (from: Locator, to: Locator) => {
    const s = await from.boundingBox()
    const t = await to.boundingBox()
    if (!s || !t) throw new Error('missing bounding box for drag')
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 10, { steps: 5 })
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 })
    await page.mouse.up()
  }
  await dragUp(items.filter({ hasText: 'Bananas' }), items.filter({ hasText: 'Apples' }))
  await expect(items.nth(0)).toContainText('Bananas', { timeout: 30_000 })
  await expect(items.nth(1)).toContainText('Apples')

  // Drain background sends, then cold-start reload: the new order must persist.
  await page.waitForTimeout(4000)
  await page.reload()
  const afterReorder = page.locator('.sidebar__section', { hasText: 'Tables' }).locator('.sidebar__item--table')
  await expect(afterReorder).toHaveCount(2, { timeout: 120_000 })
  await expect(afterReorder.nth(0)).toContainText('Bananas')
  await expect(afterReorder.nth(1)).toContainText('Apples')

  // Delete 'Apples'; it disappears immediately and stays gone after reload.
  await page.locator('.sidebar__section', { hasText: 'Tables' }).getByTitle('Delete table Apples').click()
  await expect(afterReorder).toHaveCount(1, { timeout: 30_000 })
  await expect(afterReorder.nth(0)).toContainText('Bananas')

  await page.waitForTimeout(4000)
  await page.reload()
  const afterDelete = page.locator('.sidebar__section', { hasText: 'Tables' }).locator('.sidebar__item--table')
  await expect(afterDelete).toHaveCount(1, { timeout: 120_000 })
  await expect(afterDelete.nth(0)).toContainText('Bananas')
  await expect(afterDelete.filter({ hasText: 'Apples' })).toHaveCount(0)
})
