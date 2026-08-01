import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * Creating a workspace from a shipped template, through the real UI.
 *
 * This exists because the Rust tests could not have caught the bug it now
 * covers. `shipped_templates.rs` applies every template to a plain
 * `Workspace` and asserts the result — and passed — while the browser threw
 * "expected instance of T" on the same templates. The seam was one layer
 * above: `WorkspacesPage` handed a worker-backed session to
 * `ConnectedWorkspace.create`, which is a wasm class check, so template
 * seeding was broken for every user with the shared worker on (the default).
 *
 * So the assertion that matters here is not "the CSV parses" — that is
 * covered, cheaply, in Rust. It is that a template reaches a real encrypted
 * room through the real client, and that its rows and computed columns
 * survive a reload, i.e. they went to the timeline rather than only to local
 * state.
 */

/** Template names come from the page, so a future one containing `(` or `+`
 *  would otherwise be compiled as a pattern. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Create a workspace from a template tile in the New Workspace dialogue. */
async function createFromTemplate(page: Page, name: string, templateName: string) {
  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Workspace name').fill(name)
  // The tile is a <label> wrapping a radio; clicking the label selects it.
  await dialog.locator('.nwm__tile', { hasText: new RegExp(`^${escapeRe(templateName)}`) }).click()
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()

  // Report the in-app error rather than timing out on the URL. `handleCreate`
  // catches a failed seed and shows it in an alert, so without this the bug
  // presents as a bare 120s navigation timeout — when the page is sitting
  // there plainly saying "expected instance of MatrixSession".
  await expect
    .poll(
      async () => {
        if (/\/workspace\//.test(page.url())) return 'navigated'
        const alert = page.getByRole('alert')
        if (await alert.isVisible().catch(() => false)) {
          return (await alert.innerText()).trim().split('\n')[0]
        }
        return 'still creating'
      },
      { timeout: 120_000, message: `creating "${name}" from template "${templateName}"` },
    )
    .toBe('navigated')
}

test('the demo template seeds a real workspace, including its formula column', async ({ page }) => {
  test.setTimeout(420_000)

  // Any uncaught page error fails the test with its message rather than as a
  // mystery timeout. This is precisely how the reported bug presented — the
  // grid simply never appeared.
  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('tmpl'))
  await captureMasterKey(page)

  await createFromTemplate(page, 'Demo From Template', 'Demo Workspace')

  // A seeded workspace must not open on "Create a table from the sidebar to
  // get started". Someone who just chose a pre-filled template is being told
  // their workspace is empty on its very first frame — while the sidebar
  // beside it lists four tables. It opens the first table instead.
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/table\//, { timeout: 120_000 })
  await expect(page.getByText('Create a table from the sidebar to get started')).toHaveCount(0)

  // Tables from the template are present. The `tasks` table is LABELLED
  // "Projects" (tables.csv) — the display name, not the id, is what shows.
  await expect(page.locator('.sidebar__item-label', { hasText: /^Projects$/ })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page.locator('.sidebar__item-label', { hasText: /^Contacts$/ })).toBeVisible({
    timeout: 120_000,
  })
  expect(pageErrors, `page errors during template seeding:\n${pageErrors.join('\n')}`).toEqual([])

  // Rows actually landed, and the reference column resolved to a label rather
  // than a raw row id.
  await page.locator('.sidebar__item-label', { hasText: /^Projects$/ }).click()
  await expect(page.getByText('Sketch landing page hero')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Dana Whitfield').first()).toBeVisible({ timeout: 120_000 })

  // The formula column: Contacts carries first/last, and "Dana Whitfield"
  // exists only because it was computed at read time.
  await page.locator('.sidebar__item-label', { hasText: /^Contacts$/ }).click()
  await expect(page.locator('th', { hasText: 'First name' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('th', { hasText: 'Last name' })).toBeVisible()
  await expect(page.getByText('Dana Whitfield').first()).toBeVisible({ timeout: 60_000 })

  // Survives a reload — proving the seed reached the timeline, not just local
  // state, and that the formula recomputes on cold start.
  await page.reload()
  await expect(page.getByText('Dana Whitfield').first()).toBeVisible({ timeout: 120_000 })
  expect(pageErrors, `page errors after reload:\n${pageErrors.join('\n')}`).toEqual([])
})

test('every shipped template creates a workspace without error', async ({ page }) => {
  test.setTimeout(600_000)

  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('tmplall'))
  await captureMasterKey(page)

  // Read the tile names from the dialogue itself rather than hardcoding them,
  // so a newly added template is covered the day it ships instead of the day
  // someone remembers to update this list.
  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  // Templates load asynchronously, so the dialogue opens with only the two
  // built-in tiles ("Empty", "From an archive"). Reading straight away finds
  // no templates and passes an empty loop.
  await expect
    .poll(async () => dialog.locator('.nwm__tile').count(), { timeout: 60_000 })
    .toBeGreaterThan(2)

  const names = (await dialog.locator('.nwm__tile .nwm__name').allTextContents())
    .map(t => t.trim())
    .filter(n => n && n !== 'Empty' && n !== 'From an archive')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  expect(names.length, 'no templates offered in the New Workspace dialogue').toBeGreaterThan(0)

  for (const templateName of names) {
    await createFromTemplate(page, `WS ${templateName}`, templateName)
    // A seeded workspace has at least one table in the sidebar; an empty
    // sidebar means the archive did not apply. And it lands on that table
    // rather than on the "workspace is empty" home.
    await expect(page.locator('.sidebar__item-label').first()).toBeVisible({ timeout: 120_000 })
    await expect(page).toHaveURL(/\/workspace\/[^/]+\/table\//, { timeout: 120_000 })
    expect(
      pageErrors,
      `page errors seeding template ${templateName}:\n${pageErrors.join('\n')}`,
    ).toEqual([])
    // In-app navigation, not `page.goto('/')`: a full reload restarts session
    // restore, and the next iteration then races it and finds "Not signed in".
    await page.getByRole('button', { name: 'All workspaces' }).click()
    await expect(page.locator('.workspace-card--new')).toBeVisible({ timeout: 60_000 })
  }
})
