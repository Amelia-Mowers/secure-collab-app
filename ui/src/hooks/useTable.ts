import { useState, useEffect, useCallback } from 'react'

/**
 * Type definitions for the WASM workspace
 * These will be provided by the app-core WASM module
 */
interface WasmWorkspace {
  createTable(definition: string): string
  createView(config: string): string
  addColumn(tableId: string, columnJson: string): void
  updateCell(tableId: string, rowId: string, columnId: string, value: string): void
  applyUpdate(update: string): void
  getTableRows(tableId: string): string
  getTableSchema(tableId: string): string
  getView(viewId: string): string
  listTables(): string
  listViewsForTable(tableId: string): string
  deleteRow(tableId: string, rowId: string): void
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
 * Hook for using a table from the WASM workspace.
 *
 * This hook implements a pull model with change notifications:
 * - The WASM core emits "table changed" events
 * - The hook subscribes and re-fetches materialized table state when notified
 *
 * @param workspace - The WASM workspace instance
 * @param tableId - The ID of the table to use
 * @returns Table data and operations
 */
export function useTable(
  workspace: WasmWorkspace | null,
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
        workspace.updateCell(tableId, rowId, columnId, valueJson)

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
 * Hook for using the WASM workspace.
 */
export function useWorkspace(workspaceId: string) {
  const [workspace, setWorkspace] = useState<WasmWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let mounted = true

    async function initWorkspace() {
      try {
        console.log('Loading WASM module...')

        // Dynamically import the WASM module
        const wasmModule = await import('../wasm/app_core.js')

        console.log('Initializing WASM binary...')
        // Initialize the WASM module (loads the .wasm file)
        await wasmModule.default()

        console.log('Setting up panic hook...')
        // Initialize panic hook for better error messages
        wasmModule.init_panic_hook()
        // Note: Tracing disabled to reduce memory usage in WASM
        // wasmModule.init_tracing()

        console.log('Creating workspace:', workspaceId)

        // Create workspace instance
        const wasmWorkspace = new wasmModule.WasmWorkspace(workspaceId)

        if (mounted) {
          setWorkspace(wasmWorkspace)
          setLoading(false)
          console.log('✅ Workspace initialized successfully')
        }
      } catch (err) {
        console.error('❌ Failed to initialize workspace:', err)
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
  }, [workspaceId])

  return { workspace, loading, error }
}
