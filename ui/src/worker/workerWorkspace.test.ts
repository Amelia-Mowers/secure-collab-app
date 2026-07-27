import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWorkerWorkspace, type WorkerWorkspace } from './workerWorkspace'
import type { MatrixWorkerClient } from './client'
import type { Event, WorkspaceState } from './protocol'

/**
 * The tab-side `WorkspaceHandle` (issue 87bf86a6, option b).
 *
 * The property under test is the one that made option (b) worth choosing: reads
 * are SYNCHRONOUS, answered from the last bundle the worker pushed, so the grid,
 * sidebar and view layer keep working unchanged. Writes are forwarded and only
 * their promise is new.
 */

const ROOM = '!room:example.org'

function bundle(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    // Arrays of ID STRINGS, as `listTables` / `listViewsForTable` really return.
    tables: JSON.stringify(['items']),
    tableOrderKeys: '{"items":"a0"}',
    currentUserId: '@alice:example.org',
    isEncrypted: true,
    undecryptableCount: 0,
    connectionHealth: '{"state":"ok"}',
    rejectedWrites: '{"count":0,"lastReason":""}',
    pendingUpdates: '[]',
    schemas: { items: JSON.stringify({ id: 'items', name: 'Items' }) },
    viewsByTable: { items: JSON.stringify(['view-1']) },
    views: { 'view-1': JSON.stringify({ id: 'view-1', table_id: 'items' }) },
    rows: { items: JSON.stringify([{ _row_id: 'r1', name: 'Alpha' }]) },
    rowOrderKeys: { items: '{"r1":"a0"}' },
    ...overrides,
  }
}

describe('worker-backed workspace handle', () => {
  let calls: Array<{ method: string; args: unknown[] }>
  let subscriptions: string[][]
  let emit: (event: Event) => void
  let ws: WorkerWorkspace

  beforeEach(() => {
    calls = []
    subscriptions = []
    const handlers = new Set<(e: Event) => void>()
    emit = event => handlers.forEach(h => h(event))
    const client = {
      roomCall: (_roomId: string, method: string, ...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve('ok')
      },
      subscribe: (_roomId: string, tableIds: string[]) => {
        subscriptions.push(tableIds)
        return Promise.resolve()
      },
      on: (handler: (e: Event) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as MatrixWorkerClient
    ws = createWorkerWorkspace(client, ROOM)
  })

  const push = (state = bundle()) =>
    emit({ kind: 'event', event: 'workspace-state', roomId: ROOM, state: JSON.stringify(state) })

  it('subscribes as soon as it is created', () => {
    expect(subscriptions).toEqual([[]])
  })

  it('answers reads synchronously out of the pushed bundle', () => {
    push()
    // No awaits anywhere here — that is the whole point of option (b).
    expect(JSON.parse(ws.getTableRows('items'))).toEqual([{ _row_id: 'r1', name: 'Alpha' }])
    expect(JSON.parse(ws.getTableSchema('items')).name).toBe('Items')
    expect(JSON.parse(ws.getView('view-1')).table_id).toBe('items')
    expect(JSON.parse(ws.listTables())).toEqual(['items'])
    expect(JSON.parse(ws.listViewsForTable('items'))).toEqual(['view-1'])
    expect(ws.getTableOrderKeys?.()).toBe('{"items":"a0"}')
    expect(ws.getRowOrderKeys?.('items')).toBe('{"r1":"a0"}')
    expect(ws.currentUserId?.()).toBe('@alice:example.org')
    expect(ws.pendingUpdates?.()).toBe('[]')
  })

  it('reads empty rather than throwing before the first bundle arrives', () => {
    // Subscribing is a round-trip, so this window is real. The UI already
    // renders an empty table and re-renders when state lands.
    expect(ws.getTableRows('items')).toBe('[]')
    expect(ws.listTables()).toBe('[]')
    expect(ws.currentUserId?.()).toBeUndefined()
  })

  it('throws for a table or view that is genuinely absent', () => {
    // Distinct from "not pushed yet": callers JSON.parse these, so returning an
    // empty string would surface as a parse error rather than a clear one.
    push()
    expect(() => ws.getTableSchema('nope')).toThrow(/not found/)
    expect(() => ws.getView('nope')).toThrow(/not found/)
  })

  it('re-reads the newest bundle after each push', () => {
    push()
    push(
      bundle({ rows: { items: JSON.stringify([{ _row_id: 'r1', name: 'Alpha edited' }]) } }),
    )
    expect(JSON.parse(ws.getTableRows('items'))[0].name).toBe('Alpha edited')
  })

  it('treats every push as a change, which is what startSync signals', () => {
    const onChange = vi.fn()
    ws.startSync?.(onChange)
    push()
    push()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('ignores state for another room', () => {
    emit({
      kind: 'event',
      event: 'workspace-state',
      roomId: '!other:example.org',
      state: JSON.stringify(bundle()),
    })
    expect(ws.listTables()).toBe('[]')
  })

  it('keeps serving the last good bundle when a push is unreadable', () => {
    push()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    emit({ kind: 'event', event: 'workspace-state', roomId: ROOM, state: 'not json' })
    expect(JSON.parse(ws.getTableRows('items'))).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forwards queue-change events to the outbox mirror', () => {
    const onQueue = vi.fn()
    ws.onQueueChanged?.(onQueue)
    emit({ kind: 'event', event: 'queue-change', roomId: ROOM })
    emit({ kind: 'event', event: 'queue-change', roomId: '!other:example.org' })
    expect(onQueue).toHaveBeenCalledTimes(1)
  })

  it('forwards writes to the worker', async () => {
    await ws.updateCell('items', 'r1', 'name', '"next"')
    await ws.deleteRow('items', 'r1')
    await ws.addColumn('items', '{}')
    expect(calls).toEqual([
      { method: 'updateCell', args: ['items', 'r1', 'name', '"next"'] },
      { method: 'deleteRow', args: ['items', 'r1'] },
      { method: 'addColumn', args: ['items', '{}'] },
    ])
  })

  it('re-subscribes when the open table changes, and only then', () => {
    ws.setTables(['items'])
    ws.setTables(['items']) // same set — no round-trip
    ws.setTables(['other'])
    expect(subscriptions).toEqual([[], ['items'], ['other']])
  })

  it('stops listening on close, leaving the workspace open for other tabs', () => {
    const onChange = vi.fn()
    ws.startSync?.(onChange)
    ws.close()
    push()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('exposes the bundle for the health and banner hooks', () => {
    push()
    expect(ws.state()).toMatchObject({ isEncrypted: true, connectionHealth: '{"state":"ok"}' })
  })

  it('notifies onState subscribers until they unsubscribe', () => {
    const seen = vi.fn()
    const off = ws.onState(seen)
    push()
    off()
    push()
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
