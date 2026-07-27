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
  /** Declare which tables this tab is reading rows for. Cheap and idempotent —
   *  call it when the open table changes. */
  setTables(tableIds: string[]): void
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
  /** Queue-change listeners registered through `onQueueChanged`. */
  const queueListeners = new Set<() => void>()

  const unsubscribe = client.on(event => {
    if (event.event === 'workspace-state' && event.roomId === roomId) {
      try {
        current = JSON.parse(event.state) as WorkspaceState
      } catch (err) {
        console.warn('[worker] unreadable workspace state:', err)
        return
      }
      for (const listener of listeners) listener()
      return
    }
    if (event.event === 'queue-change' && event.roomId === roomId) {
      for (const listener of queueListeners) listener()
    }
  })

  /** Ask the worker for rows of the tables this tab is showing. */
  const resubscribe = () => {
    void client.subscribe(roomId, tableIds).catch(err => {
      // Not fatal: the previous subscription (if any) still delivers, and the
      // next table switch retries. Worth surfacing because a lost subscription
      // shows up as a grid that stops updating.
      console.warn('[worker] subscribe failed:', err)
    })
  }
  resubscribe()

  const call = (method: string, ...args: Array<string | number | boolean | Uint8Array | undefined>) =>
    client.roomCall(roomId, method, ...args)

  return {
    // ── Reads: answered from the last pushed bundle ───────────────────────────
    getTableRows: tableId => current.rows[tableId] ?? '[]',
    getRowOrderKeys: tableId => current.rowOrderKeys[tableId] ?? '{}',
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
    // `WorkspaceHandle` still declares these four as sync (the in-tab client
    // answers them from local state). The casts are the seam: the call sites are
    // widened to `await` when the direct path is retired, and then these go away.
    exportTableCsv: ((tableId: string) =>
      call('exportTableCsv', tableId)) as unknown as WorkspaceHandle['exportTableCsv'],
    exportWorkspaceZip: ((name: string) =>
      call('exportWorkspaceZip', name)) as unknown as WorkspaceHandle['exportWorkspaceZip'],
    previewCsvImport: ((tableId: string, csv: string, sample: number, overridesJson: string) =>
      call('previewCsvImport', tableId, csv, sample, overridesJson)) as unknown as WorkspaceHandle['previewCsvImport'],
    snapshot: (() => call('snapshot')) as unknown as WorkspaceHandle['snapshot'],

    // ── Session-ish passthroughs ──────────────────────────────────────────────
    inviteUser: userId => call('inviteUser', userId) as Promise<void>,
    listMembers: () => call('listMembers') as Promise<string>,
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
    setTables(next) {
      const changed =
        next.length !== tableIds.length || next.some((id, index) => id !== tableIds[index])
      if (!changed) return
      tableIds = [...next]
      resubscribe()
    },
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
