import { test, expect } from '@playwright/test'

/**
 * The no-account demo (ADR 0002's funnel).
 *
 * The assertion that matters is the first line of the test: it navigates
 * straight to /demo without registering, and the product appears. Everything
 * this route exists for — a stranger, a reviewer, a journalist seeing a real
 * workspace before being asked for an account, terms and a recovery key —
 * fails if that stops being true, and nothing else in the suite would notice.
 */
test('a stranger can use the product with no account', async ({ page }) => {
  test.setTimeout(180_000)

  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  await page.goto('/demo')

  // Mounted under /workspace/demo on purpose: every internal link in the views
  // builds `/workspace/${id}/...` by hand, so the demo reuses the real path
  // shape rather than teaching a dozen components about itself.
  await expect(page).toHaveURL(/\/workspace\/demo$/, { timeout: 60_000 })

  // Seeded from the shipped demo archive — the only template with row data.
  for (const label of ['Contacts', 'Projects', 'Board', 'My Board']) {
    await expect(page.locator('.sidebar__item-label', { hasText: new RegExp(`^${label}$`) })).toBeVisible({
      timeout: 60_000,
    })
  }

  // Never claim encryption here. There is no room and no server; the badge that
  // says "E2E Encrypted" in a real workspace would be this app's most
  // load-bearing promise, made falsely, on the screen shown to people deciding
  // whether to trust it.
  await expect(page.locator('.sidebar__workspace-badge')).toHaveText(/local only/i)
  await expect(page.getByText('E2E Encrypted')).toHaveCount(0)

  // And say plainly that nothing is kept.
  await expect(page.locator('.demo-banner__text')).toContainText(/nothing is saved/i)

  // The product actually works: open a table and see seeded rows, including a
  // resolved reference cell and the assignee substituted to the local identity.
  await page.locator('.sidebar__item-label', { hasText: /^Projects$/ }).click()
  await expect(page.getByText('Sketch landing page hero')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Dana Whitfield').first()).toBeVisible()

  // No sign-in gate anywhere in the journey.
  await expect(page).not.toHaveURL(/signin/)
  expect(pageErrors, `page errors in the demo:\n${pageErrors.join('\n')}`).toEqual([])
})

/**
 * Import and export, in the demo.
 *
 * These controls are feature-detected, not configured: the Sidebar renders each
 * one only when the workspace object has the matching method, so a local
 * workspace missing them produced no button at all — nothing disabled, nothing
 * explaining why, just a product that appeared not to have the feature. That is
 * the worst way to fail on the page shown to someone deciding whether to adopt
 * it, and it is invisible to every test that only checks the demo loads.
 *
 * So this asserts the controls exist AND that they do something: the export
 * really produces a CSV with the seeded data in it.
 */
test('the demo can import and export, like the real product', async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto('/demo')
  await expect(page).toHaveURL(/\/workspace\/demo$/, { timeout: 60_000 })
  await expect(page.locator('.sidebar__item-label', { hasText: /^Contacts$/ })).toBeVisible({
    timeout: 60_000,
  })

  // Workspace-level: both entry points a visitor would look for.
  await expect(page.getByRole('button', { name: 'Import CSV', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export workspace' })).toBeVisible()

  // Per-table: hover the row to reveal its actions.
  const contacts = page.locator('.sidebar__item', { hasText: /^Contacts/ }).first()
  await contacts.hover()
  await expect(contacts.getByRole('button', { name: 'Import CSV into table' })).toBeVisible()

  // Export for real and read the file back. Asserting the button exists would
  // pass against a binding that throws the moment it is called.
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await contacts.getByRole('button', { name: 'Export table as CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Contacts.csv')

  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const csv = Buffer.concat(chunks).toString('utf-8')

  // Column names as headers and seeded data in the body — the export is meant
  // to open as an ordinary spreadsheet, not a page of row ids.
  expect(csv.split('\n')[0]).toContain('First name')
  expect(csv).toContain('Whitfield')

  // And the import modal opens against a workspace with no session behind it.
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click()
  await expect(page.locator('.csvim')).toBeVisible({ timeout: 30_000 })
})
