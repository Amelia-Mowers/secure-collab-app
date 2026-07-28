/**
 * At-rest encryption key derivation + AES-GCM helpers (issue c72ec5df).
 *
 * Everything persisted locally — the matrix-rust-sdk IndexedDB store, the
 * session token blob, and the workspace snapshot — is encrypted with keys
 * derived from the MASTER SECRET (the passkey-PRF secret, or the typed recovery
 * key). The master secret is never persisted: it's re-obtained each session
 * from the passkey (or manual entry) BEFORE the stores are opened, so disk
 * access alone decrypts nothing.
 *
 * Derivation: HKDF-SHA256 over the master secret with a fixed app salt and a
 * distinct `info` per purpose, so the three keys are independent and none is
 * the master secret itself (one-way). The SDK store passphrase is a base64url
 * string (what `indexeddb_store(name, Some(pass))` expects); the token/snapshot
 * keys are AES-GCM `CryptoKey`s.
 *
 * No key is ever written to disk; callers hold them in memory for the session.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Fixed, non-secret HKDF salt (domain separation is via `info`). */
const HKDF_SALT = 'io.tidework.atrest.v1'

const INFO = {
  storePassphrase: 'sdk-store-passphrase',
  tokenKey: 'session-token-key',
  snapshotKey: 'workspace-snapshot-key',
} as const

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) unavailable')
  return c.subtle
}

async function hkdfBits(masterSecret: string, info: string, bytes: number): Promise<ArrayBuffer> {
  const ikm = await subtle().importKey('raw', enc.encode(masterSecret), 'HKDF', false, [
    'deriveBits',
  ])
  return subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(info) },
    ikm,
    bytes * 8,
  )
}

async function deriveAesKey(masterSecret: string, info: string): Promise<CryptoKey> {
  const bits = await hkdfBits(masterSecret, info, 32)
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Keys derived from the master secret for this session (held in memory only). */
export interface AtRestKeys {
  /** Passphrase string for `ConnectedWorkspace`/`MatrixSession` `indexeddb_store`. */
  storePassphrase: string
  /** AES-GCM key for the session token blob (access/refresh tokens, client id). */
  tokenKey: CryptoKey
  /** AES-GCM key for the workspace snapshot blob. */
  snapshotKey: CryptoKey
}

/** Derive all at-rest keys from the master secret. Deterministic: the same
 *  secret always yields the same keys, so a later session re-derives them. */
export async function deriveAtRestKeys(masterSecret: string): Promise<AtRestKeys> {
  if (!masterSecret) throw new Error('deriveAtRestKeys: empty master secret')
  const [passBits, tokenKey, snapshotKey] = await Promise.all([
    hkdfBits(masterSecret, INFO.storePassphrase, 32),
    deriveAesKey(masterSecret, INFO.tokenKey),
    deriveAesKey(masterSecret, INFO.snapshotKey),
  ])
  return { storePassphrase: b64urlEncode(passBits), tokenKey, snapshotKey }
}

/** Just the SDK store passphrase (when the AES keys aren't needed yet). */
export async function deriveStorePassphrase(masterSecret: string): Promise<string> {
  return b64urlEncode(await hkdfBits(masterSecret, INFO.storePassphrase, 32))
}

/** AES-GCM encrypt a UTF-8 string → base64url(iv ‖ ciphertext+tag). */
export async function encryptString(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.length)
  return b64urlEncode(out.buffer)
}

/** Inverse of {@link encryptString}. Throws if the key is wrong or the blob
 *  was tampered with (AES-GCM authentication). */
export async function decryptString(key: CryptoKey, blob: string): Promise<string> {
  const buf = new Uint8Array(b64urlDecode(blob))
  if (buf.length < 13) throw new Error('decryptString: blob too short')
  const iv = buf.subarray(0, 12)
  const ct = buf.subarray(12)
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct)
  return dec.decode(pt)
}

