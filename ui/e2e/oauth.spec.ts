import { test, expect } from '@playwright/test'
import { captureMasterKey } from './helpers'

/**
 * OAuth 2.0 (next-gen auth / MAS) sign-in through the real product UI
 * (ADR 0002 phase C): the sign-in page detects that the homeserver delegates
 * auth (MSC3861), swaps the password form for the secure sign-in flow, opens
 * the MAS hosted pages in a popup, completes the login in the app page (which
 * holds the WASM client + PKCE verifier), bootstraps recovery like any other
 * first device, and restores the session across a reload.
 *
 * Only runs when scripts/spike-synapse-mas.sh --e2e provides the stack via
 * E2E_SYNAPSE_URL (+ a pre-registered MAS user) — normal Conduit runs skip it.
 */

const SYNAPSE_URL = process.env.E2E_SYNAPSE_URL
const MAS_USER = process.env.E2E_MAS_USER ?? 'spikeuser'
const MAS_PASSWORD = process.env.E2E_MAS_PASSWORD ?? 'spike-password-123!'

test.skip(!SYNAPSE_URL, 'requires the Synapse+MAS spike stack (E2E_SYNAPSE_URL)')

test('SSO sign-in via MAS popup: detect, authorize, bootstrap recovery, restore', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const context = await browser.newContext()
  const page = await context.newPage()

  await test.step('the sign-in page detects next-gen auth and offers SSO', async () => {
    await page.goto('/signin')
    await page.locator('.signin__server-option', { hasText: 'Custom server' }).click()
    await page.locator('input.signin__server-input').fill(SYNAPSE_URL!)
    // The debounced probe flips the form to the SSO panel.
    await expect(page.getByTestId('oauth-signin')).toBeVisible({ timeout: 30_000 })
    // The password form is gone — there is nothing to type a password into.
    await expect(page.locator('#password')).toBeHidden()
  })

  await test.step('authorize on the MAS hosted pages in the popup', async () => {
    const popupPromise = context.waitForEvent('page')
    await page.getByRole('button', { name: /continue with secure sign-in/i }).click()
    const popup = await popupPromise

    await popup.getByLabel(/username/i).fill(MAS_USER)
    await popup.getByLabel(/password/i).fill(MAS_PASSWORD)
    await popup.getByRole('button', { name: /continue|sign in|log in/i }).click()

    // Consent screen for the dynamically-registered client, if MAS shows one.
    const consent = popup.getByRole('button', { name: /continue|allow|approve/i })
    try {
      await consent.click({ timeout: 15_000 })
    } catch {
      /* no consent step configured — fine */
    }
    // The callback page posts the redirect URL to the opener and closes the
    // popup; the app page finishes the login.
  })

  await test.step('first device bootstraps recovery and lands in workspaces', async () => {
    await captureMasterKey(page)
    await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
  })

  await test.step('the OAuth session restores across a reload', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible({
      timeout: 120_000,
    })
    // Same account, no sign-in page, no verify gate (same device identity).
    await expect(page).toHaveURL(/workspaces/)
  })

  await context.close()
})
