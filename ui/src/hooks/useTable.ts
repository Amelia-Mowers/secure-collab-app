import { useState, useEffect, useCallback, useRef } from 'react'

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
 */
export function useTable(
  workspace: WorkspaceHandle | null,
  tableId: string
): UseTableResult {
  const [rows, setRows] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchRows = useCallback(async () => {
    if (!workspace) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      const rowsJson = workspace.getTableRows(tableId)
      const parsedRows = JSON.parse(rowsJson) as TableRow[]
      setRows(parsedRows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [workspace, tableId])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  const updateCell = useCallback(
    async (rowId: string, columnId: string, value: any) => {
      if (!workspace) {
        throw new Error('Workspace not initialized')
      }

      try {
        const valueJson = JSON.stringify(value)
        // updateCell may be async (ConnectedWorkspace) or sync (WasmWorkspace)
        await workspace.updateCell(tableId, rowId, columnId, valueJson)

        // Refresh to show the update
        await fetchRows()
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    },
    [workspace, tableId, fetchRows]
  )

  const deleteRow = useCallback(
    async (rowId: string) => {
      if (!workspace) {
        throw new Error('Workspace not initialized')
      }

      try {
        workspace.deleteRow(tableId, rowId)
        await fetchRows()
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    },
    [workspace, tableId, fetchRows]
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
 */
export function useWorkspace(workspaceId: string, matrixSession?: any) {
  const [workspace, setWorkspace] = useState<WorkspaceHandle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [syncCount, setSyncCount] = useState(0)
  const workspaceRef = useRef<WorkspaceHandle | null>(null)

  useEffect(() => {
    let mounted = true

    async function initWorkspace() {
      try {
        console.log('Loading WASM module...')

        const wasmModule = await import('../wasm/app_core.js')

        console.log('Initializing WASM binary...')
        await wasmModule.default()

        console.log('Setting up panic hook...')
        wasmModule.init_panic_hook()

        if (matrixSession) {
          // Matrix-connected workspace
          console.log('Creating connected workspace for room:', workspaceId)
          const cws = new wasmModule.ConnectedWorkspace(matrixSession, workspaceId)

          // Start the sync loop with a change callback
          cws.startSync(() => {
            if (mounted) {
              console.log('[sync] Remote change detected, triggering refresh')
              setSyncCount(c => c + 1)
            }
          })

          if (mounted) {
            workspaceRef.current = cws
            setWorkspace(cws)
            setLoading(false)
            console.log('Connected workspace initialized with sync')
          }
        } else {
          // Local-only workspace (fallback when no MatrixSession)
          console.log('Creating local workspace:', workspaceId)
          const wasmWorkspace = new wasmModule.WasmWorkspace(workspaceId)

          if (mounted) {
            workspaceRef.current = wasmWorkspace
            setWorkspace(wasmWorkspace)
            setLoading(false)
            console.log('Local workspace initialized')
          }
        }
      } catch (err) {
        console.error('Failed to initialize workspace:', err)
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setLoading(false)
        }
      }
    }

    initWorkspace()

    return () => {
      mounted = false
    }
  }, [workspaceId, matrixSession])

  return { workspace, loading, error, syncCount }
}
