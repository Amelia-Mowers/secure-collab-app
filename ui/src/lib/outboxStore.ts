/**
 * Persistent outbox for unsent cell writes (ADR 0003 phase 1).
 *
 * `ConnectedWorkspace.updateCell` applies optimistically and enqueues the
 * update in an in-memory, debounced send queue. This module mirrors that
 * queue to IndexedDB (via `ConnectedWorkspace.pendingUpdates()`) so a tab
 * closed during an outage no longer silently loses "saved" edits — on the
 * next cold start the outbox replays through `restorePendingUpdates()`,
 * re-applying under LWW (a since-superseded write loses fairly, it carries
 * its original HLC timestamp) and re-entering the send queue.
 *
 * Storage mirrors snapshotStore: per-workspace key, best-effort (any failure
 * is a no-op), AES-GCM encrypted with the at-rest `snapshotKey` when one is
 * available — outbox entries hold decrypted workspace data, same as
 * snapshots. An empty queue clears the record rather than storing `[]`, so
 * the common case leaves nothing behind.
 *
 * Known gap (documented in the ADR): updates drained into an in-flight send
 * are briefly absent from `pendingUpdates()`; a crash inside that one-request
 * window can still lose them. On failure they are re-queued and re-mirrored.
 */

import { encryptString, decryptString } from './atRestCrypto'

const DB_NAME = 'tw-workspace-outbox'
const STORE = 'outbox'
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
 * The persisted outbox JSON (a CellUpdate array) for a workspace, or
 * `undefined` if none/unreadable. An encrypted blob with no (or a wrong) key
 * resolves to `undefined` — those writes are unrecoverable without the
 * master secret, exactly like an encrypted snapshot.
 */
export async function loadOutbox(
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
      if (!key) return undefined
      try {
        return await decryptString(key, raw.slice(ENC_PREFIX.length))
      } catch {
        return undefined
      }
    }
    return raw
  } catch {
    return undefined
  }
}

/**
 * Mirror the current pending queue (best-effort). `outboxJson` is the string
 * from `ConnectedWorkspace.pendingUpdates()`; an empty queue (`[]`) clears
 * the stored record instead.
 */
export async function saveOutbox(
  workspaceId: string,
  outboxJson: string,
  key?: CryptoKey,
): Promise<void> {
  try {
    if (!outboxJson || outboxJson === '[]') {
      await clearOutbox(workspaceId)
      return
    }
    const stored = key ? ENC_PREFIX + (await encryptString(key, outboxJson)) : outboxJson
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
    /* best-effort: the in-memory queue still retries while the tab lives */
  }
}

/** Remove a workspace's outbox (after successful replay, or on sign-out). */
export async function clearOutbox(workspaceId: string): Promise<void> {
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
