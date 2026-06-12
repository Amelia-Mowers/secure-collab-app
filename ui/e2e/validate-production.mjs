/**
 * Production validation: drive the DEPLOYED app (GitHub Pages, https origin)
 * through the full SSO sign-in against the LIVE TideWork homeserver.
 *
 * This is the path local e2e cannot cover by design — production MAS rejects
 * http://localhost client registrations, so only an https-origin app can
 * complete dynamic registration there.
 *
 * Run inside the Nix dev shell (Playwright browsers provided), from ui/:
 *   PROD_USER=... PROD_PASSWORD=... node e2e/validate-production.mjs
 */
import { chromium } from '@playwright/test'

const APP_URL = process.env.PROD_APP_URL ?? 'https://amelia-mowers.github.io/secure-collab-app/'
const USER = process.env.PROD_USER
const PASSWORD = process.env.PROD_PASSWORD
if (!USER || !PASSWORD) {
  console.error('PROD_USER / PROD_PASSWORD required')
  process.exit(2)
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const context = await browser.newContext()
const page = await context.newPage()
const step = (m) => console.log(`==> ${m}`)

try {
  step(`loading deployed app: ${APP_URL}`)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })

  step('expecting SSO panel (default homeserver = production, probe detects MAS)')
  await page.getByTestId('oauth-signin').waitFor({ state: 'visible', timeout: 60_000 })

  step('starting SSO; authorizing on MAS hosted pages in the popup')
  const popupPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: /continue with secure sign-in/i }).click()
  const popup = await popupPromise
  await popup.getByLabel(/username/i).fill(USER)
  await popup.getByLabel(/password/i).fill(PASSWORD)
  await popup.getByRole('button', { name: /continue|sign in|log in/i }).click()
  try {
    await popup
      .getByRole('button', { name: /continue|allow|approve/i })
      .click({ timeout: 15_000 })
  } catch {
    /* no consent step */
  }

  step('first device: recovery bootstrap (master key screen)')
  const key = page.locator('.verify__key-text')
  await key.waitFor({ state: 'visible', timeout: 90_000 })
  console.log('    recovery key issued (not logged)')
  await page.getByRole('button', { name: /saved it/i }).click()

  step('workspaces page')
  await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ timeout: 60_000 })

  step('reload → session restores from the persisted OAuth blob')
  await page.reload()
  await page.getByRole('heading', { name: 'Workspaces' }).waitFor({ timeout: 120_000 })

  console.log('\nPRODUCTION VALIDATION: PASS')
} catch (err) {
  console.error('\nPRODUCTION VALIDATION: FAIL —', err.message)
  await page.screenshot({ path: 'prod-validation-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
