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

/** Answer the "enter these groups of your recovery key" step. Reads the
 *  requested group numbers off the labels, because they are random. */
export async function completeKeyChallenge(page: Page, key: string) {
  const groups = key.trim().split(/\s+/).filter(Boolean)
  const fields = page.locator('.verify__challenge-field')
  await expect(fields.first()).toBeVisible({ timeout: 30_000 })
  const count = await fields.count()
  for (let i = 0; i < count; i++) {
    const label = (await fields.nth(i).locator('.verify__challenge-label').textContent()) ?? ''
    const n = Number(label.replace(/\D/g, ''))
    if (!n || !groups[n - 1]) throw new Error(`Could not read challenge label: "${label}"`)
    await fields.nth(i).locator('input').fill(groups[n - 1])
  }
  await page.getByRole('button', { name: 'Confirm' }).click()
}

/**
 * Complete the first-device "Save your recovery key" step and return the key.
 *
 * EVERY first device sees this now (issue 63dc1339) — there is no passkey-first
 * path that skips it — and it requires an explicit acknowledgement before it
 * will continue, which is the point of the screen.
 *
 * On a passkey-capable context the optional "unlock faster with a passkey" step
 * follows; it is skipped here so key-only tests aren't forced through it. Tests
 * that want the passkey enrolled drive that screen themselves.
 */
export async function captureMasterKey(page: Page): Promise<string> {
  const keyText = page.locator('.verify__key-text')
  await expect(keyText).toBeVisible({ timeout: 90_000 })
  const key = (await keyText.textContent())?.trim()
  if (!key) throw new Error('Master key was empty')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /continue/i }).click()

  // Continue no longer finishes the step: the key is hidden and two of its
  // groups are asked for back, so the acknowledgement is proof rather than a
  // promise. Read which groups are wanted rather than assuming — they are
  // chosen at random each time.
  await completeKeyChallenge(page, key)

  // The speed-up offer only appears where a platform authenticator exists.
  const notNow = page.getByRole('button', { name: /not now/i })
  if (await notNow.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await notNow.click()
  }
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

// ── Flow helpers ────────────────────────────────────────────────────────────
//
// Shared because they were duplicated across core / collaboration /
// resource-crud, and a UI rename then had to be applied in three places (the
// "Create" → "Create workspace" button, when the picker moved into a dialogue).
// One copy means one edit.

/** Create a workspace through the New Workspace dialogue and wait for the room
 *  to exist (creation + encryption enablement + initial sync). */
export async function createWorkspace(page: Page, name: string) {
  await page.locator('.workspace-card--new').click()
  await page.getByPlaceholder('Workspace name').fill(name)
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'New table' })).toBeVisible({ timeout: 90_000 })
}

/** Create a table; resolves once the grid for it is routed to. */
export async function createTable(page: Page, name: string) {
  await page.getByRole('button', { name: 'New table' }).click()
  const input = page.getByPlaceholder('Table name...')
  await input.fill(name)
  await input.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/table/${name.toLowerCase()}`), { timeout: 90_000 })
}

/** Add a column via the toolbar "Add column" button + modal. */
export async function addColumn(page: Page, name: string, typeLabel: string, options?: string) {
  await page.getByRole('button', { name: 'Add column' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('e.g. Priority').fill(name)
  // Anchored: a plain "Select" substring would also match the "Multi-select" row.
  await dialog.locator('.acm__type-row', { hasText: new RegExp(`^${typeLabel}`) }).click()
  if (options !== undefined) {
    await dialog.getByPlaceholder('Todo, In Progress, Done').fill(options)
  }
  await dialog.getByRole('button', { name: 'Add column' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 30_000 })
}
