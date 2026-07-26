import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

/** Shown when a viewer attempts a write the homeserver would refuse anyway. */
const READ_ONLY_MESSAGE = 'You have view-only access to this workspace'
import { getWasmModule } from '../wasm/loader'
import { loadSnapshot, saveSnapshot } from '../lib/snapshotStore'
import { loadOutbox, saveOutbox, clearOutbox } from '../lib/outboxStore'
import { getSnapshotKey } from '../lib/atRestSession'
import { useRole } from './useRole'
import { canEdit } from '../lib/roles'

// ── Cross-tab broadcast ──────────────────────────────────────────────────────
//
// When a tab mutates data or receives a Matrix sync event, it posts a
// data-free signal on a BroadcastChannel keyed to the workspace (room) ID.
// Other tabs listening on the same channel re-read from their own WASM
// workspace (kept up-to-date by the Matrix sync stream).
//
// SECURITY: The broadcast carries NO plaintext content — only a "something
// changed" ping.  This prevents leaking decrypted data to same-origin
// contexts that might be listening on the channel.

const CHANNEL_PREFIX = 'collab:workspace:'

/** Get or create a BroadcastChannel for a workspace. */
function getWorkspaceChannel(workspaceId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(`${CHANNEL_PREFIX}${workspaceId}`)
  } catch {
    return null
  }
}

/**
 * Post a signal to sibling tabs that something changed in this workspace.
 *
 * SECURITY: This intentionally sends NO data — only a signal.  Plaintext
 * workspace content must never leave the tab that decrypted it.  Receiving
 * tabs re-read from their own WASM workspace (populated via the Matrix
 * sync stream) when they see this signal.
 */
export function notifyWorkspaceChanged(workspaceId: string) {
  const ch = getWorkspaceChannel(workspaceId)
  if (ch) {
    ch.postMessage({ type: 'workspace-changed' })
    ch.close()
  }
}

/**
 * Shared workspace interface.
 *
 * Both the local-only WasmWorkspace and the Matrix-connected ConnectedWorkspace
 * expose these methods. The only difference is that ConnectedWorkspace's
 * mutation methods (updateCell, createTable, etc.) are async and send updates
 * to the Matrix room.
 */
export interface WorkspaceHandle {
  createTable(definition: string): string | Promise<string>
  createView(config: string): string | Promise<string>
  addColumn(tableId: string, columnJson: string): void | Promise<void>
  reorderColumns(tableId: string, orderedIdsJson: string): void | Promise<void>
  updateColumn(tableId: string, columnId: string, patchJson: string): void | Promise<void>
  deleteColumn(tableId: string, columnId: string): void | Promise<void>
  updateCell(tableId: string, rowId: string, columnId: string, value: string): void | Promise<void>
  applyUpdate(update: string): void
  getTableRows(tableId: string): string
  getRowOrderKeys?(tableId: string): string
  getTableSchema(tableId: string): string
  getView(viewId: string): string
  listTables(): string
  listViewsForTable(tableId: string): string
  deleteRow(tableId: string, rowId: string): void | Promise<void>
  // Table-level delete / reorder (issue c36f496d). Present on both bridges.
  deleteTable?(tableId: string): void | Promise<void>
  /** Rename a table in place — id, columns, rows, and views all survive. */
  renameTable?(tableId: string, name: string): void | Promise<void>
  /** Persist a column's display width — column metadata, so collaborators
   *  see the same layout. */
  setColumnWidth?(tableId: string, columnId: string, width: number): void | Promise<void>
  /** Delete a saved view (tombstone). The table and its data are untouched. */
  deleteView?(viewId: string): void | Promise<void>
  setTableOrder?(tableId: string, orderKey: string): void | Promise<void>
  getTableOrderKeys?(): string
  /** CSV interchange (ADR 0004). Export renders one table with column names as
   *  headers and references as labels; preview is a dry run that reports what
   *  wouldn't apply *before* the import commits. */
  exportTableCsv?(tableId: string): string
  previewCsvImport?(tableId: string, csv: string, sample: number, overridesJson: string): string
  importCsv?(
    tableId: string,
    tableName: string,
    csv: string,
    columnsJson: string,
  ): Promise<string> | string
  // ConnectedWorkspace-only methods (optional)
  startSync?(onChange: () => void): void
  inviteUser?(userId: string): Promise<void>
  listMembers?(): Promise<string>
  /** The signed-in user's MXID (ConnectedWorkspace only) — what `@me` filters
   *  resolve to. */
  currentUserId?(): string | undefined
  /** Serialize current state for incremental cold start (ConnectedWorkspace only). */
  snapshot?(): string
  /** Change history (edits + reverts) as a JSON array, newest-first, optionally
   *  scoped to one table. ConnectedWorkspace only — walks the room timeline. */
  getChangeLog?(tableId?: string): Promise<string>
  /** Roll `tableId` back to its state at `targetServerTs` (a Matrix
   *  origin_server_ts, ms): records a `_history` revert row + sends the batched
   *  restore. Returns the number of updates sent (0 = already at that state).
   *  ConnectedWorkspace only. */
  rollbackTo?(tableId: string, targetServerTs: number, label?: string): Promise<number>
  /** The unsent send queue as a JSON CellUpdate array — mirrored to the
   *  persistent outbox (ADR 0003). ConnectedWorkspace only. */
  pendingUpdates?(): string
  /** Register a callback fired whenever the pending queue changes, so the
   *  outbox mirror can run while the page is alive (issue 980ac596). */
  onQueueChanged?(callback: () => void): void
  /** Replay a persisted outbox after cold start: re-applies under LWW and
   *  re-enqueues for send; returns how many were replayed. */
  restorePendingUpdates?(json: string): number
}

