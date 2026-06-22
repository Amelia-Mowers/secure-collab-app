import { test, expect } from '@playwright/test'
import {
  addPrfAuthenticator,
  captureMasterKey,
  homeserverUrl,
  registerDevice,
  signInDevice,
  uniqueUser,
} from './helpers'

/**
 * Legacy-account → passkey migration round-trip (passkey custody, phase 4).
 * Exercises the whole phase together against a real homeserver:
 *
 *   1. Device A (NO authenticator) registers and bootstraps the classic way —
 *      a raw recovery key, no passkey. This is a "legacy" account.
 *   2. Device B (a passkey-capable browser) signs in and hits the verify gate.
 *      Phase 4a: even though B has a platform authenticator, the gate offers NO
 *      "Unlock with passkey" button — the account isn't enrolled. B restores
 *      with the master key instead.
 *   3. Phase 4b: B is then offered to add a passkey; accepting re-keys secure
 *      backup to the passkey's PRF secret via the SDK `reset_key`. Phase 4c: the
 *      resulting screen leads with "Passkey ready" and keeps the new break-glass
 *      key collapsed.
 *   4. Proof the re-key actually took: re-provision B (wipe local store, keep the
 *      authenticator) and sign in again — the gate now DOES offer passkey unlock
 *      (the account is enrolled), and the passkey opens the re-keyed backup with
 *      no key typed. If `reset_key` hadn't re-keyed to the PRF secret, this last
 *      unlock would fail.
 */

test('passkey migration: legacy account adds a passkey, then unlocks with it', async ({
  browser,
}) => {
  const url = homeserverUrl()
  const user = uniqueUser('mig')

  // ── Device A: legacy account (no authenticator → raw recovery key) ──────────
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, user)
  const masterKey = await captureMasterKey(pageA)
  await expect(pageA).toHaveURL(/workspaces/, { timeout: 60_000 })

  // ── Device B: passkey-capable, signs in, restores with the master key ───────
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  const { client: clientB } = await addPrfAuthenticator(pageB)
  await signInDevice(pageB, url, user)

  const dialogB = pageB.getByRole('dialog')
  await expect(dialogB.getByRole('heading', { name: /verify this device/i })).toBeVisible({
    timeout: 90_000,
  })
  // Phase 4a: a legacy (not-enrolled) account is never offered passkey unlock,
  // even on a passkey-capable device — only the master-key / SAS paths.
  await expect(dialogB.getByRole('button', { name: /unlock with passkey/i })).toHaveCount(0)
  await dialogB.getByRole('button', { name: /use your master key/i }).click()
  await dialogB.locator('.verify__input').fill(masterKey)
  await dialogB.getByRole('button', { name: /^restore$/i }).click()

  // Phase 4b: after the master-key unlock, B is offered to add a passkey.
  await expect(dialogB.getByRole('heading', { name: /add a passkey/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialogB.getByRole('button', { name: /set up a passkey/i }).click()

  // Phase 4c: re-key done — "Passkey ready", break-glass key collapsed.
  await expect(dialogB.getByRole('heading', { name: /passkey ready/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialogB.getByRole('button', { name: /^done$/i }).click()
  await expect(pageB).toHaveURL(/workspaces/, { timeout: 60_000 })

  // ── Re-provision B and prove the passkey now opens the re-keyed backup ──────
  const origin = new URL(pageB.url()).origin
  await clientB.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  await signInDevice(pageB, url, user)

  await expect(dialogB.getByRole('heading', { name: /verify this device/i })).toBeVisible({
    timeout: 90_000,
  })
  // Now enrolled: the passkey-unlock button appears and opens the backup that
  // `reset_key` re-keyed to the PRF secret — no master key typed.
  await dialogB.getByRole('button', { name: /unlock with passkey/i }).click()
  await expect(dialogB).toBeHidden({ timeout: 90_000 })
  await expect(pageB).toHaveURL(/workspaces/, { timeout: 30_000 })

  await ctxA.close()
  await ctxB.close()
})
