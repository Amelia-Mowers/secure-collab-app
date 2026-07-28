import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { webcrypto } from 'node:crypto'
import 'fake-indexeddb/auto'
import { getOrCreateDeviceKey, getDeviceKey, clearDeviceKey } from './deviceKey'

/**
 * The device key (issue 8509dc68). The BROWSER-level question — does a
 * non-extractable CryptoKey survive a real reload — is answered by
 * `e2e/device-key.spec.ts`, because only a real browser can answer it. These
 * cover the logic around it: identity, absence, and forgetting.
 */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
  // node exposes CryptoKey on webcrypto rather than globally; the production code
  // guards with `instanceof CryptoKey` because a value read back from IndexedDB
  // is whatever was there, and every browser has the global.
  if (typeof (globalThis as { CryptoKey?: unknown }).CryptoKey === 'undefined') {
    Object.defineProperty(globalThis, 'CryptoKey', {
      value: (webcrypto as unknown as { CryptoKey: unknown }).CryptoKey,
      configurable: true,
    })
  }
})

describe('deviceKey', () => {
  beforeEach(async () => {
    await clearDeviceKey()
  })

  it('mints a key on first use', async () => {
    const key = await getOrCreateDeviceKey()
    expect(key).toBeInstanceOf(CryptoKey)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM' })
  })

  it('is NEVER extractable — the entire security property', async () => {
    // If this key could be exported, copying the IndexedDB value would be enough
    // to open everything it protects, and the scheme would be decoration.
    const key = await getOrCreateDeviceKey()
    expect(key.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('returns the SAME key on later calls, not a fresh one', async () => {
    // A new key each time would silently make yesterday's ciphertext unopenable.
    const first = await getOrCreateDeviceKey()
    const again = await getOrCreateDeviceKey()

    // Non-extractable keys can't be compared by bytes; prove it by cross-use.
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first, new Uint8Array([1, 2, 3]))
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, again, ct)
    expect(new Uint8Array(pt)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('reports absence rather than minting one', async () => {
    // The unlock path needs "no device key" to mean "ask the user", not "make a
    // key that decrypts nothing".
    expect(await getDeviceKey()).toBeUndefined()
    await getOrCreateDeviceKey()
    expect(await getDeviceKey()).toBeInstanceOf(CryptoKey)
  })

  it('forgetting it leaves nothing behind', async () => {
    await getOrCreateDeviceKey()
    await clearDeviceKey()
    expect(await getDeviceKey()).toBeUndefined()
  })

  it('forgetting is safe when there is nothing to forget', async () => {
    await expect(clearDeviceKey()).resolves.toBeUndefined()
  })

  it('a forgotten key is not the same as the next one', async () => {
    // Sign-out must genuinely orphan the old ciphertext on this device.
    const before = await getOrCreateDeviceKey()
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, before, new Uint8Array([7]))

    await clearDeviceKey()
    const after = await getOrCreateDeviceKey()

    await expect(
      globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, after, ct),
    ).rejects.toThrow()
  })
})
