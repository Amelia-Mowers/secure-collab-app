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
 * SECURITY: snapshots hold DECRYPTED workspace data (plaintext at rest). The
 * matrix-rust-sdk store already keeps the keys to decrypt the same history
 * locally, so the marginal exposure is small; encrypting local stores at rest
 * holistically is tracked separately (issue c72ec5df).
 */

const DB_NAME = 'tw-workspace-snapshots'
const STORE = 'snapshots'

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

/** The persisted snapshot for a workspace, or `undefined` if none/unavailable. */
export async function loadSnapshot(workspaceId: string): Promise<string | undefined> {
  try {
    const db = await openDb()
    return await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(workspaceId)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? undefined)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  } catch {
    return undefined
  }
}

/** Persist a workspace snapshot (best-effort; errors are swallowed). */
export async function saveSnapshot(workspaceId: string, snapshot: string): Promise<void> {
  if (!snapshot) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(snapshot, workspaceId)
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
