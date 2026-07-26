/**
 * Pure-TypeScript workspace that mirrors the WasmWorkspace interface.
 *
 * Used in tests so that no WASM binary is required.  The behaviour is kept
 * intentionally close to the Rust implementation (LWW semantics aside –
 * later writes simply overwrite earlier ones since tests are single-threaded).
 */

export type ColumnType =
  | 'text' | 'number' | 'boolean' | 'date'
  | 'select' | 'multiselect' | 'reference' | 'document' | 'json'

export interface ColumnDef {
  id: string
  name: string
  column_type: ColumnType
  required: boolean
  options?: string[]
  reference_table?: string
  reference_display_column?: string
  /** Persisted display width (column metadata, shared with collaborators). */
  width?: number
  order?: number
  deleted?: boolean
}

export interface TableDef {
  id: string
  name: string
  description?: string
  columns: Record<string, ColumnDef>
  deleted_columns?: string[]
}

export interface ViewConfig {
  id: string
  name: string
  table_id: string
  view_type: 'table' | 'kanban' | 'card' | 'calendar' | 'tasklist' | 'custom'
  sort: any[]
  filters: any[]
  kanban_config?: {
    group_by_column: string
    title_column: string
    display_columns: string[]
    column_options: string[]
  }
  calendar_config?: any
  tasklist_config?: any
}

type CellStore = Map<string, Map<string, Map<string, any>>>
// cellStore: tableId → rowId → columnId → value

export class MockWorkspace {
  private cellStore: CellStore = new Map()
  private schemas: Map<string, TableDef> = new Map()
  private views: Map<string, ViewConfig> = new Map()
  private deletedTables: Set<string> = new Set()
  private tableOrder: Map<string, string> = new Map()

  // ── Table operations ──────────────────────────────────────────────────────

  createTable(definitionJson: string): string {
    const def: TableDef = JSON.parse(definitionJson)
    if ((this.schemas.has(def.id) || this.cellStore.has(def.id)) && !this.deletedTables.has(def.id)) {
      throw new Error('A table with that name already exists')
    }
    this.deletedTables.delete(def.id) // re-creating a deleted id clears the tombstone
    this.schemas.set(def.id, def)
    this.cellStore.set(def.id, new Map())
    return JSON.stringify({ success: true })
  }

  listTables(): string {
    const ids = Array.from(this.cellStore.keys()).filter(id => !this.deletedTables.has(id))
    ids.sort((a, b) => {
      const ka = this.tableOrder.get(a) ?? null
      const kb = this.tableOrder.get(b) ?? null
      if (ka != null && kb != null) return ka < kb ? -1 : ka > kb ? 1 : a.localeCompare(b)
      if (ka != null) return -1
      if (kb != null) return 1
      return a.localeCompare(b)
    })
    return JSON.stringify(ids)
  }

  /** Persist a column's display width (column metadata). */
  setColumnWidth(tableId: string, columnId: string, width: number): void {
    const schema = this.schemas.get(tableId)
    const col = schema?.columns?.[columnId]
    if (col) col.width = width
  }

  /** Rename in place: the table keeps its id, columns, rows, and views. */
  renameTable(tableId: string, name: string): void {
    const schema = this.schemas.get(tableId)
    if (schema) this.schemas.set(tableId, { ...schema, name })
  }

  /** Delete a view. The table it projects is untouched. */
  deleteView(viewId: string): void {
    this.views.delete(viewId)
  }

  /** Tombstone a table (decay model): hidden from listTables / getTableSchema. */
  deleteTable(tableId: string): void {
    this.deletedTables.add(tableId)
  }

  /** Set a table's manual-ordering key (fractional index). */
  setTableOrder(tableId: string, orderKey: string): void {
    this.tableOrder.set(tableId, orderKey)
  }

  getTableOrderKeys(): string {
    const map: Record<string, string> = {}
    for (const [id, key] of this.tableOrder) {
      if (!this.deletedTables.has(id)) map[id] = key
    }
    return JSON.stringify(map)
  }

