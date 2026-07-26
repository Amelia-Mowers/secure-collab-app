import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * Every app resource can be updated in place and removed (issue
 * row_1785004488887). The unit tests cover each operation against a mock; this
 * proves it against a real encrypted room — that a rename is one LWW write
 * rather than a re-create, that a deleted view's tombstone really hides it,
 * and — the part a mock genuinely cannot show — that all of it **survives a
 * reload**, i.e. the mutations reached the timeline and replay on cold start.
 *
 * A rename that only edits local state looks identical to a correct one until
 * you reload. That is the assertion this file exists for.
 */

async function createWorkspace(page: Page, name: string) {
  await page.locator('.workspace-card--new').click()
  await page.getByPlaceholder('Workspace name').fill(name)
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'New table' })).toBeVisible({ timeout: 90_000 })
}

async function createTable(page: Page, name: string) {
  await page.getByRole('button', { name: 'New table' }).click()
  const input = page.getByPlaceholder('Table name...')
  await input.fill(name)
  await input.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/table/${name.toLowerCase()}`), { timeout: 90_000 })
}

/** The sidebar entry for a table or view — scoped, because the table name also
 *  appears in the grid toolbar and a bare text match would be ambiguous. */
function sidebarItem(page: Page, label: string) {
  return page.locator('.sidebar__item-label', { hasText: new RegExp(`^${label}$`) })
}

test('resource CRUD: rename a table, rename and delete a view, all surviving reload', async ({
  page,
}) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('crud'))
  await captureMasterKey(page)

  await createWorkspace(page, 'CRUD Workspace')
  await createTable(page, 'Widgets')

  // ── A saved view to rename and then delete ────────────────────────────────
  // A plain Table view: the default type is Kanban, which needs group-by and
  // title columns that a freshly created table doesn't have yet.
  await page.getByRole('button', { name: 'New view' }).click()
  const viewDialog = page.getByRole('dialog')
  // Pick the type FIRST. The modal opens on Kanban with the sole table already
  // selected, so its group-by/title config is mounted — and those carry the
  // same `.nvm__select` class as the table picker. Choosing Table unmounts
  // them, leaving exactly one select to address.
  await viewDialog.locator('.nvm__type-tile', { hasText: 'Table' }).first().click()
  await viewDialog.locator('.nvm__select').selectOption({ label: 'Widgets' })
  await viewDialog.getByPlaceholder('My View').fill('First Board')
  await viewDialog.getByRole('button', { name: 'Create view' }).click()
  await expect(viewDialog).toBeHidden({ timeout: 60_000 })
  await expect(sidebarItem(page, 'First Board')).toBeVisible({ timeout: 60_000 })

  // ── Rename the table in place ─────────────────────────────────────────────
  // The rename is not optimistic: the new name appears only once the write has
  // landed, so these assertions are themselves proof of persistence — and the
  // reload below can't race an in-flight send.
  page.once('dialog', d => void d.accept('Gadgets'))
  await page.getByLabel('Rename table').click()
  await expect(sidebarItem(page, 'Gadgets')).toBeVisible({ timeout: 60_000 })

  // ── Rename the view ───────────────────────────────────────────────────────
  page.once('dialog', d => void d.accept('Sprint Board'))
  await page.getByLabel('Rename view').click()
  await expect(sidebarItem(page, 'Sprint Board')).toBeVisible({ timeout: 60_000 })

  // ── The table rename must survive a cold start ────────────────────────────
  // This is what separates a real LWW write to the timeline from a local-only
  // state update; they are indistinguishable before the reload.
  await page.reload()
  await expect(sidebarItem(page, 'Gadgets')).toBeVisible({ timeout: 120_000 })
  // The rename kept the table's identity: same id, so the same URL.
  await sidebarItem(page, 'Gadgets').click()
  await expect(page).toHaveURL(/\/table\/widgets/, { timeout: 60_000 })

  // ── Delete the view; the table it projected must remain ───────────────────
  page.once('dialog', d => void d.accept())
  await page.getByLabel('Delete view').click()
  await expect(sidebarItem(page, 'Sprint Board')).toBeHidden({ timeout: 60_000 })
  await expect(sidebarItem(page, 'Gadgets')).toBeVisible()

  // The tombstone is a real event, so the view stays gone after a reload
  // instead of reappearing out of the replayed timeline.
  await page.reload()
  await expect(sidebarItem(page, 'Gadgets')).toBeVisible({ timeout: 120_000 })
  await expect(sidebarItem(page, 'Sprint Board')).toBeHidden({ timeout: 30_000 })
})

/**
 * Regression test for issue 980ac596: discrete operations (view/table/schema
 * writes) used to have NO durability between local apply and server ack — a
 * reload in that window silently discarded the operation, even though the UI
 * had already shown it (any sync-triggered refresh re-reads local state). They
 * now ride the same durable queue + encrypted outbox as cell edits.
 */
test('a view rename survives a reload', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('vrename'))
  await captureMasterKey(page)
  await createWorkspace(page, 'View Rename')
  await createTable(page, 'Widgets')

  await page.getByRole('button', { name: 'New view' }).click()
  const viewDialog = page.getByRole('dialog')
  await viewDialog.locator('.nvm__type-tile', { hasText: 'Table' }).first().click()
  await viewDialog.locator('.nvm__select').selectOption({ label: 'Widgets' })
  await viewDialog.getByPlaceholder('My View').fill('First Board')
  await viewDialog.getByRole('button', { name: 'Create view' }).click()
  await expect(viewDialog).toBeHidden({ timeout: 60_000 })

  page.once('dialog', d => void d.accept('Sprint Board'))
  await page.getByLabel('Rename view').click()
  await expect(sidebarItem(page, 'Sprint Board')).toBeVisible({ timeout: 60_000 })

  await page.reload()
  await expect(sidebarItem(page, 'Sprint Board')).toBeVisible({ timeout: 120_000 })
})

test('a sole member can leave a workspace, and it stays gone', async ({ page }) => {
  test.setTimeout(300_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('leave'))
  await captureMasterKey(page)

  await createWorkspace(page, 'Disposable')

  await page.getByRole('button', { name: 'Leave workspace…' }).click()
  const dialog = page.getByRole('dialog')
  // Sole member: no successor required, and the copy says why.
  await expect(dialog.getByText(/last member/i)).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Leave workspace' }).click()

  await expect(page).toHaveURL(/\/workspaces/, { timeout: 90_000 })
  await expect(page.getByText('Disposable')).toBeHidden({ timeout: 60_000 })

  // leave + forget is server-side state, not a local list filter.
  await page.reload()
  await expect(page.getByText('Disposable')).toBeHidden({ timeout: 120_000 })
})