// ── Data key (envelope) — issue 8509dc68 ────────────────────────────────────
//
// The problem with deriving the store passphrase straight from the master
// secret: a matrix-rust-sdk IndexedDB store's passphrase cannot be changed in
// place. So "encrypt the store" and "rotate the master secret" both mean
// building a NEW store, which means logging in again as a fresh device. That is
// why at-rest encryption only ever covered accounts that enrolled a passkey —
// the re-key had somewhere convenient to hide — and why putting it on the
// first-device path added a full re-login to every registration.
//
// The envelope removes the coupling. A random DATA KEY is generated once, at
// registration, and everything at rest is derived from IT:
//
//     dataKey                      random, per account, never changes
//     storePassphrase = HKDF(dataKey)   ← what opens the SDK store
//     tokenKey        = HKDF(dataKey)
//     snapshotKey     = HKDF(dataKey)
//     dataKeyWrap     = AES-GCM(HKDF(masterSecret), dataKey)   ← the envelope
//
// Two consequences, both of which the old shape could not give:
//
//  1. THE STORE CAN BE ENCRYPTED FROM THE FIRST LOGIN. The data key does not
//     depend on the master secret, so it exists before any recovery key does.
//  2. ROTATING THE MASTER SECRET IS JUST RE-WRAPPING. The store, the session
//     blob and the snapshot are all keyed by the data key, which is unchanged —
//     so no new store, and no re-login, ever.
//
// A DISTINCT HKDF SALT keeps this from colliding with the legacy master-secret
// derivation. Accounts written before this exist and must keep working: they have
// no `dataKeyWrap`, and for them the old `deriveAtRestKeys(masterSecret)` is
// still correct. Nothing is migrated eagerly — see the fallback at the call site.

/** Salt for keys derived from the DATA key. Distinct from HKDF_SALT so the two
 *  schemes can never produce the same material for the same input. */
const DK_SALT = 'io.tidework.atrest.datakey.v1'
/** Salt for the key that WRAPS the data key, derived from the master secret. */
const WRAP_SALT = 'io.tidework.atrest.wrap.v1'
const WRAP_INFO = 'data-key-wrap'

/** A fresh random data key (base64url). Generated once per account, at
 *  registration, and never rotated — rotating the MASTER secret only re-wraps
 *  it, which is the whole point. */
export function generateDataKey(): string {
  return b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer)
}

async function hkdfBitsWithSalt(
  ikmString: string,
  salt: string,
  info: string,
  bytes: number,
): Promise<ArrayBuffer> {
  const ikm = await subtle().importKey('raw', enc.encode(ikmString), 'HKDF', false, ['deriveBits'])
  return subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
    ikm,
    bytes * 8,
  )
}

/** At-rest keys derived from the DATA key — the scheme new accounts use. */
export async function deriveAtRestKeysFromDataKey(dataKey: string): Promise<AtRestKeys> {
  if (!dataKey) throw new Error('deriveAtRestKeysFromDataKey: empty data key')
  const [passBits, tokenBits, snapshotBits] = await Promise.all([
    hkdfBitsWithSalt(dataKey, DK_SALT, INFO.storePassphrase, 32),
    hkdfBitsWithSalt(dataKey, DK_SALT, INFO.tokenKey, 32),
    hkdfBitsWithSalt(dataKey, DK_SALT, INFO.snapshotKey, 32),
  ])
  const [tokenKey, snapshotKey] = await Promise.all([
    subtle().importKey('raw', tokenBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    subtle().importKey('raw', snapshotBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  ])
  return { storePassphrase: b64urlEncode(passBits), tokenKey, snapshotKey }
}

/** Just the store passphrase from a data key — needed at login, before the rest
 *  of the keys matter. */
export async function deriveStorePassphraseFromDataKey(dataKey: string): Promise<string> {
  return b64urlEncode(await hkdfBitsWithSalt(dataKey, DK_SALT, INFO.storePassphrase, 32))
}

async function wrapKeyFor(masterSecret: string): Promise<CryptoKey> {
  if (!masterSecret) throw new Error('data-key wrap: empty master secret')
  const bits = await hkdfBitsWithSalt(masterSecret, WRAP_SALT, WRAP_INFO, 32)
  return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Seal the data key under the master secret. The result is what gets persisted;
 *  the data key itself is never written anywhere. */
export async function wrapDataKey(masterSecret: string, dataKey: string): Promise<string> {
  return encryptString(await wrapKeyFor(masterSecret), dataKey)
}

/** Recover the data key. Throws on a wrong secret (AES-GCM authenticates), which
 *  is what lets the unlock gate tell a bad key from a broken one. */
export async function unwrapDataKey(masterSecret: string, wrapped: string): Promise<string> {
  return decryptString(await wrapKeyFor(masterSecret), wrapped)
}

// ── base64url (no padding) ──────────────────────────────────────────────────
function b64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}
