/**
 * Deleting the per-device IndexedDB store when an account goes away.
 *
 * Every login and register creates its OWN store — `tw-<user>-<millis>`, see
 * `new_store_name` in bridge_matrix.rs — because the store must be configured
 * before login, when the device id does not exist yet. Sign out and that store
 * is orphaned: nothing references it and nothing ever deletes it. Sign in and
 * out a few times and the browser is holding several copies of an account's
 * history, forever. Encrypted at rest, but still there, and still counted
 * against the origin's quota.
 *
 * Deleting one is not as simple as calling `deleteDatabase`, for two reasons:
 *
 *  1. The SharedWorker owns the Matrix client, so the store's IndexedDB
 *     connection lives in the WORKER, not in this page. `deleteDatabase` on a
 *     database somebody still has open fires `blocked` and then waits — it does
 *     not fail, it just never finishes. Dropping the worker's JS reference does
 *     not close the connection either: the wasm client is never `free()`d, so
 *     the handle survives until the worker itself is terminated.
 *
 *  2. `removeAccount` can target an account that is not signed in, whose store
 *     name lives inside an encrypted session blob it cannot read.
 *
 * So deletion is a QUEUE, not a call. `retireStore` records the name, tries
 * once, and gives up quietly if it blocks. `reapStores` runs at boot — before
 * any session is restored and therefore before the worker has opened
 * anything — and retries whatever is still pending. Worst case a store
 * survives until the next cold start, which is a long way better than forever.
 *
 * (2) is handled at the other end: `storeName` is now recorded in plaintext on
 * the account record. It is a sanitized username plus a timestamp — the
 * CONTENTS stay encrypted, and knowing the name of a database you cannot
 * decrypt buys an attacker nothing they did not already have from
 * `indexedDB.databases()`.
 */

const PENDING_KEY = 'collab:pendingStoreDeletions'

/** Databases the app creates under its own fixed names. A bug that queued one
 *  of these would delete the outbox or the snapshot cache out from under a
 *  live session, so the reaper refuses to touch them. */
const PROTECTED = new Set(['tw-workspace-snapshots', 'tw-workspace-outbox', 'collab-device-key'])

function readPending(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function writePending(names: string[]) {
  try {
    if (names.length === 0) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, JSON.stringify(names))
  } catch {
    /* storage full or blocked — the store simply stays until next time */
  }
}

/**
 * Try to delete one database, resolving `false` rather than hanging if someone
 * still has it open.
 *
 * The timeout is the point. `onblocked` fires when another connection is open,
 * but the request stays live and will complete later if that connection ever
 * closes — so awaiting it can block a sign-out indefinitely. We stop waiting
 * and let the boot sweep have it instead.
 */
function deleteDatabase(name: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.deleteDatabase(name)
    } catch {
      return done(false)
    }
    req.onsuccess = () => done(true)
    req.onerror = () => done(false)
    // Not a failure — a "not yet". The request may still succeed after we have
    // stopped waiting, which is why the caller keeps the name queued either way
    // and `reap` treats a re-delete of an already-gone database as success.
    req.onblocked = () => done(false)
    setTimeout(() => done(false), timeoutMs)
  })
}

/**
 * Queue an account's store for deletion and make one attempt now.
 *
 * Called on sign-out and account removal. Always queues first: if the attempt
 * blocks on the worker's connection, or the tab is closed mid-flight, the name
 * is already durable and the next boot picks it up.
 */
export async function retireStore(storeName: string | undefined | null): Promise<void> {
  if (!storeName || PROTECTED.has(storeName)) return
  const pending = readPending()
  if (!pending.includes(storeName)) writePending([...pending, storeName])
  if (await deleteDatabase(storeName)) {
    writePending(readPending().filter(n => n !== storeName))
  }
}

/**
 * Delete everything still queued. Call once at startup, BEFORE restoring a
 * session — that is the only moment we can count on the worker not holding any
 * store open, and it is why a blocked deletion is worth deferring rather than
 * forcing.
 *
 * Returns the names actually deleted, for tests and for the console line.
 */
export async function reapStores(): Promise<string[]> {
  const pending = readPending()
  if (pending.length === 0) return []
  const deleted: string[] = []
  const stuck: string[] = []
  for (const name of pending) {
    if (PROTECTED.has(name)) continue // drop, don't retry
    // A database that no longer exists deletes successfully, so a name queued
    // twice — or already reaped by a parallel tab — clears itself.
    if (await deleteDatabase(name)) deleted.push(name)
    else stuck.push(name)
  }
  writePending(stuck)
  if (deleted.length > 0) {
    console.info(`[store-reaper] deleted ${deleted.length} orphaned store(s)`)
  }
  return deleted
}