interface TableRow {
  _row_id: string
  [key: string]: any
}

/** Room members as {id, label} for member-type cells. Loads once per
 *  workspace handle (member churn is rare; a re-mount refreshes). */
export function useMembers(workspace: WorkspaceHandle | null): Array<{ id: string; label: string }> {
  const [members, setMembers] = useState<Array<{ id: string; label: string }>>([])
  useEffect(() => {
    let cancelled = false
    const ws = workspace as any
    if (!ws || typeof ws.listMembers !== 'function') {
      setMembers([])
      return
    }
    const load = async () => {
      try {
        const parsed = JSON.parse(await ws.listMembers()) as Array<{
          userId: string
          displayName?: string
        }>
        if (!cancelled) {
          setMembers(parsed.map(m => ({ id: m.userId, label: m.displayName || '' })))
        }
      } catch {
        if (!cancelled) setMembers([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [workspace])
  return members
}

/** The signed-in user's MXID — the viewer a `@me` filter resolves to. `null`
 *  until the workspace handle exposes it (older bindings) or if signed out. */
export function useCurrentUserId(workspace: WorkspaceHandle | null): string | null {
  return useMemo(() => {
    const ws = workspace as any
    if (!ws || typeof ws.currentUserId !== 'function') return null
    try {
      return ws.currentUserId() ?? null
    } catch {
      return null
    }
  }, [workspace])
}

interface UseTableResult {
  rows: TableRow[]
  loading: boolean
  error: Error | null
  updateCell: (rowId: string, columnId: string, value: any) => Promise<void>
  deleteRow: (rowId: string) => Promise<void>
  refresh: () => Promise<void>
  /** Cells (`rowId:columnId`) whose recent local edit was overwritten by a
   *  concurrent remote write (legitimate LWW loss). The UI shows a brief
   *  highlight; the history drawer is the recovery path. Entries expire after
   *  a few seconds. (ADR 0003 item 4) */
  conflictCells: Set<string>
  /** True when this user may not write (a `viewer` role). Views should hide
   *  their editing affordances; `updateCell`/`deleteRow` also refuse. */
  readOnly: boolean
}

/** How long a local edit is "recent" — a remote overwrite inside this window
 *  counts as a conflict worth indicating. */
const CONFLICT_WINDOW_MS = 15_000
/** How long the highlight lingers before the cell clears. */
const CONFLICT_FLASH_MS = 2_500

/**
 * Hook for using a table from the workspace.
 *
 * Works with both WasmWorkspace (local-only) and ConnectedWorkspace (Matrix).
 * When a ConnectedWorkspace is used, remote changes trigger automatic
 * re-fetches via the startSync onChange callback.
 *
 * After every local mutation the hook broadcasts a change notification so
 * sibling tabs can refresh in near-real-time.
 */
export function useTable(
  workspace: WorkspaceHandle | null,
  tableId: string,
  workspaceId?: string,
  /** Incremented when remote changes arrive (from sync or cross-tab broadcast).
   *  Triggers a re-read of rows from the WASM workspace. */
  syncCount?: number,
): UseTableResult {
  const [rows, setRows] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [conflictCells, setConflictCells] = useState<Set<string>>(new Set())
  /** Viewers may read everything and change nothing (issue: workspace roles). */
  const readOnly = !canEdit(useRole(workspace, syncCount))
  const prevSyncCountRef = useRef(syncCount)

  // Track in-flight mutations so sync-triggered re-reads don't clobber
  // optimistic state while a write is still pending.
  const pendingMutationsRef = useRef(0)

  // Recent local edits (`rowId:columnId` → {value, at}); a sync-driven re-read
  // that shows a DIFFERENT value for one of these means a concurrent remote
  // write won LWW over the user's edit — flag it briefly. (ADR 0003 item 4)
  const recentEditsRef = useRef<Map<string, { value: any; at: number }>>(new Map())

  const flagConflicts = useCallback((parsedRows: TableRow[]) => {
    const now = Date.now()
    const recent = recentEditsRef.current
    if (recent.size === 0) return
    const hit: string[] = []
    for (const [key, edit] of recent) {
      if (now - edit.at > CONFLICT_WINDOW_MS) {
        recent.delete(key)
        continue
      }
      const sep = key.indexOf(':')
      const rowId = key.slice(0, sep)
      const colId = key.slice(sep + 1)
      const row = parsedRows.find(r => r._row_id === rowId)
      // Row gone (remote delete) also counts — the edit was overwritten.
      const current = row?.[colId]
      if (JSON.stringify(current) !== JSON.stringify(edit.value)) {
        hit.push(key)
        recent.delete(key) // flag once, not on every subsequent re-read
      }
    }
    if (hit.length > 0) {
      setConflictCells(prev => new Set([...prev, ...hit]))
      setTimeout(() => {
        setConflictCells(prev => {
          const next = new Set(prev)
          for (const key of hit) next.delete(key)
          return next
        })
      }, CONFLICT_FLASH_MS)
    }
  }, [])

  const fetchRows = useCallback(async (isInitial = true) => {
    if (!workspace) {
      setLoading(false)
      return
    }

    try {
      // Only show loading spinner on initial fetch, not on sync-triggered re-reads
      if (isInitial) setLoading(true)
      const rowsJson = workspace.getTableRows(tableId)
      const parsedRows = JSON.parse(rowsJson) as TableRow[]
      if (!isInitial) flagConflicts(parsedRows)
      setRows(parsedRows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (isInitial) setLoading(false)
    }
  }, [workspace, tableId, flagConflicts])

  // Fetch rows on mount and whenever workspace/tableId change
  useEffect(() => {
    fetchRows(true)
  }, [fetchRows])

  // Re-read rows when syncCount changes (remote changes already applied in WASM).
  // We track the previous value via a ref to avoid a redundant fetch on mount
  // (the mount effect above already handles that) while still catching every
  // transition, including the first 0 → 1 bump.
  //
  // Skip the re-read if there are pending local mutations — the optimistic
  // state is more recent and the mutation's own completion will refresh if needed.
  useEffect(() => {
    if (syncCount === undefined) return
    if (syncCount === prevSyncCountRef.current) return // no actual change (mount)
    prevSyncCountRef.current = syncCount
    if (pendingMutationsRef.current > 0) return // don't clobber optimistic state
    fetchRows(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncCount])

  const updateCell = useCallback(
    async (rowId: string, columnId: string, value: any) => {
      if (!workspace) {
        throw new Error('Workspace not initialized')
      }
      // A viewer's power level is below events_default, so the homeserver would
      // reject this write anyway. Refusing here keeps it out of the optimistic
      // path and the outbox, so nothing appears to save and then vanish.
      if (readOnly) {
        throw new Error(READ_ONLY_MESSAGE)
      }

      pendingMutationsRef.current++
      try {
        const valueJson = JSON.stringify(value)

        // Remember the edit so a concurrent remote overwrite can be flagged
        // when the next sync-driven re-read shows a different value.
        recentEditsRef.current.set(`${rowId}:${columnId}`, { value, at: Date.now() })

        // Optimistically update React state before the async write completes
        setRows(prev => prev.map(row =>
          row._row_id === rowId ? { ...row, [columnId]: value } : row
        ))

        // Apply to WASM + send to Matrix (may be async for ConnectedWorkspace)
        await workspace.updateCell(tableId, rowId, columnId, valueJson)

        // Signal sibling tabs that something changed (no data sent)
        if (workspaceId) {
          notifyWorkspaceChanged(workspaceId)
        }
      } catch (err) {
        // A failed *mutation* must not take over the whole view — that full-page
        // error state is reserved for load failures. Roll back the optimistic
        // change by re-reading from WASM, then re-throw so the caller can surface
        // a toast. (With the background send queue, transient errors like a 429
        // rate-limit never reach here: they're retried with backoff and the local
        // change simply stays until it syncs.)
        await fetchRows(false)
        throw err
      } finally {
        pendingMutationsRef.current--
      }
    },
    [workspace, tableId, workspaceId, fetchRows, readOnly]
  )

  const deleteRow = useCallback(
    async (rowId: string) => {
      if (!workspace) {
        throw new Error('Workspace not initialized')
      }
      if (readOnly) {
        throw new Error(READ_ONLY_MESSAGE)
      }

      pendingMutationsRef.current++
      try {
        // Optimistically remove the row from React state
        setRows(prev => prev.filter(row => row._row_id !== rowId))

        // Awaited: the connected workspace sends the tombstone to Matrix, so a
        // failed delete rejects here and is rolled back + surfaced as a toast.
        await workspace.deleteRow(tableId, rowId)

        // Signal sibling tabs that something changed (no data sent)
        if (workspaceId) {
          notifyWorkspaceChanged(workspaceId)
        }
      } catch (err) {
        // Roll back the optimistic removal and re-throw for a toast — a failed
        // delete shouldn't take over the view (see updateCell above).
        await fetchRows(false)
        throw err
      } finally {
        pendingMutationsRef.current--
      }
    },
    [workspace, tableId, workspaceId, fetchRows, readOnly]
  )

  return {
    rows,
    loading,
    error,
    updateCell,
    deleteRow,
    refresh: fetchRows,
    conflictCells,
    readOnly,
  }
}

/**
 * Hook for creating a ConnectedWorkspace backed by a Matrix room.
 *
 * This creates a ConnectedWorkspace from the MatrixSession and room ID,
 * starts the sync loop, and provides an onChange counter that increments
 * whenever remote changes arrive. Components using `useTable` will
 * automatically re-fetch rows when this happens.
 *
 * Cross-tab sync is handled via two complementary mechanisms:
 *
 * 1. **BroadcastChannel** (primary): When any tab mutates data or receives
 *    a Matrix sync event, it posts a data-free signal on a per-workspace
 *    BroadcastChannel.  Sibling tabs re-read from their own WASM workspace
 *    (kept current by the Matrix sync stream).  No plaintext content is
 *    ever sent over the channel — only a "something changed" ping.
 *
 * 2. **Visibility change** (fallback): If BroadcastChannel is unavailable
 *    or an event is missed, the workspace is refreshed when the tab
 *    regains focus after being hidden.
 */
export function useWorkspace(workspaceId: string, matrixSession?: any) {
  const [workspace, setWorkspace] = useState<WorkspaceHandle | null>(null)
  // Start loading only when matrixSession is already available; otherwise
  // we'll transition to loading once it becomes available.
  const [loading, setLoading] = useState(!!matrixSession)
  const [error, setError] = useState<Error | null>(null)
  const [syncCount, setSyncCount] = useState(0)
  const workspaceRef = useRef<WorkspaceHandle | null>(null)

  // Track whether the workspace needs to be refreshed on tab focus
  const needsRefreshRef = useRef(false)

  // Guard against triggering a refresh while one is already in progress
  const refreshingRef = useRef(false)

  // ── Create / recreate the ConnectedWorkspace ───────────────────
  //
  // When `initialSync()` was skipped (timed out because another tab holds
  // the sync stream), the Matrix SDK cache may be empty and
  // `ConnectedWorkspace.create()` will throw "Room not found".  We retry
  // a few times with exponential back-off to give the background sync
  // time to populate the cache.
  const initWorkspace = useCallback(async (isRefresh = false) => {
    if (isRefresh && refreshingRef.current) return
    refreshingRef.current = isRefresh

    try {
      const wasmModule = await getWasmModule()

      if (!matrixSession) {
        // matrixSession is null — either still restoring or not signed in.
        // Don't error yet; the effect will re-run when matrixSession changes.
        // Make sure loading is false so the UI doesn't show a spinner
        // while we're just waiting for the session.
        console.log('[workspace] Waiting for Matrix session (matrixSession is null)')
        setLoading(false)
        return
      }

      // matrixSession is available — start the actual workspace init.
      console.log('[workspace] matrixSession available, initializing workspace', workspaceId)
      setLoading(true)

      // Matrix-connected workspace (async factory — loads room history)
      if (!isRefresh) {
        console.log('Creating connected workspace for room:', workspaceId)
      }

      // Incremental cold start (issue 6f092cf4): load the persisted snapshot so
      // create() fills from local state and only fetches events newer than its
      // marker, instead of re-paginating the entire room history. Best-effort —
      // a missing/invalid snapshot just means a full gather.
      const snapshotJson = await loadSnapshot(workspaceId, getSnapshotKey() ?? undefined)

      // Retry loop — handles the case where the SDK room cache is not yet
      // populated (initialSync still running in the background).
      const MAX_RETRIES = 6
      const BASE_DELAY_MS = 1_000
      let lastErr: unknown
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const cws = await wasmModule.ConnectedWorkspace.create(
            matrixSession,
            workspaceId,
            snapshotJson,
          )

          // Note on read-only legacy rooms: enforcement lives in the bridge
          // send path, which fails closed for unencrypted rooms at SEND time
          // (when encryption state is reliably known). We deliberately do NOT
          // gate on isEncrypted() here — right after create() a freshly made
          // encrypted room can transiently report false (encryption state
          // Unknown, not yet synced), so a create-time block would wrongly
          // reject edits during that window. The ReadOnlyBanner surfaces the
          // state to the user (and re-checks as sync settles).

          // Start the sync loop with a change callback
          cws.startSync(() => {
            console.log('[sync] Remote change detected, triggering refresh')
            setSyncCount(c => c + 1)
            needsRefreshRef.current = false

            // Notify sibling tabs about the change we just received
            notifyWorkspaceChanged(workspaceId)
          })

          // Replay any persisted outbox BEFORE the user can edit (ADR 0003
          // phase 1): unsent writes from a previous tab re-apply under LWW —
          // a since-superseded write loses fairly (it carries its original
          // HLC timestamp) — and re-enter the send queue. The stored record
          // is cleared; the mirror effect below re-saves anything still
          // unsent on its next tick.
          try {
            if (typeof cws.restorePendingUpdates === 'function') {
              const saved = await loadOutbox(workspaceId, getSnapshotKey() ?? undefined)
              if (saved) {
                const replayed = cws.restorePendingUpdates(saved)
                if (replayed > 0) {
                  console.log(`[outbox] replayed ${replayed} unsent write(s) from a previous session`)
                }
              }
              void clearOutbox(workspaceId)
            }
          } catch (e) {
            console.warn('[outbox] replay failed:', e)
          }

          workspaceRef.current = cws
          setWorkspace(cws)
          setLoading(false)

          // Persist the freshly-gathered state immediately so a quick reload
          // already benefits from the snapshot (the periodic effect below keeps
          // it current thereafter). Fire-and-forget.
          try {
            const snap = cws.snapshot()
            if (snap) void saveSnapshot(workspaceId, snap, getSnapshotKey() ?? undefined)
          } catch {
            /* best-effort */
          }

          if (!isRefresh) {
            console.log('Connected workspace initialized with sync')
          }
          return // success — exit the retry loop
        } catch (err) {
          lastErr = err
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('Room not found') && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt) // 1s, 2s, 4s, 8s, 16s, 32s
            console.log(
              `[workspace] Room not in SDK cache yet, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
            )
            await new Promise(resolve => setTimeout(resolve, delay))
            continue
          }
          throw err // non-retryable error or retries exhausted
        }
      }

      // Should not reach here, but just in case
      throw lastErr
    } catch (err) {
      console.error('Failed to initialize workspace:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
      setLoading(false)
    } finally {
      refreshingRef.current = false
    }
  }, [workspaceId, matrixSession])

  // ── Initial creation ───────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    needsRefreshRef.current = false

    ;(async () => {
      await initWorkspace()
      if (!mounted) return
    })()

    return () => {
      mounted = false
    }
  }, [initWorkspace])

  // ── BroadcastChannel listener ──────────────────────────────────
  // Listen for change signals from sibling tabs.  The broadcast
  // carries NO data (security: plaintext must not leave the tab
  // that decrypted it).  We simply bump syncCount so all consumers
  // re-read from the local WASM workspace, which the Matrix sync
  // stream keeps up-to-date.
  useEffect(() => {
    if (!matrixSession) return

    const ch = getWorkspaceChannel(workspaceId)
    if (!ch) return

    ch.onmessage = (event) => {
      if (event.data?.type !== 'workspace-changed' || !workspaceRef.current) return
      console.log('[broadcast] Change signal from sibling tab, triggering re-read')
      setSyncCount(c => c + 1)
    }

    return () => ch.close()
  }, [workspaceId, matrixSession])

  // ── Visibility-based refresh (fallback) ────────────────────────
  // When the tab goes hidden, mark it as needing a refresh.
  // When it becomes visible again, bump syncCount to trigger
  // a re-read from the WASM workspace (which startSync keeps
  // up-to-date via the Matrix sync stream).
  useEffect(() => {
    if (!matrixSession) return

    function handleVisibility() {
      if (document.hidden) {
        // Tab is being hidden — mark for refresh when it comes back
        needsRefreshRef.current = true
      } else if (needsRefreshRef.current && workspaceRef.current) {
        // Tab regained focus — re-read from WASM to pick up any
        // changes that arrived while the tab was hidden.
        console.log('[visibility] Tab regained focus, triggering re-read')
        needsRefreshRef.current = false
        setSyncCount(c => c + 1)
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [matrixSession])

  // ── Persist a workspace snapshot for incremental cold start ────
  // Keeps the local snapshot reasonably current so the next reload skips
  // re-paginating full history. Correctness does NOT depend on freshness — the
  // marker-bounded gather fills any gap — so saving is best-effort: a debounced
  // save after each sync-driven change, a periodic tick (catches same-tab local
  // writes, which don't bump syncCount), and one when the tab is hidden.
  useEffect(() => {
    if (!workspace || typeof workspace.snapshot !== 'function') return
    let cancelled = false
    const persist = () => {
      if (cancelled || !workspace.snapshot) return
      try {
        const snap = workspace.snapshot()
        if (snap) void saveSnapshot(workspaceId, snap, getSnapshotKey() ?? undefined)
      } catch {
        /* best-effort */
      }
    }
    const debounce = setTimeout(persist, 2_000)
    const interval = setInterval(persist, 30_000)
    const onHide = () => {
      if (document.hidden) persist()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      cancelled = true
      clearTimeout(debounce)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [workspace, workspaceId])

  // ── Mirror the pending send queue to the persistent outbox (ADR 0003) ──
  // A short interval (unsent writes matter within seconds, unlike snapshot
  // freshness) plus pagehide/hidden hooks — the moments a tab is about to
  // vanish are exactly when the mirror matters most. Writes are skipped when
  // the queue hasn't changed, so the idle steady state costs nothing.
  useEffect(() => {
    if (!workspace || typeof workspace.pendingUpdates !== 'function') return
    let cancelled = false
    let lastMirrored: string | null = null
    const mirror = () => {
      if (cancelled || !workspace.pendingUpdates) return
      try {
        const json = workspace.pendingUpdates()
        if (json === lastMirrored) return
        lastMirrored = json
        void saveOutbox(workspaceId, json, getSnapshotKey() ?? undefined)
      } catch {
        /* best-effort: the in-memory queue still retries while the tab lives */
      }
    }
    const interval = setInterval(mirror, 3_000)
    const onHide = () => {
      if (document.hidden) mirror()
    }
    // Event-driven mirror (issue 980ac596): the bridge calls back the moment
    // the queue changes, so the outbox is written while the page is alive.
    // pagehide alone is not enough — an async IndexedDB write started during
    // unload can be aborted, silently losing the only durable copy of an
    // unsent operation.
    if (typeof (workspace as any).onQueueChanged === 'function') {
      (workspace as any).onQueueChanged(mirror)
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', mirror)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', mirror)
    }
  }, [workspace, syncCount, workspaceId])

  return { workspace, loading, error, syncCount }
}
