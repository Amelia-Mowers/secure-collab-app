import { test, expect } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * The change history has to say WHAT changed and ON WHICH ROW.
 *
 * It did neither. Relation values printed as `row_1785…` (the same missing
 * cell-renderer as the kanban and card views), and an entry never named the
 * row at all — a status edit read "amelia changed status Todo → In Progress",
 * below fifty undifferentiated seeding events, with no way to tell which task.
 * So the feature that exists to demonstrate "no lost edits" could not answer
 * "what happened to this task", which is the only question anyone opens it to
 * ask.
 *
 * The demo template supplies both halves for free: seeding writes reference
 * cells (Client, Stakeholders), so the log is full of relation values before
 * the user does anything.
 */
test('history names the row and resolves relation values', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('hist'))
  await captureMasterKey(page)

  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Workspace name').fill('History Rendering')
  await expect
    .poll(async () => dialog.locator('.nwm__tile').count(), { timeout: 60_000 })
    .toBeGreaterThan(2)
  await dialog.locator('.nwm__tile', { hasText: /^Demo Workspace/ }).click()
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 120_000 })

  await page.locator('.sidebar__item-label', { hasText: /^Projects$/ }).click()
  await expect(page.getByText('Sketch landing page hero')).toBeVisible({ timeout: 120_000 })

  await page.getByRole('button', { name: /history/i }).click()
  const drawer = page.locator('.history-drawer')
  await expect(drawer).toBeVisible({ timeout: 60_000 })
  await expect(drawer.locator('.history-entry').first()).toBeVisible({ timeout: 60_000 })

  const log = await drawer.innerText()

  // The reported symptom.
  expect(log, `a raw row id is visible in history:\n${log.slice(0, 600)}`).not.toMatch(
    /row_\d{6,}/,
  )

  // Relations resolve to the referenced row's label…
  expect(log).toContain('Dana Whitfield')

  // …columns read as display names, not ids…
  expect(log).toContain('Due date')
  expect(log, 'the raw column id leaked').not.toContain('due_date')

  // …and an entry says which row it happened to, which is the whole point.
  expect(log, 'no entry names the row it changed').toContain('Sketch landing page hero')
})
