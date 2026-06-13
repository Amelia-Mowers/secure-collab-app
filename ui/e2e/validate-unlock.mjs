/**
 * Trial-flow stage 3: a LOCKED account subscribes → the /success path (and
 * the webhook behind it) unlocks immediately → /status reports active.
 *
 *   UNLOCK_USERNAME=lifecycle7 node e2e/validate-unlock.mjs
 */
import { chromium } from '@playwright/test'

const USERNAME = process.env.UNLOCK_USERNAME ?? 'lifecycle7'
const EMAIL = `${USERNAME}@example.com`

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage()
const step = (m) => console.log(`==> ${m}`)

try {
  step(`subscribe for locked account ${USERNAME}`)
  await page.goto(`https://billing.tidework.io/subscribe?username=${USERNAME}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })

  step('test checkout (4242…)')
  await page.getByLabel(/email/i).first().fill(EMAIL)
  const cardField = page.locator('#cardNumber, input[name="cardNumber"]').first()
  if (!(await cardField.isVisible().catch(() => false))) {
    await page
      .locator('[data-testid="card-accordion-item-button"], [data-testid="card-accordion-item"]')
      .first()
      .click({ force: true, timeout: 10_000 })
      .catch(() => {})
  }
  await cardField.waitFor({ state: 'visible', timeout: 20_000 })
  await cardField.fill('4242 4242 4242 4242')
  await page.locator('#cardExpiry, input[name="cardExpiry"]').first().fill('12 / 30')
  await page.locator('#cardCvc, input[name="cardCvc"]').first().fill('123')
  await page.locator('#billingName, input[name="billingName"]').first().fill('Lifecycle Seven')
  const postal = page.locator('#billingPostalCode, input[name="billingPostalCode"]').first()
  if (await postal.isVisible().catch(() => false)) await postal.fill('90210')
  const saveInfo = page.getByLabel(/save my information/i).first()
  if (await saveInfo.isChecked().catch(() => false)) await saveInfo.uncheck().catch(() => {})
  await page.locator('button[type="submit"], .SubmitButton').first().click()

  step('success page (unlocks on render)')
  await page.waitForURL(/billing\.tidework\.io\/success/, { timeout: 60_000 })
  const heading = await page.locator('h1').first().textContent()
  console.log(`    success page: "${heading?.trim()}"`)

  step('status after subscribe')
  // tiny settle window for Stripe search indexing
  await new Promise((r) => setTimeout(r, 5000))
  const res = await fetch(`https://billing.tidework.io/status?username=${USERNAME}`)
  const billing = await res.json()
  console.log(`    status: ${JSON.stringify(billing)}`)
  if (billing.status === 'locked') throw new Error('still locked after payment')

  console.log(`\nUNLOCK VALIDATION: PASS (${USERNAME} → ${billing.status})`)
} catch (err) {
  console.error('\nUNLOCK VALIDATION: FAIL —', err.message)
  await page.screenshot({ path: '/tmp/billing-failure.png', fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
