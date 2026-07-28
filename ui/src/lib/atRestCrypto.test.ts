import { describe, it, expect, beforeAll } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  deriveAtRestKeys,
  deriveStorePassphrase,
  encryptString,
  decryptString,
  generateDataKey,
  deriveAtRestKeysFromDataKey,
  deriveStorePassphraseFromDataKey,
  wrapDataKey,
  unwrapDataKey,
} from './atRestCrypto'

// jsdom doesn't expose crypto.subtle; the real app runs in-browser where it's
// native. Polyfill from node:crypto for the test environment.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

describe('atRestCrypto', () => {
  it('derives deterministically: same secret → same keys', async () => {
    const a = await deriveAtRestKeys('master-secret-xyz')
    const b = await deriveAtRestKeys('master-secret-xyz')
    expect(a.storePassphrase).toBe(b.storePassphrase)
    // AES keys are non-extractable; prove equality by cross-decrypting.
    const blob = await encryptString(a.tokenKey, 'hello')
    expect(await decryptString(b.tokenKey, blob)).toBe('hello')
  })

  it('different secrets → different store passphrases', async () => {
    const a = await deriveStorePassphrase('secret-A')
    const b = await deriveStorePassphrase('secret-B')
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(20)
  })

  it('domain separation: token and snapshot keys are independent', async () => {
    const k = await deriveAtRestKeys('master-secret-xyz')
    const blob = await encryptString(k.tokenKey, 'payload')
    // The snapshot key must NOT decrypt a token-key blob.
    await expect(decryptString(k.snapshotKey, blob)).rejects.toThrow()
  })

  it('AES-GCM round-trips arbitrary strings', async () => {
    const k = await deriveAtRestKeys('s')
    for (const pt of ['', 'a', JSON.stringify({ accessToken: 'tok', n: 42 }), '🔐 unicode']) {
      expect(await decryptString(k.tokenKey, await encryptString(k.tokenKey, pt))).toBe(pt)
    }
  })

  it('wrong key fails to decrypt', async () => {
    const a = await deriveAtRestKeys('secret-A')
    const b = await deriveAtRestKeys('secret-B')
    const blob = await encryptString(a.tokenKey, 'secret data')
    await expect(decryptString(b.tokenKey, blob)).rejects.toThrow()
  })

  it('tampered ciphertext fails authentication', async () => {
    const k = await deriveAtRestKeys('s')
    const blob = await encryptString(k.tokenKey, 'integrity matters')
    // Flip a character in the middle of the base64url blob.
    const i = Math.floor(blob.length / 2)
    const flipped = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1)
    await expect(decryptString(k.tokenKey, flipped)).rejects.toThrow()
  })

  it('rejects an empty master secret', async () => {
    await expect(deriveAtRestKeys('')).rejects.toThrow()
  })
})

describe('data-key envelope (issue 8509dc68)', () => {
  const MASTER = 'EsTf 7hMs 2Nqk 9wRb 4dLc 8pXv'
  const OTHER = 'a completely different recovery key'

  it('generates a distinct high-entropy data key each time', () => {
    const a = generateDataKey()
    const b = generateDataKey()
    expect(a).not.toBe(b)
    // 32 bytes base64url, unpadded.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('round-trips the data key through the master secret', async () => {
    const dataKey = generateDataKey()
    const wrapped = await wrapDataKey(MASTER, dataKey)
    expect(wrapped).not.toContain(dataKey)
    expect(await unwrapDataKey(MASTER, wrapped)).toBe(dataKey)
  })

  it('refuses a wrong master secret rather than yielding a plausible key', async () => {
    // AES-GCM authenticates, so the unlock gate can tell "wrong key" from
    // "broken store" instead of opening a store with garbage.
    const wrapped = await wrapDataKey(MASTER, generateDataKey())
    await expect(unwrapDataKey(OTHER, wrapped)).rejects.toThrow()
  })

  it('derives at-rest keys deterministically from the data key', async () => {
    const dataKey = generateDataKey()
    const a = await deriveAtRestKeysFromDataKey(dataKey)
    const b = await deriveAtRestKeysFromDataKey(dataKey)
    expect(a.storePassphrase).toBe(b.storePassphrase)
    // AES keys are non-extractable; prove equality by cross-decrypting.
    const blob = await encryptString(a.tokenKey, 'hello')
    expect(await decryptString(b.tokenKey, blob)).toBe('hello')
  })

  it('the store passphrase helper agrees with the full derivation', async () => {
    // Login needs the passphrase before the other keys matter, so the two paths
    // must not drift.
    const dataKey = generateDataKey()
    expect(await deriveStorePassphraseFromDataKey(dataKey)).toBe(
      (await deriveAtRestKeysFromDataKey(dataKey)).storePassphrase,
    )
  })

  it('SURVIVES a master-secret rotation without changing the store passphrase', async () => {
    // The entire reason for the envelope. Rotating the master secret used to mean
    // a new store and a fresh login, because the passphrase was derived from the
    // secret. Now it is a re-wrap.
    const dataKey = generateDataKey()
    const before = await deriveAtRestKeysFromDataKey(dataKey)

    const rewrapped = await wrapDataKey(OTHER, await unwrapDataKey(MASTER, await wrapDataKey(MASTER, dataKey)))
    const after = await deriveAtRestKeysFromDataKey(await unwrapDataKey(OTHER, rewrapped))

    expect(after.storePassphrase).toBe(before.storePassphrase)
  })

  it('does not collide with the legacy master-secret derivation', async () => {
    // Existing accounts still derive from the master secret and must keep
    // working; the two schemes must never produce the same material for the same
    // input, or one could silently open the other's store.
    const legacy = await deriveAtRestKeys(MASTER)
    const viaDataKey = await deriveAtRestKeysFromDataKey(MASTER)
    expect(viaDataKey.storePassphrase).not.toBe(legacy.storePassphrase)
  })

  it('rejects an empty data key', async () => {
    await expect(deriveAtRestKeysFromDataKey('')).rejects.toThrow(/empty data key/)
  })

  it('rejects an empty master secret when wrapping', async () => {
    await expect(wrapDataKey('', generateDataKey())).rejects.toThrow(/empty master secret/)
  })
})