  getTableSchema(tableId: string): string {
    if (this.deletedTables.has(tableId)) throw new Error('Table not found')
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    // Exclude deleted columns from `columns` and report them in
    // `deleted_columns`, mirroring the Rust SchemaManager (decay model).
    const columns: Record<string, ColumnDef> = {}
    const deleted_columns: string[] = []
    for (const [id, col] of Object.entries(schema.columns)) {
      if (col.deleted) deleted_columns.push(id)
      else columns[id] = col
    }
    return JSON.stringify({ ...schema, columns, deleted_columns })
  }

  getTableRows(tableId: string): string {
    const table = this.cellStore.get(tableId)
    if (!table) throw new Error('Table not found')
    // Mirror the Rust core: reserved fields (_order/_deleted) are control
    // metadata, and rows materialize sorted by the _order key (keyed rows first,
    // then unkeyed by id).
    const built: Array<{ row: Record<string, any>; key: string | null }> = []
    for (const [rowId, cols] of table) {
      const row: Record<string, any> = { _row_id: rowId }
      let key: string | null = null
      for (const [colId, val] of cols) {
        if (colId === '_order') { if (typeof val === 'string') key = val; continue }
        if (colId === '_deleted') continue
        row[colId] = val
      }
      built.push({ row, key })
    }
    built.sort((a, b) => {
      if (a.key != null && b.key != null) {
        return a.key < b.key ? -1 : a.key > b.key ? 1 : a.row._row_id.localeCompare(b.row._row_id)
      }
      if (a.key != null) return -1
      if (b.key != null) return 1
      return a.row._row_id.localeCompare(b.row._row_id)
    })
    return JSON.stringify(built.map(b => b.row))
  }

  getRowOrderKeys(tableId: string): string {
    const table = this.cellStore.get(tableId)
    if (!table) throw new Error('Table not found')
    const map: Record<string, string> = {}
    for (const [rowId, cols] of table) {
      const v = cols.get('_order')
      if (typeof v === 'string') map[rowId] = v
    }
    return JSON.stringify(map)
  }

  deleteRow(tableId: string, rowId: string): void {
    const table = this.cellStore.get(tableId)
    if (!table) throw new Error('Table not found')
    table.delete(rowId)
  }

  // ── Column operations ─────────────────────────────────────────────────────

  addColumn(tableId: string, columnJson: string): void {
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    const col: ColumnDef = JSON.parse(columnJson)
    schema.columns[col.id] = col
  }

  reorderColumns(tableId: string, orderedIdsJson: string): void {
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    const ordered: string[] = JSON.parse(orderedIdsJson)
    ordered.forEach((colId, idx) => {
      const col = schema.columns[colId]
      if (col) col.order = idx
    })
  }

  updateColumn(tableId: string, columnId: string, patchJson: string): void {
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    const col = schema.columns[columnId]
    if (!col) return
    const patch = JSON.parse(patchJson) as Partial<ColumnDef>
    if (patch.name !== undefined) col.name = patch.name
    if (patch.column_type !== undefined) col.column_type = patch.column_type
    if (patch.options !== undefined) col.options = patch.options
  }

  deleteColumn(tableId: string, columnId: string): void {
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    const col = schema.columns[columnId]
    if (col) col.deleted = true
  }

  // ── Cell operations ───────────────────────────────────────────────────────

  updateCell(
    tableId: string,
    rowId: string,
    columnId: string,
    valueJson: string,
  ): void {
    const table = this.cellStore.get(tableId)
    if (!table) throw new Error('Table not found')
    const value = JSON.parse(valueJson)
    if (!table.has(rowId)) table.set(rowId, new Map())
    table.get(rowId)!.set(columnId, value)
  }

  applyUpdate(updateJson: string): void {
    const update = JSON.parse(updateJson)
    const { table_id, row_id, column_id, value } = update
    if (!this.cellStore.has(table_id)) {
      this.cellStore.set(table_id, new Map())
    }
    const table = this.cellStore.get(table_id)!
    if (!table.has(row_id)) table.set(row_id, new Map())
    table.get(row_id)!.set(column_id, value)
  }

  // ── View operations ───────────────────────────────────────────────────────

  // Must mirror app-core's `ViewType` enum (views.rs): the real bridge rejects
  // unknown view types ("Invalid view config"), and the mock has to match or
  // unit tests pass for view types the WASM core doesn't accept — this drift
  // hid the missing `card` variant (caught by e2e/core.spec.ts).
  private static readonly VIEW_TYPES = ['table', 'kanban', 'card', 'calendar', 'tasklist', 'custom']

