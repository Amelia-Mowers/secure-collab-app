import { test, expect } from '@playwright/test'
import { homeserverUrl, registerDevice, uniqueUser } from './helpers'

/**
 * Closing the tab on the "Save your recovery key" screen must not brick the
 * account.
 *
 * This was a real lockout, and a quiet one. The SDK store is encrypted from the
 * first login with a data key held only in memory; the two wraps that record
 * how to get that key back were written by `confirmKeySaved`, i.e. only once
 * the user ticked the box. Close the tab before that and the account entry
 * stayed v1 — no `deviceKeyWrap`, no `secrets` — while the store on disk was
 * encrypted. The next load tried to open an encrypted store with no passphrase
 * and failed, every time. Server-side the backup was already Enabled, so
 * bootstrap never re-ran and the key was never shown again.
 *
 * A reload is the cheapest possible stand-in for "closed the tab": same
 * localStorage, same IndexedDB, fresh page. If the account survives that, it
 * survives the tab being closed.
 */
test('a reload before confirming the recovery key does not lock the account out', async ({
  page,
}) => {
  test.setTimeout(300_000)

  const url = homeserverUrl()
  const user = uniqueUser('abandon')
  await registerDevice(page, url, user)

  // Wait for the key to be on screen — that is the exact moment the old code
  // had generated a key server-side but written nothing locally.
  await expect(page.locator('.verify__key-text')).toBeVisible({ timeout: 90_000 })

  // Deliberately do NOT tick the box or press Continue.
  await page.reload()

  // The account must come back. Anything that can only be reached by opening
  // the encrypted store proves the data key was recovered from disk.
  await expect(page.locator('.verify__key-text, .workspace-card--new, .verify__title')).toBeVisible({
    timeout: 120_000,
  })

  // And specifically NOT the two failure shapes: an unlock gate asking for the
  // key the user never saved, or the misleading connectivity error the failed
  // store open used to produce.
  await expect(page.getByText('Could not reach the homeserver')).toHaveCount(0)
  await expect(page.getByText(/enter your recovery key/i)).toHaveCount(0)

  // The store opened, so the account entry is now v2 with both wraps — written
  // when the key was generated rather than when the user confirmed.
  const account = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem('collab:accounts') ?? '[]')
    const a = accounts[accounts.length - 1] ?? {}
    return { v: a.v, hasDeviceWrap: !!a.deviceKeyWrap, hasDataWrap: !!a.dataKeyWrap }
  })
  expect(account, 'the data key must be sealed as soon as it exists').toEqual({
    v: 2,
    hasDeviceWrap: true,
    hasDataWrap: true,
  })
})
