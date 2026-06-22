import { test, expect } from '@playwright/test'
import { addPrfAuthenticator, homeserverUrl, registerDevice, signInDevice, uniqueUser } from './helpers'

/**
 * Passkey / WebAuthn-PRF round-trip (passkey custody, phase 3b). Drives the real
 * app against a CDP **virtual authenticator** with PRF (hmac-secret) support:
 *   1. A first device registers, chooses "Set up a passkey" (the choice screen
 *      appears because a platform authenticator is now available), keys secure
 *      backup with the passkey's PRF secret, and saves the break-glass key.
 *   2. We re-provision the same browser as a NEW device — wiping the local
 *      crypto store + session so the next sign-in is a fresh Matrix device with
 *      no history keys — then unlock with the passkey alone, no key typed.
 *
 * Step 2 keeps the **same** authenticator (it lives in the browser, not page
 * storage, so it survives the wipe). That is the realistic model: a passkey's
 * PRF is stable, so the same passkey on a new device derives the same secret and
 * opens secure backup. We deliberately do NOT copy the credential into a second
 * authenticator — Chrome's CDP getCredentials/addCredential does not carry the
 * hmac-secret, so an imported copy returns no PRF at get() time; and cross-device
 * passkey *syncing* is a platform feature (iCloud Keychain / Google Password
 * Manager), not our code, so there is nothing of ours to exercise that way.
 */

test('passkey: protect history on setup, then unlock a re-provisioned device', async ({ browser }) => {
  const url = homeserverUrl()
  const user = uniqueUser('pk')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const { client } = await addPrfAuthenticator(page)

  // ── Provision: register → choose passkey → save the break-glass key ─────────
  await registerDevice(page, url, user)
  const dialog = page.getByRole('dialog')

  // The platform authenticator is present, so we get the passkey-vs-key choice.
  await expect(dialog.getByRole('button', { name: /set up a passkey/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialog.getByRole('button', { name: /set up a passkey/i }).click()

  // Passkey-ready screen (secure backup is now keyed by the passkey's PRF
  // secret; the break-glass key is collapsed by default — phase 4c).
  await expect(dialog.getByRole('heading', { name: /passkey ready/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialog.getByRole('button', { name: /^done$/i }).click()
  await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })

  // ── Re-provision as a NEW device: wipe local crypto store + session ─────────
  // The authenticator (and its passkey) survive — only the app's local data is
  // cleared — so the next sign-in is a fresh device that must restore history.
  const origin = new URL(page.url()).origin
  await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })

  await signInDevice(page, url, user)
  await expect(dialog.getByRole('heading', { name: /verify this device/i })).toBeVisible({
    timeout: 90_000,
  })

  // Unlock with the passkey — the virtual authenticator auto-approves and the
  // same PRF secret opens secure backup, so the gate clears with no key typed.
  await dialog.getByRole('button', { name: /unlock with passkey/i }).click()
  await expect(dialog).toBeHidden({ timeout: 90_000 })
  await expect(page).toHaveURL(/workspaces/, { timeout: 30_000 })

  await ctx.close()
})
