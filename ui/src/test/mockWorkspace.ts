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
  order?: number
}

export interface TableDef {
  id: string
  name: string
  description?: string
  columns: Record<string, ColumnDef>
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

  // ── Table operations ──────────────────────────────────────────────────────

  createTable(definitionJson: string): string {
    const def: TableDef = JSON.parse(definitionJson)
    this.schemas.set(def.id, def)
    this.cellStore.set(def.id, new Map())
    return JSON.stringify({ success: true })
  }

  listTables(): string {
    return JSON.stringify(Array.from(this.cellStore.keys()))
  }

  getTableSchema(tableId: string): string {
    const schema = this.schemas.get(tableId)
    if (!schema) throw new Error('Table not found')
    return JSON.stringify(schema)
  }

  getTableRows(tableId: string): string {
    const table = this.cellStore.get(tableId)
    if (!table) throw new Error('Table not found')
    const rows: Record<string, any>[] = []
    for (const [rowId, cols] of table) {
      const row: Record<string, any> = { _row_id: rowId }
      for (const [colId, val] of cols) {
        row[colId] = val
      }
      rows.push(row)
    }
    return JSON.stringify(rows)
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
