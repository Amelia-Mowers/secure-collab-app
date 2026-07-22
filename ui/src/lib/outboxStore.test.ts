import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { loadOutbox, saveOutbox, clearOutbox } from './outboxStore'
import { deriveAtRestKeys } from './atRestCrypto'

// jsdom exposes neither crypto.subtle nor IndexedDB; polyfill both (same
// pattern as atRestCrypto.test.ts).
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
})

const WS = '!room:example.org'
const OUTBOX = JSON.stringify([
  { table_id: 't', row_id: 'r1', column_id: 'status', value: 'open', timestamp: 1721600000001 },
  { table_id: 't', row_id: 'r2', column_id: 'title', value: 'hello', timestamp: 1721600000002 },
])

beforeEach(() => {
  // Fresh IndexedDB per test.
  globalThis.indexedDB = new IDBFactory()
})

describe('outboxStore', () => {
  it('round-trips a plaintext outbox per workspace', async () => {
    await saveOutbox(WS, OUTBOX)
    expect(await loadOutbox(WS)).toBe(OUTBOX)
    // Other workspaces are unaffected.
    expect(await loadOutbox('!other:example.org')).toBeUndefined()
  })

  it('round-trips an encrypted outbox and refuses the wrong key', async () => {
    const { snapshotKey } = await deriveAtRestKeys('correct-master-secret')
    await saveOutbox(WS, OUTBOX, snapshotKey)
    expect(await loadOutbox(WS, snapshotKey)).toBe(OUTBOX)

    // No key / wrong key → undefined, never ciphertext or a throw.
    expect(await loadOutbox(WS)).toBeUndefined()
    const { snapshotKey: wrongKey } = await deriveAtRestKeys('wrong-secret')
    expect(await loadOutbox(WS, wrongKey)).toBeUndefined()
  })

  it('an empty queue clears the stored record instead of storing []', async () => {
    await saveOutbox(WS, OUTBOX)
    await saveOutbox(WS, '[]')
    expect(await loadOutbox(WS)).toBeUndefined()
  })

  it('clearOutbox removes the record', async () => {
    await saveOutbox(WS, OUTBOX)
    await clearOutbox(WS)
    expect(await loadOutbox(WS)).toBeUndefined()
  })

  it('is a graceful no-op without IndexedDB', async () => {
    // Simulate an environment with no IndexedDB at all.
    // @ts-expect-error deliberate removal
    delete globalThis.indexedDB
    await expect(saveOutbox(WS, OUTBOX)).resolves.toBeUndefined()
    await expect(loadOutbox(WS)).resolves.toBeUndefined()
    await expect(clearOutbox(WS)).resolves.toBeUndefined()
  })
})
