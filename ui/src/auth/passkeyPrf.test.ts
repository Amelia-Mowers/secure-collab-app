import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import {
  confirmPasskeyPrf,
  hasPlatformAuthenticator,
  isPasskeyPrfSupported,
  registerPasskeyPrf,
  unlockPasskeyPrf,
} from './passkeyPrf'

/** A fake PublicKeyCredential carrying given extension results. */
function fakeCred(prf: unknown, rawId = new Uint8Array([9, 9, 9]).buffer) {
  return { rawId, getClientExtensionResults: () => ({ prf }) }
}
// base64url of bytes [1,2,3] is "AQID" (btoa('\x01\x02\x03') = 'AQID', no +//=).
const PRF_FIRST = new Uint8Array([1, 2, 3]).buffer
const PRF_SECRET = 'AQID'

describe('passkeyPrf', () => {
  let create: Mock
  let get: Mock

  beforeEach(() => {
    create = vi.fn()
    get = vi.fn()
    // jsdom has neither; define both as configurable so we can restore.
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: function () {},
      configurable: true,
    })
    Object.defineProperty(navigator, 'credentials', {
      value: { create, get },
      configurable: true,
    })
  })

  afterEach(() => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential
    delete (navigator as { credentials?: unknown }).credentials
    vi.restoreAllMocks()
  })

  describe('isPasskeyPrfSupported', () => {
    it('is false without PublicKeyCredential', () => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential
      expect(isPasskeyPrfSupported()).toBe(false)
    })
    it('is true when WebAuthn is present', () => {
      expect(isPasskeyPrfSupported()).toBe(true)
    })
  })

  describe('hasPlatformAuthenticator', () => {
    function setUvpaa(impl: () => Promise<boolean>) {
      const pkc = window.PublicKeyCredential as any
      pkc.isUserVerifyingPlatformAuthenticatorAvailable = vi.fn(impl)
    }

    it('is false when WebAuthn is unsupported (headless without it)', async () => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential
      await expect(hasPlatformAuthenticator()).resolves.toBe(false)
    })
    it('is true when a platform authenticator is available', async () => {
      setUvpaa(() => Promise.resolve(true))
      await expect(hasPlatformAuthenticator()).resolves.toBe(true)
    })
    it('is false when no platform authenticator (e.g. headless without one)', async () => {
      setUvpaa(() => Promise.resolve(false))
      await expect(hasPlatformAuthenticator()).resolves.toBe(false)
    })
    it('is false (not throwing) when the check errors', async () => {
      setUvpaa(() => Promise.reject(new Error('boom')))
      await expect(hasPlatformAuthenticator()).resolves.toBe(false)
    })
  })

  describe('registerPasskeyPrf', () => {
    it('uses the PRF result evaluated at create() time (single prompt)', async () => {
      create.mockResolvedValue(fakeCred({ enabled: true, results: { first: PRF_FIRST } }))
      const secret = await registerPasskeyPrf('@me:tidework.io', 'Me')
      expect(secret).toBe(PRF_SECRET)
      expect(get).not.toHaveBeenCalled() // no fallback assertion needed
    })

    it('requests a discoverable passkey with the PRF extension', async () => {
      create.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      await registerPasskeyPrf('@me:tidework.io', 'Me')
      const opts = create.mock.calls[0][0].publicKey
      expect(opts.authenticatorSelection.residentKey).toBe('required')
      expect(opts.authenticatorSelection.userVerification).toBe('required')
      expect(opts.extensions.prf).toBeDefined()
    })

    it('hints at this device rather than excluding roaming authenticators', async () => {
      // PRF is near-universal on platform authenticators and still missing from
      // some password managers, so the picker is steered toward Windows Hello /
      // Touch ID. Deliberately a HINT and not
      // `authenticatorSelection.authenticatorAttachment: 'platform'`: attachment
      // would exclude hardware security keys, which DO support PRF and are a
      // supported path here. (issue b5a7e62c)
      create.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      await registerPasskeyPrf('@me:tidework.io', 'Me')
      const opts = create.mock.calls[0][0].publicKey
      expect(opts.hints).toEqual(['client-device'])
      expect(opts.authenticatorSelection.authenticatorAttachment).toBeUndefined()
    })

    it('does not steer the UNLOCK assertion, which may be on another device', async () => {
      // At unlock the credential already exists and can legitimately live on a
      // security key or another device over hybrid/QR. Hinting at this device
      // there would hide a working path.
      get.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      await unlockPasskeyPrf()
      expect(get.mock.calls[0][0].publicKey.hints).toBeUndefined()
    })

    it('falls back to a get() when create() does not evaluate the PRF', async () => {
      create.mockResolvedValue(fakeCred({ enabled: true })) // no results at create
      get.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      const secret = await registerPasskeyPrf('@me:tidework.io', 'Me')
      expect(secret).toBe(PRF_SECRET)
      // The fallback targets the just-created credential.
      expect(get.mock.calls[0][0].publicKey.allowCredentials).toHaveLength(1)
    })

    it('throws when the authenticator reports PRF unsupported', async () => {
      create.mockResolvedValue(fakeCred({ enabled: false }))
      await expect(registerPasskeyPrf('@me:tidework.io', 'Me')).rejects.toThrow(/PRF/i)
    })

    it('names the provider problem when PRF is unsupported (issue b5a7e62c)', async () => {
      create.mockResolvedValue(fakeCred({ enabled: false }))
      // The message must steer the user: name a known-incompatible provider
      // class and the recovery-key way out.
      await expect(registerPasskeyPrf('@me:tidework.io', 'Me')).rejects.toThrow(/Bitwarden/)
    })

    it('surfaces the provider message when the fallback assertion has no PRF result', async () => {
      // create() succeeds but returns no PRF result and no enabled flag; the
      // fallback get() then yields no PRF either — a credential now exists that
      // can never derive a secret.
      create.mockResolvedValue(fakeCred({}))
      get.mockResolvedValue(fakeCred({ results: {} }))
      await expect(registerPasskeyPrf('@me:tidework.io', 'Me')).rejects.toThrow(/Bitwarden/)
    })

    it('throws when registration is cancelled', async () => {
      create.mockResolvedValue(null)
      await expect(registerPasskeyPrf('@me:tidework.io', 'Me')).rejects.toThrow(/cancelled/i)
    })

    it('throws when WebAuthn is unsupported', async () => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential
      await expect(registerPasskeyPrf('@me:tidework.io', 'Me')).rejects.toThrow(/not supported/i)
    })
  })

  describe('unlockPasskeyPrf', () => {
    it('derives the secret from a discoverable passkey (empty allowCredentials)', async () => {
      get.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      const secret = await unlockPasskeyPrf()
      expect(secret).toBe(PRF_SECRET)
      expect(get.mock.calls[0][0].publicKey.allowCredentials).toEqual([])
    })

    it('is deterministic: the same PRF output yields the same secret', async () => {
      get.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      const a = await unlockPasskeyPrf()
      const b = await unlockPasskeyPrf()
      expect(a).toBe(b)
    })

    it('throws when the passkey has no PRF result', async () => {
      get.mockResolvedValue(fakeCred({}))
      await expect(unlockPasskeyPrf()).rejects.toThrow(/PRF/i)
    })

    it('throws when unlock is cancelled', async () => {
      get.mockResolvedValue(null)
      await expect(unlockPasskeyPrf()).rejects.toThrow(/cancelled/i)
    })
  })

  describe('confirmPasskeyPrf (confirm-before-rotate guard)', () => {
    it('resolves when the passkey re-derives the same secret', async () => {
      get.mockResolvedValue(fakeCred({ results: { first: PRF_FIRST } }))
      await expect(confirmPasskeyPrf(PRF_SECRET)).resolves.toBeUndefined()
      // It exercises the *real* unlock path (discoverable, empty allowCredentials).
      expect(get.mock.calls[0][0].publicKey.allowCredentials).toEqual([])
    })

    it('rejects when the passkey produces a DIFFERENT secret (PRF mismatch)', async () => {
      // base64url of [4,5,6] is "BAUG" — not the expected "AQID".
      get.mockResolvedValue(fakeCred({ results: { first: new Uint8Array([4, 5, 6]).buffer } }))
      await expect(confirmPasskeyPrf(PRF_SECRET)).rejects.toThrow(/wasn.t enabled|existing key/i)
    })

    it('rejects when the authenticator exposes no PRF at unlock (PRF-less, e.g. password manager)', async () => {
      get.mockResolvedValue(fakeCred({}))
      await expect(confirmPasskeyPrf(PRF_SECRET)).rejects.toThrow(/wasn.t enabled|existing key/i)
    })

    it('rejects when the confirming assertion is cancelled', async () => {
      get.mockResolvedValue(null)
      await expect(confirmPasskeyPrf(PRF_SECRET)).rejects.toThrow(/wasn.t enabled|existing key/i)
    })
  })
})
