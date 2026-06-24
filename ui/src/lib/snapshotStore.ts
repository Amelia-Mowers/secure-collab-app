/**
 * Local persistence for workspace snapshots (issue 6f092cf4 — incremental cold
 * start).
 *
 * A snapshot is the JSON produced by `ConnectedWorkspace.snapshot()`: the
 * materialized workspace state plus a marker (highest origin_server_ts). On
 * reload we load it as a baseline and pass it back to
 * `ConnectedWorkspace.create()`, so cold start only fetches events newer than
 * the marker instead of re-paginating the entire room history.
 *
 * Stored in its own IndexedDB database, keyed by room (workspace) id. Every op
 * is best-effort: any failure (no IndexedDB, quota, blocked, etc.) resolves to
 * a no-op so the workspace cleanly falls back to a full history gather.
 *
 * SECURITY (issue c72ec5df): snapshots hold DECRYPTED workspace data. When an
 * AES-GCM `key` (the at-rest `snapshotKey`, derived from the master secret — see
 * atRestCrypto.ts) is passed, the blob is encrypted at rest and an encrypted
 * blob can't be read without re-deriving that key from the passkey/recovery
 * secret. When no key is passed (legacy / pre-unlock), it falls back to a
 * plaintext blob, exactly as before — so existing call sites are unchanged and a
 * plaintext snapshot still loads. The on-disk marker distinguishes the two.
 */

import { encryptString, decryptString } from './atRestCrypto'

const DB_NAME = 'tw-workspace-snapshots'
const STORE = 'snapshots'
/** Marker prefix on encrypted blobs (base64url never contains ':'). */
const ENC_PREFIX = 'twenc:1:'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * The persisted snapshot for a workspace, or `undefined` if none/unavailable.
 * Pass the at-rest `key` to read an encrypted snapshot; an encrypted blob with
 * no (or a wrong) key resolves to `undefined` (→ caller does a full gather).
 */
export async function loadSnapshot(
  workspaceId: string,
  key?: CryptoKey,
): Promise<string | undefined> {
  try {
    const db = await openDb()
    const raw = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(workspaceId)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? undefined)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    if (raw === undefined) return undefined
    if (raw.startsWith(ENC_PREFIX)) {
      if (!key) return undefined // encrypted but no key → fall back to full gather
      try {
        return await decryptString(key, raw.slice(ENC_PREFIX.length))
      } catch {
        return undefined // wrong key / tampered → full gather
      }
    }
    return raw // legacy plaintext
  } catch {
    return undefined
  }
}

/**
 * Persist a workspace snapshot (best-effort; errors are swallowed). When `key`
 * is provided the blob is AES-GCM encrypted at rest; otherwise it's stored
 * plaintext (legacy / pre-unlock behavior).
 */
export async function saveSnapshot(
  workspaceId: string,
  snapshot: string,
  key?: CryptoKey,
): Promise<void> {
  if (!snapshot) return
  try {
    const stored = key ? ENC_PREFIX + (await encryptString(key, snapshot)) : snapshot
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(stored, workspaceId)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    /* best-effort: a missing snapshot just means a full gather next time */
  }
}

/** Remove a workspace's snapshot (e.g. on sign-out / store reset). */
export async function clearSnapshot(workspaceId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(workspaceId)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => resolve()
    })
  } catch {
    /* best-effort */
  }
}
