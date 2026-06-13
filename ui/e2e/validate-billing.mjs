/**
 * Trial-first flow validation (ADR 0002 phase D, amended):
 *  1. open registration on MAS (no token) — form → email code → display name
 *  2. billing /status reports the fresh account as trial with TRIAL_DAYS left
 *
 * The lock/unlock halves are exercised separately: the guarded /__sweep
 * endpoint (?trial_days=0) locks unpaid accounts, the Stripe webhook + the
 * /success unlock path restore them.
 *
 * Email codes: the dev stack has no email backend; the orchestrator reads the
 * code from the MAS database after this script writes /tmp/mas-ready, and
 * delivers it at /tmp/mas-code.
 *
 * Run inside the Nix dev shell, from ui/:
 *   TRIAL_USERNAME=lifecycle7 node e2e/validate-billing.mjs
 */
import { chromium } from '@playwright/test'

const USERNAME = process.env.TRIAL_USERNAME ?? `trial${Date.now() % 100000}`
const PASSWORD = process.env.TRIAL_PASSWORD ?? 'trial-pass-2026!x'
const EMAIL = process.env.TRIAL_EMAIL ?? `${USERNAME}@example.com`

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage()
const step = (m) => console.log(`==> ${m}`)

try {
  step('open registration on MAS (no token — trial-first)')
  await page.goto('https://auth.tidework.io/register', { waitUntil: 'domcontentloaded' })
  await page.getByLabel(/username/i).first().fill(USERNAME)
  const emailField = page.getByLabel(/email/i).first()
  if (await emailField.isVisible().catch(() => false)) await emailField.fill(EMAIL)
  await page.getByLabel(/^password$/i).first().fill(PASSWORD)
  const confirm = page.getByLabel(/confirm/i).first()
  if (await confirm.isVisible().catch(() => false)) await confirm.fill(PASSWORD)
  await page.getByRole('button', { name: /continue|register|create|sign up/i }).first().click()

  step('verify-email step — waiting for code from the database (/tmp/mas-code)')
  await page.waitForURL(/verify-email/, { timeout: 20_000 })
  const { readFileSync, existsSync, writeFileSync } = await import('node:fs')
  writeFileSync('/tmp/mas-ready', String(Date.now()))
  let code = ''
  for (let i = 0; i < 60; i++) {
    if (existsSync('/tmp/mas-code')) {
      code = readFileSync('/tmp/mas-code', 'utf8').trim()
      if (code) break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!code) throw new Error('no verification code arrived at /tmp/mas-code')
  await page.getByLabel(/code/i).first().fill(code)
  await page.getByRole('button', { name: /continue|verify/i }).first().click()

  step('display-name step — finishing registration')
  await page.waitForURL(/display-name/, { timeout: 20_000 })
  const dn = page.getByLabel(/display name/i).first()
  if (await dn.isVisible().catch(() => false)) await dn.fill(USERNAME)
  await page.getByRole('button', { name: /continue|finish|skip|save/i }).first().click()
  await page.waitForTimeout(5000)
  console.log(`    post-registration URL: ${page.url()}`)

  step('billing /status reports a fresh trial')
  const res = await fetch(
    `https://billing.tidework.io/status?username=${encodeURIComponent(USERNAME)}`,
  )
  const billing = await res.json()
  console.log(`    status: ${JSON.stringify(billing)}`)
  if (billing.status !== 'trial' || billing.days_left < 13) {
    throw new Error(`expected fresh trial, got ${JSON.stringify(billing)}`)
  }

  console.log(`\nTRIAL VALIDATION: PASS (user: ${USERNAME}, ${billing.days_left} days left)`)
} catch (err) {
  console.error('\nTRIAL VALIDATION: FAIL —', err.message)
  await page.screenshot({ path: '/tmp/billing-failure.png', fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
