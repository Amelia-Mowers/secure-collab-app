import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { retireStore, reapStores } from './storeReaper'

const PENDING_KEY = 'collab:pendingStoreDeletions'

/** A stand-in for `indexedDB.deleteDatabase` whose outcome we choose per name.
 *  jsdom ships no IndexedDB, so this is also what makes the module testable at
 *  all. */
type Outcome = 'success' | 'error' | 'blocked' | 'hang'
let outcomes: Record<string, Outcome>
let attempts: string[]

function installFakeIndexedDB() {
  attempts = []
  ;(globalThis as any).indexedDB = {
    deleteDatabase(name: string) {
      attempts.push(name)
      const req: any = {}
      // Fire on a macrotask, the way a real request does — the caller attaches
      // its handlers synchronously after this returns.
      setTimeout(() => {
        const outcome = outcomes[name] ?? 'success'
        if (outcome === 'success') req.onsuccess?.()
        else if (outcome === 'error') req.onerror?.()
        else if (outcome === 'blocked') req.onblocked?.()
        // 'hang': never settles, so only the timeout resolves it
      }, 0)
      return req
    },
  }
}

const pending = () => JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]')

describe('storeReaper', () => {
  beforeEach(() => {
    localStorage.clear()
    outcomes = {}
    installFakeIndexedDB()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deletes the store and leaves nothing queued when it works', async () => {
    await retireStore('tw-alice-123')
    expect(attempts).toEqual(['tw-alice-123'])
    expect(pending()).toEqual([])
  })

  // The whole reason this module is a queue rather than a call: the shared
  // worker holds the store open, so the first attempt usually blocks.
  it('keeps the name queued when the delete is blocked', async () => {
    outcomes['tw-alice-123'] = 'blocked'
    await retireStore('tw-alice-123')
    expect(pending()).toEqual(['tw-alice-123'])
  })

  it('does not hang forever when the request never settles', async () => {
    vi.useFakeTimers()
    outcomes['tw-alice-123'] = 'hang'
    const done = retireStore('tw-alice-123')
    await vi.advanceTimersByTimeAsync(2100)
    await done
    expect(pending()).toEqual(['tw-alice-123'])
  })

  it('reaps what a previous session could not, and clears the queue', async () => {
    outcomes['tw-alice-1'] = 'blocked'
    outcomes['tw-bob-2'] = 'blocked'
    await retireStore('tw-alice-1')
    await retireStore('tw-bob-2')
    expect(pending()).toEqual(['tw-alice-1', 'tw-bob-2'])

    // Next boot: nothing holds them open any more.
    outcomes = {}
    installFakeIndexedDB()
    expect(await reapStores()).toEqual(['tw-alice-1', 'tw-bob-2'])
    expect(pending()).toEqual([])
  })

  it('keeps only the ones that are still stuck', async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify(['tw-gone', 'tw-open']))
    outcomes['tw-open'] = 'blocked'
    expect(await reapStores()).toEqual(['tw-gone'])
    expect(pending()).toEqual(['tw-open'])
  })

  // A bug that queued one of these would delete a live session's outbox or
  // snapshot cache, so refusing them is worth a test rather than a comment.
  it('refuses to delete the app-wide stores', async () => {
    await retireStore('tw-workspace-outbox')
    await retireStore('collab-device-key')
    expect(attempts).toEqual([])
    expect(pending()).toEqual([])

    // …and drops them if they somehow reach the queue, rather than retrying.
    localStorage.setItem(PENDING_KEY, JSON.stringify(['tw-workspace-snapshots']))
    expect(await reapStores()).toEqual([])
    expect(attempts).toEqual([])
    expect(pending()).toEqual([])
  })

  it('ignores an empty name and never queues a duplicate', async () => {
    await retireStore(undefined)
    await retireStore('')
    expect(attempts).toEqual([])

    outcomes['tw-alice-1'] = 'blocked'
    await retireStore('tw-alice-1')
    await retireStore('tw-alice-1')
    expect(pending()).toEqual(['tw-alice-1'])
  })

  it('does nothing at boot when the queue is empty', async () => {
    expect(await reapStores()).toEqual([])
    expect(attempts).toEqual([])
  })

  it('survives corrupt queue contents rather than throwing at boot', async () => {
    localStorage.setItem(PENDING_KEY, '{not json')
    expect(await reapStores()).toEqual([])
    localStorage.setItem(PENDING_KEY, JSON.stringify(['tw-ok', 42, null]))
    expect(await reapStores()).toEqual(['tw-ok'])
  })
})
