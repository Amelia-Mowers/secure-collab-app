/**
 * The passkey as a WRAPPER around the recovery key, not a second way into 4S
 * (issue 63dc1339).
 *
 * ## Why this shape
 *
 * The account keeps exactly ONE Matrix secret-storage (4S) key: the random
 * recovery key the user saves. A passkey does not become a second 4S key — it
 * stores an encrypted copy OF the recovery key, under a key derived from the
 * passkey's PRF output:
 *
 *     enroll:  wrapKey = HKDF(prfSecret)
 *              wrap    = AES-GCM(wrapKey, recoveryKey)
 *     unlock:  recoveryKey = AES-GCM-open(HKDF(prfSecret), wrap)
 *                          → the existing recoverWithKey path, unchanged
 *
 * Three properties fall out of that, which the "add a second 4S key" design
 * could not give us:
 *
 *  1. THE TYPED RECOVERY KEY ALWAYS WORKS, because it is the only 4S key there
 *     is. Not a promise maintained by careful code — a fact about the shape.
 *  2. ENROLLING OR REMOVING A PASSKEY CANNOT ENDANGER HISTORY, because neither
 *     touches secret storage. A passkey that turns out not to support PRF
 *     leaves the account exactly as it was. (Today's flow calls
 *     `enableRecoveryWithPassphrase` / `resetRecovery`, which is precisely why
 *     a failed passkey attempt is currently dangerous.)
 *  3. AT-REST STAYS SINGLE-SECRET. `deriveAtRestKeys` assumes one master
 *     secret; two independent unlock secrets would derive two different store
 *     passphrases and only one could ever open the encrypted store. Wrapping
 *     makes both paths converge on the recovery key before any at-rest key is
 *     derived.
 *
 * It also made the multi-key alternative unnecessary: matrix-rust-sdk 0.14 can
 * WRITE a secret under several 4S keys (`put_secret` merges into the per-secret
 * map) but can only ever READ with the default one — `open_secret_store` has no
 * open-by-key-id, and `create_secret_store` makes its new key the default.
 *
 * ## Where a wrap lives
 *
 * Both places, for different reasons:
 *
 *  - ACCOUNT DATA (`io.tidework.passkey_wrap`), so a NEW device can log in and
 *    unlock with the passkey alone. The homeserver holds ciphertext only; the
 *    PRF secret never leaves the device.
 *  - LOCALLY, alongside the account entry, because at-rest cold start is
 *    circular otherwise: reading account data needs a client, a client needs
 *    the encrypted store, and the store needs the master secret we are trying
 *    to obtain. The local copy breaks that cycle.
 *
 * ## Security
 *
 * Equivalent in strength to 4S passphrase mode: AES-GCM under an HKDF-SHA256
 * key whose input keying material is the PRF output, which is authenticator-held
 * and gated on user verification. The wrap authenticates, so a wrong secret
 * fails cleanly rather than yielding a plausible-looking key.
 */

import { encryptString, decryptString } from './atRestCrypto'

/** Matrix account-data event type carrying the wraps. */
export const PASSKEY_WRAP_EVENT_TYPE = 'io.tidework.passkey_wrap'

/**
 * Fixed HKDF salt. DISTINCT from `atRestCrypto`'s salt on purpose: the same PRF
 * secret must not derive both a wrap key and an at-rest key, so that neither
 * leaks anything about the other.
 */
const HKDF_SALT = 'io.tidework.passkey-wrap.v1'
const HKDF_INFO = 'recovery-key-wrap'

/** One passkey's stored wrap. */
export interface PasskeyWrap {
  /** WebAuthn credential id (base64url) — which passkey this wrap belongs to,
   *  so a specific one can be removed without disturbing the others. */
  credentialId: string
  /** AES-GCM(wrapKey, recoveryKey), base64url. */
  wrap: string
  /** Label for the account screen, e.g. the device that enrolled it. */
  label?: string
  /** Enrolment time (ms since epoch), for display only. */
  addedAt?: number
}

/** The account-data payload. A record, not a single wrap, so a user can enrol
 *  a laptop AND a phone without either displacing the other. */
export interface PasskeyWrapRecord {
  v: 1
  wraps: PasskeyWrap[]
}

const enc = new TextEncoder()

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) unavailable')
  return c.subtle
}

/** Derive the AES-GCM key that wraps the recovery key, from a passkey's PRF
 *  output. One-way: the wrap key tells you nothing about the PRF secret. */
async function deriveWrapKey(prfSecret: string): Promise<CryptoKey> {
  if (!prfSecret) throw new Error('deriveWrapKey: empty PRF secret')
  const ikm = await subtle().importKey('raw', enc.encode(prfSecret), 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(HKDF_SALT),
      info: enc.encode(HKDF_INFO),
    },
    ikm,
    256,
  )
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** An empty record — what a user with no passkeys has. */
export function emptyWrapRecord(): PasskeyWrapRecord {
  return { v: 1, wraps: [] }
}

