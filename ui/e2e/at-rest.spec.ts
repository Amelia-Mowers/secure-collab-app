import { test, expect } from '@playwright/test'
import { addPrfAuthenticator, homeserverUrl, registerDevice, uniqueUser } from './helpers'

/**
 * At-rest encryption end to end (issue c72ec5df). The whole point: after a
 * RELOAD, the app must NOT silently restore — it must require the passkey (or
 * recovery key) to derive the store passphrase and open the now-ENCRYPTED SDK
 * store, and there must be NO plaintext secrets on disk.
 *
 * test.fixme until Stages 3–5 land (the unlock-first cold-start + session-blob
 * split + register re-key). Today a verified device restores silently on reload
 * (store + token are plaintext), so this would fail; it's the validation target
 * for the driven implementation loop. Mirrors passkey.spec.ts for the passkey
 * enroll/unlock steps.
 */
test(
  'at-rest: encrypted store requires passkey unlock on reload; no plaintext secrets',
  async ({ browser }) => {
    const url = homeserverUrl()
    const user = uniqueUser('atrest')

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await addPrfAuthenticator(page)

    // ── Provision: register → enroll passkey → save break-glass key ─────────────
    await registerDevice(page, url, user)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: /set up a passkey/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.getByRole('button', { name: /set up a passkey/i }).click()
    await expect(dialog.getByRole('heading', { name: /passkey ready/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.getByRole('button', { name: /^done$/i }).click()
    await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })

    // ── RELOAD (not a storage wipe): the encrypted store + session persist on
    //    disk, but the master secret does not — so cold start must prompt. ───────
    await page.reload()

    // NEW behavior (Stages 3–5): a locked gate appears instead of a silent
    // restore, because the encrypted store can't be opened without the passkey.
    await expect(dialog.getByRole('button', { name: /unlock with passkey/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.getByRole('button', { name: /unlock with passkey/i }).click()
    await expect(dialog).toBeHidden({ timeout: 90_000 })
    await expect(page).toHaveURL(/workspaces/, { timeout: 30_000 })

    // ── No plaintext secrets at rest ────────────────────────────────────────────
    // The persisted account entry must carry NO raw access token — the secrets
    // (accessToken/refreshToken/clientId) live in an AES-GCM ciphertext blob.
    const accountsRaw = await page.evaluate(() => localStorage.getItem('collab:accounts'))
    expect(accountsRaw, 'collab:accounts present').toBeTruthy()
    expect(accountsRaw!, 'no raw access token in localStorage').not.toMatch(/syt_|mat_|access[_-]?token/i)
    const parsed = JSON.parse(accountsRaw!)
    // Plaintext metadata only; secrets are a separate ciphertext field.
    expect(JSON.stringify(parsed)).not.toMatch(/"accessToken"\s*:\s*"[^"]+"/)

    await ctx.close()
  },
)
