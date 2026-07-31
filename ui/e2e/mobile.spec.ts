import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * The app on a phone.
 *
 * Before this, two of twenty-one stylesheets had a media query and neither was
 * a core surface: a 220px sidebar sat permanently beside the grid, so a 390px
 * screen spent well over half its width on navigation. The marketing site was
 * responsive, which made it worse — the funnel read fine on a phone and then
 * handed over an app that did not fit one.
 *
 * What catches the ORIGINAL bug is the drawer assertion: reverting the mobile
 * CSS and re-running fails here on `sidebar` being visible when it should be
 * off-canvas. Verified, rather than assumed.
 *
 * The horizontal-overflow checks are a guard against the wider class of
 * problem rather than a reproduction of that one — a fixed-width child added
 * later, a padding that does not shrink, a min-width nobody noticed. They pass
 * on real template content at 390px, on every surface rather than once, because
 * each has its own padding and its own widest child. A layout can look fine in
 * a screenshot and still be 80px wider than the screen.
 */

// iPhone 12-ish. Narrow enough to be honest, not a pathological 320px.
test.use({ viewport: { width: 390, height: 844 } })

/** Nothing may be wider than the viewport. Returns the overflow in px. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement
    return Math.max(0, d.scrollWidth - d.clientWidth)
  })
}

async function expectNoOverflow(page: Page, where: string) {
  // Settle layout/fonts before measuring.
  await page.waitForTimeout(250)
  const overflow = await horizontalOverflow(page)
  expect(overflow, `${where} overflows the 390px viewport by ${overflow}px`).toBe(0)
}

const menuButton = (page: Page) => page.getByRole('button', { name: /open navigation/i })
const sidebar = (page: Page) => page.locator('.sidebar')

test('the app fits, and navigates, on a phone-sized screen', async ({ page }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('mob'))
  await captureMasterKey(page)

  await expectNoOverflow(page, 'the workspaces page')

  // Seed from the demo template so there is real content to overflow with —
  // long text, reference pills, several columns.
  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Workspace name').fill('Phone WS')
  await expect
    .poll(async () => dialog.locator('.nwm__tile').count(), { timeout: 60_000 })
    .toBeGreaterThan(2)
  await dialog.locator('.nwm__tile', { hasText: /^Demo Workspace/ }).click()
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 120_000 })

  // ── The drawer ──────────────────────────────────────────────
  // Off-canvas by default: the grid gets the whole width.
  await expect(menuButton(page)).toBeVisible({ timeout: 60_000 })
  await expect(sidebar(page)).toBeHidden()

  await menuButton(page).click()
  await expect(sidebar(page)).toBeVisible()
  await expectNoOverflow(page, 'the workspace with the drawer open')

  // Navigating closes it, rather than leaving it over the content just asked for.
  await page.locator('.sidebar__item-label', { hasText: /^Projects$/ }).click()
  await expect(sidebar(page)).toBeHidden({ timeout: 30_000 })

  // ── The surfaces ────────────────────────────────────────────
  await expect(page.getByText('Sketch landing page hero')).toBeVisible({ timeout: 120_000 })
  await expectNoOverflow(page, 'the table grid')

  // The grid scrolls horizontally INSIDE its own container — that is the
  // intended behaviour for a wide table, and is why the page itself must not.
  const scrollable = await page
    .locator('.table-scroll')
    .evaluate(el => el.scrollWidth > el.clientWidth)
  expect(scrollable, 'a multi-column grid should scroll within .table-scroll').toBe(true)

  // Entry view: the field labels stack above their values below the breakpoint.
  // Clicking the cell itself edits it — the row's own control opens the entry.
  await page
    .locator('tbody tr', { hasText: 'Sketch landing page hero' })
    .getByRole('button', { name: /open full entry/i })
    .click()
  await expect(page).toHaveURL(/\/entry\//, { timeout: 60_000 })
  await expectNoOverflow(page, 'the entry view')

  const stacked = await page
    .locator('.field-renderer')
    .first()
    .evaluate(el => getComputedStyle(el).flexDirection)
  expect(stacked, 'field rows should stack on a narrow screen').toBe('column')
})

test('the sidebar is a column again on a desktop viewport', async ({ page }) => {
  test.setTimeout(300_000)
  // Same build, wide viewport: proves the drawer is scoped to the breakpoint
  // and has not replaced the desktop layout.
  await page.setViewportSize({ width: 1280, height: 800 })

  const url = homeserverUrl()
  await registerDevice(page, url, uniqueUser('desk'))
  await captureMasterKey(page)

  await page.locator('.workspace-card--new').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Workspace name').fill('Desktop WS')
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 120_000 })

  // Visible without opening anything, and the hamburger is gone.
  await expect(sidebar(page)).toBeVisible({ timeout: 60_000 })
  await expect(menuButton(page)).toBeHidden()
})
