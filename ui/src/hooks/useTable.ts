import { useState, useEffect, useCallback, useRef } from 'react'
import { getWasmModule } from '../wasm/loader'

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
  updateCell(tableId: string, rowId: string, columnId: string, value: string): void | Promise<void>
  applyUpdate(update: string): void
  getTableRows(tableId: string): string
  getTableSchema(tableId: string): string
  getView(viewId: string): string
  listTables(): string
  listViewsForTable(tableId: string): string
  deleteRow(tableId: string, rowId: string): void
  // ConnectedWorkspace-only methods (optional)
  startSync?(onChange: () => void): void
  inviteUser?(userId: string): Promise<void>
  listMembers?(): Promise<string>
}

interface TableRow {
  _row_id: string
  [key: string]: any
}

interface UseTableResult {
  rows: TableRow[]
  loading: boolean
  error: Error | null
  updateCell: (rowId: string, columnId: string, value: any) => Promise<void>
  deleteRow: (rowId: string) => Promise<void>
  refresh: () => Promise<void>
}

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
  const prevSyncCountRef = useRef(syncCount)

  // Track in-flight mutations so sync-triggered re-reads don't clobber
  // optimistic state while a write is still pending.
  const pendingMutationsRef = useRef(0)

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
      setRows(parsedRows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (isInitial) setLoading(false)
    }
  }, [workspace, tableId])

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

      pendingMutationsRef.current++
      try {
        const valueJson = JSON.stringify(value)

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
    [workspace, tableId, workspaceId, fetchRows]
  )

  const deleteRow = useCallback(
    async (rowId: string) => {
      if (!workspace) {
        throw new Error('Workspace not initialized')
      }

      pendingMutationsRef.current++
      try {
        // Optimistically remove the row from React state
        setRows(prev => prev.filter(row => row._row_id !== rowId))

        workspace.deleteRow(tableId, rowId)

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
    [workspace, tableId, workspaceId, fetchRows]
  )

  return {
    rows,
    loading,
    error,
    updateCell,
    deleteRow,
    refresh: fetchRows,
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

      // Retry loop — handles the case where the SDK room cache is not yet
      // populated (initialSync still running in the background).
      const MAX_RETRIES = 6
      const BASE_DELAY_MS = 1_000
      let lastErr: unknown
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const cws = await wasmModule.ConnectedWorkspace.create(matrixSession, workspaceId)

          // Start the sync loop with a change callback
          cws.startSync(() => {
            console.log('[sync] Remote change detected, triggering refresh')
            setSyncCount(c => c + 1)
            needsRefreshRef.current = false

            // Notify sibling tabs about the change we just received
            notifyWorkspaceChanged(workspaceId)
          })

          workspaceRef.current = cws
          setWorkspace(cws)
          setLoading(false)
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

  return { workspace, loading, error, syncCount }
}
