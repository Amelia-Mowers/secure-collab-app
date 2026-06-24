import { expect, type Page } from '@playwright/test'

/** The throwaway Synapse URL, published by global-setup via the environment. */
export function homeserverUrl(): string {
  const url = process.env.E2E_HOMESERVER
  if (!url) throw new Error('E2E_HOMESERVER not set — did global-setup run?')
  return url
}

/** A unique username per test run (avoids cross-test collisions on the server). */
export function uniqueUser(prefix = 'u'): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`
}

export const PASSWORD = 'e2e-test-password-123'

/** Point the sign-in form at our throwaway homeserver via "Custom server". */
async function selectCustomServer(page: Page, url: string) {
  await page.locator('.signin__server-option', { hasText: 'Custom server' }).click()
  await page.locator('input.signin__server-input').fill(url)
}

/** Register a brand-new account (a first device). */
export async function registerDevice(page: Page, url: string, username: string, password = PASSWORD) {
  await page.goto('/signin')
  await page.locator('.signin__tabs').getByRole('button', { name: 'Create account' }).click()
  await selectCustomServer(page, url)
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('#confirm-password').fill(password)
  await page.locator('button[type="submit"]').click()
}

/** Sign in to an existing account on a fresh device (new context). */
export async function signInDevice(page: Page, url: string, username: string, password = PASSWORD) {
  await page.goto('/signin')
  await selectCustomServer(page, url)
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('button[type="submit"]').click()
}

/**
 * Complete the first-device "Save your master key" step and return the key.
 * The first device auto-bootstraps recovery, so this screen appears after
 * registration.
 */
export async function captureMasterKey(page: Page): Promise<string> {
  const keyText = page.locator('.verify__key-text')
  await expect(keyText).toBeVisible({ timeout: 90_000 })
  const key = (await keyText.textContent())?.trim()
  if (!key) throw new Error('Master key was empty')
  await page.getByRole('button', { name: /saved it/i }).click()
  return key
}

/**
 * Attach a PRF-capable virtual platform authenticator to a page's context, so
 * `isUVPAA()` reports true and WebAuthn create/get return a PRF result without a
 * real biometric prompt. Returns the CDP session (e.g. for
 * `Storage.clearDataForOrigin` when simulating a re-provisioned device) and the
 * authenticator id. Add it only to contexts that should be passkey-capable —
 * omit it to exercise the legacy raw-recovery-key path.
 */
export async function addPrfAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal', // platform authenticator → isUVPAA() returns true
      hasResidentKey: true, // discoverable
      hasUserVerification: true,
      hasPrf: true, // the extension our key derivation needs
      automaticPresenceSimulation: true,
      isUserVerified: true, // auto-pass UV (no real biometric prompt)
    },
  })
  return { client, authenticatorId }
}
