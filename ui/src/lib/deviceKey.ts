/**
 * The DEVICE key: a non-extractable AES-GCM key, persisted in IndexedDB, that
 * lets this browser open its own encrypted store with no user interaction
 * (issue 8509dc68).
 *
 * ## Why this exists
 *
 * At-rest encryption needs a key that isn't lying next to the ciphertext. If that
 * key can only come from the user's master secret, then every page load needs the
 * master secret — which in practice means typing a 48-character recovery key on
 * every refresh. That was the real reason at-rest could not be turned on for
 * everyone, and it is not a trade worth making: people would turn it off, or
 * worse, keep a copy of the key somewhere convenient.
 *
 * A non-extractable `CryptoKey` breaks the deadlock. It is structured-cloneable,
 * so IndexedDB can store the KEY OBJECT itself; script can then `encrypt` and
 * `decrypt` with it forever but can never read its bytes — `exportKey` rejects.
 * Verified by running, on Chromium and Firefox, in `e2e/device-key.spec.ts`.
 *
 * ## What it protects, and what it does not
 *
 * PROTECTS the realistic at-rest threat: someone images the disk, copies the
 * browser profile directory, or reads a backup. The raw key material is not in
 * the IndexedDB value — it lives in the browser's key store — so the ciphertext
 * they walk away with is not openable.
 *
 * DOES NOT protect against malicious script on this origin (it can use the key,
 * as it could use anything the page can), nor against somebody sitting at an
 * unlocked machine with the browser open. Neither does the master-secret scheme
 * once unlocked, and no browser design can fix the first. Stating the boundary
 * here so nobody mistakes this for more than it is.
 *
 * The master-secret wrap stays alongside this one — see `atRestCrypto`'s
 * envelope. That is what a NEW device uses, and it is why losing this browser
 * profile is recoverable rather than fatal.
 */

const DB_NAME = 'collab-device-key'
const DB_VERSION = 1
const STORE = 'keys'
/** Single well-known record: one device key per browser profile per origin. */
const KEY_ID = 'at-rest-device-key'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) unavailable')
  return c.subtle
}

async function read(): Promise<CryptoKey | undefined> {
  const db = await openDb()
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY_ID)
      req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? undefined)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function write(key: CryptoKey): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(key, KEY_ID)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/**
 * This browser profile's device key, creating it on first use.
 *
 * `extractable: false` is the entire security property, so it is not a parameter
 * — there is no caller who should be able to ask for an exportable one.
 */
export async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const existing = await read()
  // Guard the type: a value from IndexedDB is whatever was there, and treating a
  // non-key as a key fails much later and much less clearly.
  if (existing instanceof CryptoKey) return existing

  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await write(key)
  return key
}

/** This browser's device key if it already has one, else `undefined`. Used where
 *  a MISSING key must mean "fall back to asking the user" rather than "silently
 *  mint a new one that can decrypt nothing". */
export async function getDeviceKey(): Promise<CryptoKey | undefined> {
  try {
    const existing = await read()
    return existing instanceof CryptoKey ? existing : undefined
  } catch {
    return undefined
  }
}

/**
 * Forget this browser's device key.
 *
 * Sign-out and account reset both need it: leaving the key behind would let the
 * next person at this browser open whatever ciphertext survived. Anything still
 * encrypted under it becomes unopenable on this device — which is the point, and
 * why the master-secret wrap is what makes it recoverable elsewhere.
 */
export async function clearDeviceKey(): Promise<void> {
  try {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(KEY_ID)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  } catch {
    /* best-effort: nothing to forget, or no IndexedDB at all */
  }
}
