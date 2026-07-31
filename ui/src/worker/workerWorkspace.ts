/**
 * A `WorkspaceHandle` backed by the SharedWorker instead of an in-tab Matrix
 * client (issue 87bf86a6, option b).
 *
 * The shape of the trade, and why it is option (b) rather than (a):
 *
 *  - READS STAY SYNCHRONOUS. The worker pushes a materialized bundle
 *    (`workspace-state`) on every change, and every read the UI performs during
 *    render answers out of the last bundle. Making the handle wholly async
 *    (option a) would have meant touching every call site in the grid, the
 *    sidebar, the view layer and the filters.
 *  - WRITES BECOME MESSAGES. They return a promise that resolves when the
 *    worker has applied the write to the one real workspace, which is also when
 *    it enters the one real send queue — the queue belonging to the client that
 *    owns the sync stream. That is the actual bug fixed.
 *  - THE OCCASIONAL READS BECOME ASYNC. `exportTableCsv`, `previewCsvImport`,
 *    `exportWorkspaceZip` and `snapshot` are user-initiated and never on a
 *    render path, so they forward instead of bloating every pushed bundle. The
 *    `WorkspaceHandle` interface already declares the mutators as
 *    `void | Promise<void>`; these four are widened the same way.
 *
 * A read taken BEFORE the first bundle arrives returns empty rather than
 * throwing. That window is real (subscribe is a round-trip) and the UI already
 * handles an empty table — it re-renders when state lands.
 */

import type { WorkspaceHandle } from '../hooks/useTable'
import type { MatrixWorkerClient } from './client'
import type { WorkspaceState } from './protocol'

/** The empty bundle a handle answers from until the first push lands. */
const EMPTY: WorkspaceState = {
  tables: '[]',
  tableOrderKeys: '{}',
  isEncrypted: false,
  undecryptableCount: 0,
  connectionHealth: '{}',
  rejectedWrites: '{"count":0,"lastReason":""}',
  pendingUpdates: '[]',
  schemas: {},
  viewsByTable: {},
  views: {},
  rows: {},
  rowOrderKeys: {},
}

/** A worker-backed workspace plus the controls the hook layer needs. */
export interface WorkerWorkspace extends WorkspaceHandle {
  /** Tables whose rows this tab has asked for — see the note on demand-driven
   *  subscription in `createWorkerWorkspace`. Diagnostics. */
  subscribedTables(): string[]
  /** The worker persists the snapshot and outbox for this workspace, so the tab
   *  must NOT also mirror them: it would be reading the send queue one hop from
   *  where it changes (which silently persisted a stale outbox), and N tabs would
   *  race over one record. */
  readonly persistedByWorker: true
  /**
   * Resolves when the first bundle has landed.
   *
   * The hook layer awaits this before handing the workspace to the UI, which is
   * what removes the "no state yet" window entirely rather than making every
   * reader cope with it. Found the hard way: a second tab rendered its grid
   * before its first push, `getTableSchema` threw "Table not found", and the
   * grid came up empty and stayed that way.
   */
  ready(): Promise<void>
  /** Latest pushed bundle (diagnostics, and the health/banner hooks). */
  state(): WorkspaceState
  /** Register a callback fired whenever a new bundle lands. */
  onState(callback: () => void): () => void
  /** Stop listening. The worker keeps the workspace open for other tabs. */
  close(): void
}

/**
 * Build a worker-backed workspace for `roomId`. The workspace must already be
 * open in the worker (`client.openWorkspace`).
 */
