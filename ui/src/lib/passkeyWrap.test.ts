import { describe, it, expect, beforeAll } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  addPasskeyWrap,
  emptyWrapRecord,
  hasEnrolledPasskey,
  parseWrapRecord,
  removePasskeyWrap,
  unwrapRecoveryKey,
  loadWrapRecord,
  saveWrapRecord,
  PASSKEY_WRAP_EVENT_TYPE,
  type PasskeyWrapRecord,
} from './passkeyWrap'
import { deriveAtRestKeys } from './atRestCrypto'

/**
 * The passkey wrap (issue 63dc1339). Real WebCrypto — jsdom provides it, and
 * these assertions are only worth anything against the actual primitives.
 *
 * The properties under test are the ones the design exists to guarantee: the
 * recovery key survives every passkey operation, a wrong passkey fails cleanly
 * rather than yielding something plausible, and nothing here can strand a user.
 */

// jsdom doesn't expose crypto.subtle; the real app runs in-browser where it's
// native. Polyfill from node:crypto, as atRestCrypto.test.ts does.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

const RECOVERY_KEY = 'EsTf 7hMs 2Nqk 9wRb 4dLc 8pXv 3jYt 6zAe 5uKg'
const PRF_A = 'prf-secret-from-laptop-passkey'
const PRF_B = 'prf-secret-from-phone-passkey'

const enrol = (
  record: PasskeyWrapRecord,
  credentialId: string,
  prfSecret: string,
  recoveryKey = RECOVERY_KEY,
) => addPasskeyWrap(record, { credentialId, prfSecret, recoveryKey })

