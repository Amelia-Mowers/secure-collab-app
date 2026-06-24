import { describe, it, expect, beforeAll } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  deriveAtRestKeys,
  deriveStorePassphrase,
  encryptString,
  decryptString,
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