export function createWorkerWorkspace(
  client: MatrixWorkerClient,
  roomId: string,
): WorkerWorkspace {
  let current: WorkspaceState = EMPTY
  let tableIds: string[] = []
  const listeners = new Set<() => void>()
  let announceReady: () => void = () => {}
  const readyPromise = new Promise<void>(resolve => {
    announceReady = resolve
  })
  /** Queue-change listeners registered through `onQueueChanged`. */
  const queueListeners = new Set<() => void>()

  const unsubscribe = client.on(event => {
    if (event.event === 'workspace-state' && event.roomId === roomId) {
      const previousQueue = current.pendingUpdates
      try {
        current = JSON.parse(event.state) as WorkspaceState
      } catch (err) {
        console.warn('[worker] unreadable workspace state:', err)
        return
      }
      announceReady()
      for (const listener of listeners) listener()
      // A bundle can also be the first time this tab learns the send queue
      // changed — see the note on the `queue-change` branch below.
      if (current.pendingUpdates !== previousQueue) {
        for (const listener of queueListeners) listener()
      }
      return
    }
    if (event.event === 'queue-change' && event.roomId === roomId) {
      // Fired from the bridge's own queue callback, which runs INSIDE the write,
      // before the state push that carries the new queue. So on its own it makes
      // the outbox mirror read a bundle that predates the enqueue and persist an
      // empty queue — which is why the push above fires these listeners too.
      //
      // That mattered more than it sounds: a SharedWorker is terminated when its
      // last port goes away, so a reload destroys the worker AND its send queue.
      // The persistent outbox is the only thing that carries an unsent write
      // across, and it was being written stale. A drag-then-reload lost the write
      // every time (kanban e2e, 3/3), while the same test with 15s of slack
      // passed — the interval mirror had caught up by then.
      for (const listener of queueListeners) listener()
    }
  })

  /** Ask the worker for rows of the tables this tab has read. */
  const resubscribe = () => {
    void client.subscribe(roomId, tableIds).catch(err => {
      // Not fatal: the previous subscription (if any) still delivers, and the
      // next read retries. Worth surfacing because a lost subscription shows up
      // as a grid that stops updating.
      console.warn('[worker] subscribe failed:', err)
    })
  }
  resubscribe()

  /**
   * Note a table this tab reads rows from, subscribing if it is new.
   *
   * DEMAND-DRIVEN rather than declared by the caller, because there is no
   * caller who knows. `useTable` knows the open table, but
   * `makeReferenceLookup` resolves whatever table a `reference` column points at
   * — synchronously, during render, for an id only known at that moment. Any
   * "declare your tables up front" API would have to be threaded through the
   * grid, the entry view, the kanban view and the cell registry, and would still
   * miss a case.
   *
   * So a read for an unknown table returns empty and subscribes; the push that
   * follows re-renders with the real rows. That is the same brief window as
   * before the first bundle arrives, which the UI already handles — a reference
   * cell shows its raw id for one frame instead of its label.
   *
   * Subscribing is coalesced to one message per tick, so a render resolving five
   * reference tables sends one subscribe, and it converges: the resulting push
   * re-renders, that render reads the same tables, the set is unchanged, no
   * further message.
   */
  let pendingResubscribe = false
  const noteTable = (tableId: string) => {
    if (tableIds.includes(tableId)) return
    tableIds = [...tableIds, tableId]
    if (pendingResubscribe) return
    pendingResubscribe = true
    queueMicrotask(() => {
      pendingResubscribe = false
      resubscribe()
    })
  }

  const call = (method: string, ...args: Array<string | number | boolean | Uint8Array | undefined>) =>
    client.roomCall(roomId, method, ...args)

  return {
    // ── Reads: answered from the last pushed bundle ───────────────────────────
    getTableRows: tableId => {
      noteTable(tableId)
      return current.rows[tableId] ?? '[]'
    },
    getRowOrderKeys: tableId => {
      noteTable(tableId)
      return current.rowOrderKeys[tableId] ?? '{}'
    },
    getTableSchema: tableId => {
      const schema = current.schemas[tableId]
      // Distinguish "not pushed yet" from "no such table": callers parse this,
      // and an empty string would throw inside JSON.parse for both cases.
      if (!schema) throw new Error(`Table ${tableId} not found`)
      return schema
    },
    getView: viewId => {
      const view = current.views[viewId]
      if (!view) throw new Error(`View ${viewId} not found`)
      return view
    },
    listTables: () => current.tables,
    listViewsForTable: tableId => current.viewsByTable[tableId] ?? '[]',
    getTableOrderKeys: () => current.tableOrderKeys,
    currentUserId: () => current.currentUserId,
    pendingUpdates: () => current.pendingUpdates,
    // Scalars the bundle already carries. These are not optional extras: the UI
    // FEATURE-DETECTS them (`typeof workspace.connectionHealth === 'function'`)
    // and silently does nothing when they are absent — so omitting
    // `connectionHealth` left the connection badge permanently hidden, and
    // omitting `myRole` left every role check falling back. Neither failed
    // loudly; the e2e suite is what caught them.
    isEncrypted: () => current.isEncrypted,
    undecryptableCount: () => current.undecryptableCount,
    connectionHealth: () => current.connectionHealth,
    rejectedWrites: () => current.rejectedWrites,

    // ── Writes: forwarded to the one real client ──────────────────────────────
    createTable: definition => call('createTable', definition) as Promise<string>,
    createView: config => call('createView', config) as Promise<string>,
    addColumn: (tableId, columnJson) => call('addColumn', tableId, columnJson) as Promise<void>,
    reorderColumns: (tableId, orderedIdsJson) =>
      call('reorderColumns', tableId, orderedIdsJson) as Promise<void>,
    updateColumn: (tableId, columnId, patchJson) =>
      call('updateColumn', tableId, columnId, patchJson) as Promise<void>,
    deleteColumn: (tableId, columnId) => call('deleteColumn', tableId, columnId) as Promise<void>,
    updateCell: (tableId, rowId, columnId, valueJson) =>
      call('updateCell', tableId, rowId, columnId, valueJson) as Promise<void>,
    deleteRow: (tableId, rowId) => call('deleteRow', tableId, rowId) as Promise<void>,
    deleteTable: tableId => call('deleteTable', tableId) as Promise<void>,
    renameTable: (tableId, name) => call('renameTable', tableId, name) as Promise<void>,
    setColumnWidth: (tableId, columnId, width) =>
      call('setColumnWidth', tableId, columnId, width) as Promise<void>,
    deleteView: viewId => call('deleteView', viewId) as Promise<void>,
    setTableOrder: (tableId, orderKey) => call('setTableOrder', tableId, orderKey) as Promise<void>,
    importCsv: (tableId, tableName, csv, columnsJson) =>
      call('importCsv', tableId, tableName, csv, columnsJson) as Promise<string>,
    importWorkspaceZip: bytes => call('importWorkspaceZip', bytes) as Promise<string>,
    importWorkspaceArchive: filesJson =>
      call('importWorkspaceArchive', filesJson) as Promise<string>,
    restorePendingUpdates: json => {
      // Declared sync on the interface but only ever used for its side effect
      // (the count is logged). Fire it and report zero: with the worker owning
      // the outbox this path exists for the tab that happens to open first.
      void call('restorePendingUpdates', json)
      return 0
    },
    applyUpdate: update => {
      void call('applyUpdate', update)
    },

    // ── Async by design: user-initiated, never on a render path ───────────────
    // These forward rather than bloating every pushed bundle. `WorkspaceHandle`
    // now declares them `T | Promise<T>`, so the `as unknown as` casts that used
    // to mark this seam are gone and the call sites simply await — which costs
    // the in-tab client nothing, since it resolves immediately.
    exportTableCsv: tableId => call('exportTableCsv', tableId) as Promise<string>,
    exportWorkspaceZip: name => call('exportWorkspaceZip', name) as Promise<Uint8Array>,
    previewCsvImport: (tableId, csv, sample, overridesJson) =>
      call('previewCsvImport', tableId, csv, sample, overridesJson) as Promise<string>,
    snapshot: () => call('snapshot') as Promise<string>,

    // ── Session-ish passthroughs ──────────────────────────────────────────────
    inviteUser: userId => call('inviteUser', userId) as Promise<void>,
    listMembers: () => call('listMembers') as Promise<string>,
    myRole: () => call('myRole') as Promise<string>,
    setUserRole: (userId: string, role: string) => call('setUserRole', userId, role) as Promise<void>,
    leaveWorkspace: (removeEveryone: boolean) =>
      call('leaveWorkspace', removeEveryone) as Promise<void>,
    getChangeLog: tableId => call('getChangeLog', tableId) as Promise<string>,
    rollbackTo: (tableId, targetServerTs, label) =>
      call('rollbackTo', tableId, targetServerTs, label) as Promise<number>,
    checkIntegrity: () => call('checkIntegrity') as Promise<string>,

    // ── Callbacks ─────────────────────────────────────────────────────────────
    startSync: onChange => {
      // The worker owns the sync loop; a tab only listens. Every pushed bundle
      // means "something changed", which is exactly what this callback signals.
      listeners.add(onChange)
    },
    onQueueChanged: callback => {
      queueListeners.add(callback)
    },

    // ── Controls ──────────────────────────────────────────────────────────────
    ready: () => readyPromise,
    persistedByWorker: true,
    subscribedTables: () => [...tableIds],
    state: () => current,
    onState(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    close() {
      unsubscribe()
      listeners.clear()
      queueListeners.clear()
    },
  }
}