  createView(configJson: string): string {
    const config: ViewConfig = JSON.parse(configJson)
    if (!MockWorkspace.VIEW_TYPES.includes(config.view_type)) {
      throw new Error('Invalid view config')
    }
    if (!this.cellStore.has(config.table_id)) {
      throw new Error('Table not found')
    }
    this.views.set(config.id, config)
    return JSON.stringify({ success: true })
  }

  /** Test seam: store a view as if it arrived via sync — the read path keeps
   *  whatever materializes from the timeline (e.g. a view type from a newer
   *  client), even though local createView would reject it. */
  seedView(config: Omit<ViewConfig, 'view_type'> & { view_type: string }): void {
    this.views.set(config.id, config as ViewConfig)
  }

  getView(viewId: string): string {
    const view = this.views.get(viewId)
    if (!view) throw new Error('View not found')
    return JSON.stringify(view)
  }

  listViewsForTable(tableId: string): string {
    const ids: string[] = []
    for (const [id, view] of this.views) {
      if (view.table_id === tableId) ids.push(id)
    }
    return JSON.stringify(ids)
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  /** Directly read a cell value (bypasses JSON serialisation round-trip). */
  _getCellValue(tableId: string, rowId: string, columnId: string): any {
    return this.cellStore.get(tableId)?.get(rowId)?.get(columnId)
  }

  /** Return the raw row count for a table. */
  _rowCount(tableId: string): number {
    return this.cellStore.get(tableId)?.size ?? 0
  }

  /** Return the raw view count across all tables. */
  _viewCount(): number {
    return this.views.size
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Create a workspace with a simple tasks table pre-populated. */
export function makeTasksWorkspace(): MockWorkspace {
  const ws = new MockWorkspace()
  ws.createTable(JSON.stringify({
    id: 'tasks',
    name: 'Tasks',
    columns: {
      title:    { id: 'title',    name: 'Title',    column_type: 'text',    required: true  },
      status:   { id: 'status',   name: 'Status',   column_type: 'select',  required: false,
                  options: ['Todo', 'In Progress', 'Done'] },
      assignee: { id: 'assignee', name: 'Assignee', column_type: 'text',    required: false },
      due_date: { id: 'due_date', name: 'Due Date', column_type: 'date',    required: false },
      priority: { id: 'priority', name: 'Priority', column_type: 'number',  required: false },
      done:     { id: 'done',     name: 'Done',     column_type: 'boolean', required: false },
      notes:    { id: 'notes',    name: 'Notes',    column_type: 'document',required: false },
    },
  }))
  return ws
}

/** Seed the tasks table with a few realistic rows. */
export function seedTasks(ws: MockWorkspace): void {
  const rows = [
    { id: 'task-1', title: 'Design homepage',  status: 'Done',        assignee: 'Alice', due_date: '2026-01-15', priority: 1, done: true  },
    { id: 'task-2', title: 'Set up CI/CD',     status: 'In Progress', assignee: 'Bob',   due_date: '2026-02-01', priority: 2, done: false },
    { id: 'task-3', title: 'Write unit tests', status: 'Todo',        assignee: 'Alice', due_date: '2026-02-10', priority: 3, done: false },
    { id: 'task-4', title: 'Deploy to staging',status: 'Todo',        assignee: 'Charlie', due_date: '2026-03-01', priority: 4, done: false },
  ]
  for (const row of rows) {
    const { id, ...cells } = row
    for (const [col, val] of Object.entries(cells)) {
      ws.updateCell('tasks', id, col, JSON.stringify(val))
    }
  }
}

/** Create a workspace with a kanban view for the tasks table. */
export function makeKanbanWorkspace(): MockWorkspace {
  const ws = makeTasksWorkspace()
  seedTasks(ws)
  ws.createView(JSON.stringify({
    id: 'tasks-kanban',
    name: 'Task Board',
    table_id: 'tasks',
    view_type: 'kanban',
    sort: [],
    filters: [],
    kanban_config: {
      group_by_column: 'status',
      title_column: 'title',
      display_columns: ['assignee'],
      column_options: ['Todo', 'In Progress', 'Done'],
    },
  }))
  return ws
}
