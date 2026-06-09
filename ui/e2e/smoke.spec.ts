import { test, expect } from '@playwright/test'
import { homeserverUrl, registerDevice, uniqueUser } from './helpers'

// Validates the whole harness end to end: the browser launches, Vite serves the
// app + WASM, a Matrix account registers against the throwaway Conduit, and the
// first device auto-bootstraps recovery (the "save your master key" screen).
test('a new account boots, registers, and is shown its master key', async ({ page }) => {
  await registerDevice(page, homeserverUrl(), uniqueUser('smoke'))

  await expect(page.getByRole('heading', { name: /save your master key/i })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.verify__key-text')).not.toBeEmpty()
})
