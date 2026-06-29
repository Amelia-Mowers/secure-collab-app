import { test, expect } from '@playwright/test'
import { homeserverUrl, registerDevice, signInDevice, captureMasterKey, uniqueUser } from './helpers'

// A second device of the same user restores access to encrypted history using
// the master/recovery key — the non-SAS path on the verify screen.
test('a second device restores access with the master key', async ({ browser }) => {
  const url = homeserverUrl()
  const user = uniqueUser('rec')

  // Device 1: register and save the generated master key.
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, user)
  const masterKey = await captureMasterKey(pageA)
  await expect(pageA).toHaveURL(/workspaces/, { timeout: 60_000 })

  // Device 2: a fresh device signs in and is gated on the verify screen.
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await signInDevice(pageB, url, user)
  const dialogB = pageB.getByRole('dialog')
  await expect(dialogB.getByRole('heading', { name: /verify this device/i })).toBeVisible({
    timeout: 90_000,
  })

  // Restore with the master key. With no passkey available the gate shows the
  // master-key field directly (no SAS / "verify with another device" step).
  await dialogB.locator('.verify__input').fill(masterKey)
  await dialogB.getByRole('button', { name: /^restore$/i }).click()

  // The gate clears once secrets are restored — the device now has access.
  await expect(dialogB).toBeHidden({ timeout: 90_000 })

  await ctxA.close()
  await ctxB.close()
})