describe('passkey wrap', () => {
  it('round-trips the recovery key through a passkey secret', async () => {
    const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    expect(await unwrapRecoveryKey(record, PRF_A)).toBe(RECOVERY_KEY)
  })

  it('never stores the recovery key in the clear', async () => {
    const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(RECOVERY_KEY)
    // …nor the PRF secret, which must never leave the device at all.
    expect(serialized).not.toContain(PRF_A)
  })

  it('returns null for a passkey that is not enrolled', async () => {
    // Ordinary outcome, not an error: the UI answers it by offering the manual
    // key, so it must not throw.
    const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    expect(await unwrapRecoveryKey(record, PRF_B)).toBeNull()
  })

  it('returns null when nothing is enrolled', async () => {
    expect(await unwrapRecoveryKey(emptyWrapRecord(), PRF_A)).toBeNull()
  })

  it('supports several passkeys at once, each unwrapping independently', async () => {
    // A laptop and a phone. Enrolling the second must not displace the first —
    // the failure mode the "second 4S key" design could not avoid.
    let record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    record = await enrol(record, 'cred-b', PRF_B)

    expect(record.wraps).toHaveLength(2)
    expect(await unwrapRecoveryKey(record, PRF_A)).toBe(RECOVERY_KEY)
    expect(await unwrapRecoveryKey(record, PRF_B)).toBe(RECOVERY_KEY)
  })

  it('replaces rather than duplicates when the same credential re-enrols', async () => {
    let record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    record = await enrol(record, 'cred-a', PRF_B)
    expect(record.wraps).toHaveLength(1)
    expect(await unwrapRecoveryKey(record, PRF_B)).toBe(RECOVERY_KEY)
    expect(await unwrapRecoveryKey(record, PRF_A)).toBeNull()
  })

  it('removing a passkey leaves the others working', async () => {
    let record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    record = await enrol(record, 'cred-b', PRF_B)
    record = removePasskeyWrap(record, 'cred-a')

    expect(await unwrapRecoveryKey(record, PRF_A)).toBeNull()
    expect(await unwrapRecoveryKey(record, PRF_B)).toBe(RECOVERY_KEY)
  })

  it('two passkeys wrap the SAME recovery key, so at-rest keys agree', async () => {
    // The reason for wrapping rather than adding a 4S key: `deriveAtRestKeys`
    // assumes one master secret. If each passkey implied a different secret, the
    // encrypted SDK store could only ever be opened by one of them.
    let record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    record = await enrol(record, 'cred-b', PRF_B)

    const viaA = await unwrapRecoveryKey(record, PRF_A)
    const viaB = await unwrapRecoveryKey(record, PRF_B)
    expect(viaA).toBe(viaB)

    const [keysA, keysB] = await Promise.all([
      deriveAtRestKeys(viaA!),
      deriveAtRestKeys(viaB!),
    ])
    expect(keysA.storePassphrase).toBe(keysB.storePassphrase)
  })

  it('does not derive the same key material as the at-rest layer', async () => {
    // Distinct HKDF salts: the same secret must not produce both a wrap key and
    // a store passphrase, so neither can leak anything about the other.
    const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
    const atRest = await deriveAtRestKeys(PRF_A)
    expect(record.wraps[0].wrap).not.toContain(atRest.storePassphrase)
  })

  it('rejects enrolling with no recovery key to wrap', async () => {
    await expect(
      addPasskeyWrap(emptyWrapRecord(), {
        credentialId: 'cred-a',
        prfSecret: PRF_A,
        recoveryKey: '',
      }),
    ).rejects.toThrow(/empty recovery key/)
  })

  describe('parsing a stored record', () => {
    it('round-trips through JSON', async () => {
      const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
      const parsed = parseWrapRecord(JSON.stringify(record))
      expect(await unwrapRecoveryKey(parsed, PRF_A)).toBe(RECOVERY_KEY)
    })

    it('degrades to "no passkeys" on junk rather than blocking unlock', () => {
      // A corrupt record must never be the reason someone cannot get in — the
      // typed recovery key still works, and that has to remain reachable.
      for (const junk of ['', 'not json', '{}', '{"v":2,"wraps":[]}', '{"v":1}', 'null']) {
        expect(parseWrapRecord(junk).wraps).toEqual([])
      }
      expect(parseWrapRecord(null).wraps).toEqual([])
      expect(parseWrapRecord(undefined).wraps).toEqual([])
    })

    it('drops malformed entries but keeps the sound ones', async () => {
      const record = await enrol(emptyWrapRecord(), 'cred-a', PRF_A)
      const mixed = JSON.stringify({
        v: 1,
        wraps: [{ credentialId: 'broken' }, ...record.wraps, { wrap: 'orphan' }],
      })
      const parsed = parseWrapRecord(mixed)
      expect(parsed.wraps).toHaveLength(1)
      expect(await unwrapRecoveryKey(parsed, PRF_A)).toBe(RECOVERY_KEY)
    })
  })

  it('reports whether the unlock screen should offer a passkey at all', async () => {
    expect(hasEnrolledPasskey(emptyWrapRecord())).toBe(false)
    expect(hasEnrolledPasskey(await enrol(emptyWrapRecord(), 'cred-a', PRF_A))).toBe(true)
  })

  describe('account-data transport', () => {
    const fakeSession = (stored?: string) => {
      const state = { stored }
      return {
        session: {
          getAccountData: async (type: string) =>
            type === PASSKEY_WRAP_EVENT_TYPE ? state.stored : undefined,
          setAccountData: async (_type: string, json: string) => {
            state.stored = json
          },
        },
        state,
      }
    }

    it('round-trips a record through the homeserver', async () => {
      const { session } = fakeSession()
      await saveWrapRecord(session, await enrol(emptyWrapRecord(), 'cred-a', PRF_A))
      const loaded = await loadWrapRecord(session)
      expect(await unwrapRecoveryKey(loaded, PRF_A)).toBe(RECOVERY_KEY)
    })

    it('reads as "no passkeys" when the account has none', async () => {
      expect((await loadWrapRecord(fakeSession().session)).wraps).toEqual([])
    })

    it('reads as "no passkeys" when the homeserver will not answer', async () => {
      // Must never be the reason someone cannot get in.
      const broken = {
        getAccountData: async () => {
          throw new Error('homeserver unreachable')
        },
        setAccountData: async () => {},
      }
      expect((await loadWrapRecord(broken)).wraps).toEqual([])
    })

    it('surfaces a failed WRITE rather than swallowing it', async () => {
      // The opposite of loading: if this is silent, the user believes a passkey
      // is enrolled when it is not, and finds out at the worst moment.
      const broken = {
        getAccountData: async () => undefined,
        setAccountData: async () => {
          throw new Error('write rejected')
        },
      }
      await expect(saveWrapRecord(broken, emptyWrapRecord())).rejects.toThrow(/write rejected/)
    })
  })
})
