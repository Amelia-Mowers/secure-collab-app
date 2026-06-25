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
