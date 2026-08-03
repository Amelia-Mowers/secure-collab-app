// Screenshot the no-account demo in both themes, so a design change can be
// LOOKED AT rather than reasoned about.
//
//   cd ui && npx vite preview --port 4173 &
//   BASE=http://localhost:4173 OUT=/tmp/shots node e2e/design-shots.mjs
//
// The demo route needs no homeserver, no account and no key, so this is the
// cheapest honest check available: /demo builds a local workspace in the tab.
// Kept out of the Playwright suite deliberately — it asserts nothing. It is an
// instrument for looking, and a design change that nobody looked at is a guess.
import { chromium } from '@playwright/test'

const base = process.env.BASE || 'http://localhost:4173'
const out = process.env.OUT || '/tmp/shots'

const browser = await chromium.launch()
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(base + '/demo', { waitUntil: 'networkidle' })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await page.getByText('Projects', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/table-${theme}.png` })

  await page.getByText('Board', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/board-${theme}.png` })
  await ctx.close()
}
await browser.close()
console.log('shots written to', out)
