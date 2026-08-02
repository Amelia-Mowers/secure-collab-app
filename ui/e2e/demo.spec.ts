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
