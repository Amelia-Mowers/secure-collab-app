import { test, expect } from '@playwright/test'
import { homeserverUrl, registerDevice, signInDevice, captureMasterKey, uniqueUser } from './helpers'

// The headline two-browser flow: two devices of the same user complete an SAS
// (emoji) verification end to end, and the new device's gate clears once it is
// trusted. This exercises the full stack — WASM crypto, Matrix to-device
// messaging, the bridge DeviceVerification surface, and the React verify screen
// — across two isolated browser contexts (two real devices).
test('two devices verify each other with SAS emoji', async ({ browser }) => {
  const url = homeserverUrl()
  const user = uniqueUser('sas')

  // Device 1: register, save its key, land on /workspaces where the session
  // sync runs (so it can receive the incoming verification request).
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, user)
  await captureMasterKey(pageA)
  await expect(pageA).toHaveURL(/workspaces/, { timeout: 60_000 })

  // Device 2: a fresh device signs in and is gated; start "verify with another".
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await signInDevice(pageB, url, user)
  const dialogB = pageB.getByRole('dialog')
  await expect(dialogB.getByRole('heading', { name: /verify this device/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialogB.getByRole('button', { name: /verify with another device/i }).click()

  // Device 1 surfaces the incoming request and accepts it.
  const dialogA = pageA.getByRole('dialog')
  await expect(dialogA.getByRole('heading', { name: /verify a new device/i })).toBeVisible({
    timeout: 90_000,
  })
  await dialogA.getByRole('button', { name: /^verify$/i }).click()

  // Both sides reach the emoji comparison.
  await expect(dialogA.getByRole('heading', { name: /do these match/i })).toBeVisible({
    timeout: 90_000,
  })
  await expect(dialogB.getByRole('heading', { name: /do these match/i })).toBeVisible({
    timeout: 90_000,
  })

  // The seven emoji are identical on both devices.
  const emojiA = await dialogA.locator('.verify__emoji-symbol').allTextContents()
  const emojiB = await dialogB.locator('.verify__emoji-symbol').allTextContents()
  expect(emojiA).toHaveLength(7)
  expect(emojiA).toEqual(emojiB)

  // Confirm on both → the new device becomes trusted: it reaches "verified"
  // and the gate then closes.
  await dialogA.getByRole('button', { name: /they match/i }).click()
  await dialogB.getByRole('button', { name: /they match/i }).click()
  await expect(pageB.getByRole('heading', { name: /device verified/i })).toBeVisible({
    timeout: 90_000,
  })
  await expect(dialogB).toBeHidden({ timeout: 30_000 })

  await ctxA.close()
  await ctxB.close()
})