/**
 * Parse a stored record, tolerating anything unexpected.
 *
 * Returns an EMPTY record rather than throwing on junk: a corrupt or
 * unrecognised wrap record must degrade to "this account has no passkeys" — the
 * typed recovery key still works — never to a failure that blocks unlocking.
 */
export function parseWrapRecord(json: string | null | undefined): PasskeyWrapRecord {
  if (!json) return emptyWrapRecord()
  try {
    const parsed = JSON.parse(json) as PasskeyWrapRecord
    if (parsed?.v !== 1 || !Array.isArray(parsed.wraps)) return emptyWrapRecord()
    return {
      v: 1,
      wraps: parsed.wraps.filter(
        w => typeof w?.credentialId === 'string' && typeof w?.wrap === 'string',
      ),
    }
  } catch {
    return emptyWrapRecord()
  }
}

/**
 * Add (or replace) the wrap for one passkey. Re-enrolling the same credential
 * replaces its wrap rather than accumulating duplicates.
 */
export async function addPasskeyWrap(
  record: PasskeyWrapRecord,
  entry: { credentialId: string; prfSecret: string; recoveryKey: string; label?: string },
): Promise<PasskeyWrapRecord> {
  if (!entry.recoveryKey) throw new Error('addPasskeyWrap: empty recovery key')
  if (!entry.credentialId) throw new Error('addPasskeyWrap: empty credential id')
  const wrap = await encryptString(await deriveWrapKey(entry.prfSecret), entry.recoveryKey)
  return {
    v: 1,
    wraps: [
      ...record.wraps.filter(w => w.credentialId !== entry.credentialId),
      { credentialId: entry.credentialId, wrap, label: entry.label, addedAt: Date.now() },
    ],
  }
}

/** Forget one passkey. The recovery key is untouched — this only deletes a
 *  convenience copy, so it can never cost the user their history. */
export function removePasskeyWrap(
  record: PasskeyWrapRecord,
  credentialId: string,
): PasskeyWrapRecord {
  return { v: 1, wraps: record.wraps.filter(w => w.credentialId !== credentialId) }
}

/**
 * Recover the recovery key from a PRF secret, or `null` if no wrap matches.
 *
 * Tries EVERY wrap rather than looking up by credential id. The id from an
 * assertion should match, but AES-GCM authenticates, so a non-matching wrap
 * fails cleanly and cheaply — and scanning means a wrap still works if the id
 * was recorded differently by another client. `null` (not a throw) because "this
 * passkey isn't enrolled" is an ordinary outcome the UI answers by offering the
 * manual key.
 */
export async function unwrapRecoveryKey(
  record: PasskeyWrapRecord,
  prfSecret: string,
): Promise<string | null> {
  if (record.wraps.length === 0) return null
  const key = await deriveWrapKey(prfSecret)
  for (const candidate of record.wraps) {
    try {
      const recoveryKey = await decryptString(key, candidate.wrap)
      if (recoveryKey) return recoveryKey
    } catch {
      // Wrong passkey for this wrap — expected while scanning.
    }
  }
  return null
}

/** Whether this account has any passkey enrolled — drives whether the unlock
 *  screen offers the passkey option at all. */
export function hasEnrolledPasskey(record: PasskeyWrapRecord): boolean {
  return record.wraps.length > 0
}

// ── Account-data transport ──────────────────────────────────────────────────
//
// Typed against the two methods rather than a concrete session, so it works
// unchanged for the worker-backed session and the in-tab one.

/** The slice of a Matrix session this module needs. */
export interface AccountDataSession {
  getAccountData(eventType: string): Promise<string | undefined> | string | undefined
  setAccountData(eventType: string, json: string): Promise<void> | void
}

/**
 * Load the account's wrap record from the homeserver.
 *
 * Never throws: a homeserver that will not answer, or a payload we cannot read,
 * means "no passkeys" — the typed recovery key still works, and it must stay
 * reachable no matter what this returns.
 */
export async function loadWrapRecord(session: AccountDataSession): Promise<PasskeyWrapRecord> {
  try {
    return parseWrapRecord(await session.getAccountData(PASSKEY_WRAP_EVENT_TYPE))
  } catch (err) {
    console.warn('[passkey] could not read the wrap record:', err)
    return emptyWrapRecord()
  }
}

/** Persist the wrap record. Throws — unlike loading, a failed WRITE must be
 *  surfaced, or the user believes a passkey is enrolled when it is not. */
export async function saveWrapRecord(
  session: AccountDataSession,
  record: PasskeyWrapRecord,
): Promise<void> {
  await session.setAccountData(PASSKEY_WRAP_EVENT_TYPE, JSON.stringify(record))
}
