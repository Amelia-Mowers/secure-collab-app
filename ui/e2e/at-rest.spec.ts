import { test, expect } from '@playwright/test'
import {
  addPrfAuthenticator,
  homeserverUrl,
  registerDevice,
  signInDevice,
  uniqueUser,
} from './helpers'

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
  'at-rest: a reload does NOT prompt, but a new device unlocks with its passkey',
  async ({ browser }) => {
    const url = homeserverUrl()
    const user = uniqueUser('atrest')

    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const { client } = await addPrfAuthenticator(page)

    // ── Provision: register → SAVE the recovery key (this is what re-keys the
    //    device to an encrypted store) → skip the optional passkey ─────────────
    await registerDevice(page, url, user)
    const dialog = page.getByRole('dialog')
    const keyText = page.locator('.verify__key-text')
    await expect(keyText).toBeVisible({ timeout: 90_000 })
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: /continue/i }).click()
    // Enrol the passkey: that is what re-keys this device to an ENCRYPTED
    // store, so it is a precondition of everything this spec asserts.
    await dialog.getByRole('button', { name: /set up a passkey/i }).click()
    await expect(dialog.getByRole('heading', { name: /passkey ready/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.getByRole('button', { name: /^done$/i }).click()
    await expect(page).toHaveURL(/workspaces/, { timeout: 60_000 })

    // ── A RELOAD must NOT prompt (issue 8509dc68) ───────────────────────────────
    // This used to be the opposite assertion. The store is encrypted, but its data
    // key is also wrapped under this browser's non-extractable device key, so the
    // page opens it with no user interaction. Demanding a key on every refresh was
    // the reason at-rest could not be turned on for everyone.
    await page.reload()
    await expect(page).toHaveURL(/workspaces/, { timeout: 90_000 })
    await expect(dialog).toBeHidden()

    // ── A NEW DEVICE is where the master secret earns its place ─────────────────
    // Clearing storage removes the device key, so the only way back is the wrap
    // under the master secret. The authenticator (and its passkey) survive, so
    // this exercises passkey unlock on a device that has never held these keys —
    // the path a reload no longer reaches.
    const origin = new URL(page.url()).origin
    await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    await signInDevice(page, url, user)

    await expect(dialog.getByRole('heading', { name: /verify this device/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.getByRole('button', { name: /unlock with passkey/i }).click()
    await expect(dialog).toBeHidden({ timeout: 90_000 })
    await expect(page).toHaveURL(/workspaces/, { timeout: 30_000 })

    // …and having unlocked once, this browser has a device key again and stops
    // asking.
    await page.reload()
    await expect(page).toHaveURL(/workspaces/, { timeout: 90_000 })
    await expect(dialog).toBeHidden()


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

/**
 * At-rest encryption for a key-only account, WITHOUT a prompt on reload (issue
 * 8509dc68). This is the test the whole two-wrap design exists to make possible.
 *
 * Before it, the choice was: encrypt the store and demand a 48-character recovery
 * key on every refresh, or don't encrypt. Both were wrong. The data key is now
 * wrapped twice — under this browser's non-extractable device key (no prompt) and
 * under the master secret (so a NEW device can still get in).
 *
 * No virtual authenticator, so `isUVPAA()` is false and no passkey is involved
 * anywhere: this is the plain "I just want a recovery key" user.
 */
test('at-rest: a key-only account is encrypted AND reloads with no prompt', async ({ browser }) => {
  const url = homeserverUrl()
  const user = uniqueUser('atrestkey')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  await registerDevice(page, url, user)
  const dialog = page.getByRole('dialog')
  const keyText = page.locator('.verify__key-text')
  await expect(keyText).toBeVisible({ timeout: 90_000 })
  const recoveryKey = ((await keyText.textContent()) ?? '').trim()
  expect(recoveryKey).not.toBe('')
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: /continue/i }).click()
  await expect(page).toHaveURL(/workspaces/, { timeout: 90_000 })

  await test.step('the store IS encrypted, with both wraps recorded', async () => {
    const account = await page.evaluate(() => {
      const raw = localStorage.getItem('collab:accounts')
      return raw ? JSON.parse(raw)[0] : null
    })
    expect(account, 'account persisted').toBeTruthy()
    expect(account.v, 'v2 (at-rest) entry').toBe(2)
    expect(account.deviceKeyWrap, 'device wrap — the no-prompt path').toBeTruthy()
    expect(account.dataKeyWrap, 'master wrap — the new-device path').toBeTruthy()
    expect(account.secrets, 'session blob is ciphertext').toBeTruthy()
    expect(account.matrixSessionData, 'no plaintext session blob').toBeFalsy()
    expect(JSON.stringify(account)).not.toMatch(/syt_|mat_|access[_-]?token/i)
  })

  await test.step('a reload restores SILENTLY — no unlock gate', async () => {
    // The point of the whole exercise. Encryption at rest must not cost a
    // recovery key on every refresh.
    await page.reload()
    await expect(page).toHaveURL(/workspaces/, { timeout: 90_000 })
    await expect(dialog).toBeHidden()
  })

  await test.step('but the master key is still what gets a NEW device in', async () => {
    // Clearing storage is a new device as far as the account is concerned: the
    // device key is gone, so the master wrap is the only way back. If this fails,
    // the device key has become a single point of failure — the thing the second
    // wrap exists to prevent.
    const client = await ctx.newCDPSession(page)
    const origin = new URL(page.url()).origin
    await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    await signInDevice(page, url, user)

    await expect(dialog.getByRole('heading', { name: /verify this device/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.locator('.verify__input').fill(recoveryKey)
    await dialog.getByRole('button', { name: /^restore$/i }).click()
    await expect(dialog).toBeHidden({ timeout: 90_000 })

    // …and having unlocked once, THIS browser stops asking too.
    await page.reload()
    await expect(page).toHaveURL(/workspaces/, { timeout: 90_000 })
    await expect(dialog).toBeHidden()
  })

  await ctx.close()
})
