import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { computeReorderWrites, type OrderRow } from '@/fractionalIndex'
import { useTable, useMembers, notifyWorkspaceChanged } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon, PlusIcon } from '@/components/Toolbar'
import { HistoryDrawer } from '@/views/history/HistoryDrawer'
import { AddColumnModal, type NewColumnDef, type EditColumnInitial } from '@/components/AddColumnModal'
import { CellDisplay, CellEditor, type CellColumn } from '@/cells/cellRegistry'
import { FilterBar } from './FilterBar'
import { applyFilters, type FilterCondition } from '@/lib/filters'
import './TableView.css'

interface TableViewProps {
  workspace: any
  syncCount?: number
}

interface ColumnMeta {
  id: string
  name: string
  column_type: string
  options?: string[]
  order?: number | null
}

interface TableRow {
  _row_id: string
  [key: string]: any
}

const ROW_HEIGHT = 40

/**
 * Global filter that searches every column's value as text — including select
 * options and multi-select arrays.
 *
 * TanStack's built-in `includesString` is paired with a default
 * `getColumnCanGlobalFilter` that samples only the *first row's* value and
 * excludes a column from global search when that value isn't a string/number.
 * An empty select cell in the first row therefore made the whole column
 * unsearchable — which is why filtering by a selection option didn't work. We
 * force every column filterable (see the table config) and match here against a
 * string form of any value type.
 */
function globalTextFilter(row: any, columnId: string, filterValue: string): boolean {
  const v = row.getValue(columnId)
  if (v == null || v === '') return false
  const hay = Array.isArray(v)
    ? v.join(' ')
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v)
  return hay.toLowerCase().includes(String(filterValue).toLowerCase())
}

/** Map a view's persisted FilterConfig[] / SortConfig[] into the table's
 *  ephemeral filter conditions + TanStack sorting state (the inverse of what
 *  `buildViewPayload` writes). Shared by the load-view effect and Reset. */
function mapViewFilters(cfg: any): { conditions: FilterCondition[]; sorting: SortingState } {
  return {
    conditions: (cfg?.filters ?? []).map((f: any) => ({
      columnId: f.column_id,
      operator: f.operator,
      value: f.value ?? undefined,
    })),
    sorting: (cfg?.sort ?? []).map((s: any) => ({
      id: s.column_id,
      desc: s.direction === 'descending',
    })),
  }
}

/** A draggable, sortable column header with a ⋯ menu (edit / delete). A small
 *  drag distance is required to start a reorder (see the PointerSensor), so a
 *  plain click still toggles the TanStack sort; the ⋯ trigger sits at the right
 *  edge so it never intercepts that click. Full column editing (rename, type,
 *  options, default) happens in the Edit-column modal opened via `onEdit`. */
function SortableHeader({
  id,
  label,
  sorted,
  onSort,
  onEdit,
  onDelete,
}: {
  id: string
  label: string
  sorted: false | 'asc' | 'desc'
  onSort: ((event: unknown) => void) | undefined
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the ⋯ menu on any click outside it. A document listener is robust to
  // z-index/stacking (a fixed backdrop could sit under the sticky header row),
  // so "click off to dismiss" works anywhere on the page.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'grab',
  }

  return (
    <th
      ref={setNodeRef}
      style={style}
      className="col-sortable"
      title="Drag to reorder · click to sort"
      {...attributes}
      {...listeners}
      onClick={onSort}
    >
      <span className="col-name">{label}</span>
      <span className="col-sort-indicator">
        {sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
      </span>
      <div
        className="col-menu"
        ref={menuRef}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <button
          className="col-menu-btn ghost"
          title="Column options"
          aria-label="Column options"
          onClick={() => setMenuOpen(o => !o)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="col-menu__dropdown" role="menu">
            <button
              className="col-menu__item"
              onClick={() => { setMenuOpen(false); onEdit() }}
            >
              Edit column…
            </button>
            <button
              className="col-menu__item col-menu__delete"
              onClick={() => { setMenuOpen(false); onDelete() }}
            >
              Delete column
            </button>
          </div>
        )}
      </div>
    </th>
  )
}

/** A table body row that can be dragged to reorder (when `reorderable`). The
 *  leading cell holds two *distinct* controls: a dedicated grip drag-handle
 *  (carries the dnd-kit listeners) and a separate open-full-entry button. The
 *  data/action cells are passed as `children`. */
function SortableTableRow({
  rowId,
  reorderable,
  onOpen,
  children,
}: {
  rowId: string
  reorderable: boolean
  onOpen: () => void
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowId,
    disabled: !reorderable,
  })
  const style: React.CSSProperties = {
    height: ROW_HEIGHT,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <tr ref={setNodeRef} style={style} className={isDragging ? 'row-dragging' : undefined}>
      <td className="cell-open">
        <div className="cell-open-inner">
          {reorderable && (
            <button
              type="button"
              className="ghost cell-drag-handle"
              title="Drag to reorder"
              aria-label="Drag to reorder"
              {...attributes}
              {...listeners}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
                <circle cx="4.5" cy="2.5" r="1.1" />
                <circle cx="8.5" cy="2.5" r="1.1" />
                <circle cx="4.5" cy="6.5" r="1.1" />
                <circle cx="8.5" cy="6.5" r="1.1" />
                <circle cx="4.5" cy="10.5" r="1.1" />
                <circle cx="8.5" cy="10.5" r="1.1" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="ghost cell-open-btn"
            onClick={onOpen}
            title="Open full entry"
            aria-label="Open full entry"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 2h4M2 2v4M2 2l4.5 4.5" />
              <path d="M11 11H7M11 11V7M11 11L6.5 6.5" />
            </svg>
          </button>
        </div>
      </td>
      {children}
    </tr>
  )
}

const HistoryIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M2 6.5a4.6 4.6 0 1 0 1.5-3.4" />
    <polyline points="1.4,1.6 1.4,4 3.8,4" />
    <polyline points="6.5,4 6.5,6.6 8.5,7.8" />
  </svg>
)

export function TableView({ workspace, syncCount }: TableViewProps) {
  const { workspaceId, tableId, viewId } = useParams<{
    workspaceId: string
    tableId: string
    viewId: string
  }>()
  const navigate = useNavigate()
  const location = useLocation()

  // Navigate to an entry, recording the view we came from so the entry's "back"
  // returns here (a kanban/card view records itself the same way). See EntryView.
  const openEntry = (rowId: string) =>
    navigate(`/workspace/${workspaceId}/table/${tableId}/entry/${rowId}`, {
      state: { from: location.pathname },
    })
  const newEntry = () =>
    navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`, {
      state: { from: location.pathname },
    })
  const { rows, loading, error, updateCell, deleteRow, refresh, conflictCells } = useTable(workspace, tableId!, workspaceId, syncCount)
  const members = useMembers(workspace)
  const [schema, setSchema] = useState<any>(null)
  const [isAddingColumn, setIsAddingColumn] = useState(false)
  /** The column being edited in the Edit-column modal, or null. */
  const [editingColumn, setEditingColumn] = useState<{
    id: string
    initial: EditColumnInitial
    existingValues: string[]
  } | null>(null)
  /** Which cell is being edited: "rowId:colId" or null */
  const [editing, setEditing] = useState<string | null>(null)
  /** Stable id for the faded "shadow" quick-add row; rotated once it's promoted
   *  to a real entry so the next ghost row gets a fresh id. */
  const [shadowId, setShadowId] = useState(() => `row_${Date.now()}`)
  const [deletingRows, setDeletingRows] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  // Per-column "where" conditions (issue: Real filter UI). Applied client-side
  // and saveable into a view (filters + sort). Loaded from a saved view below.
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const [savingView, setSavingView] = useState(false)
  const [newViewName, setNewViewName] = useState('')
  /** The saved view currently open (for "Save changes"); null on a raw table. */
  const [loadedView, setLoadedView] = useState<{ id: string; name: string } | null>(null)
  /** Guards the load-once-per-view effect against re-runs (workspace identity). */
  const loadedViewIdRef = useRef<string | null>(null)

  const columnsMeta: ColumnMeta[] = React.useMemo(() => {
    const columnSet = new Set<string>()
    rows.forEach(row => {
      Object.keys(row).forEach(key => { if (key !== '_row_id') columnSet.add(key) })
    })
    if (schema?.columns) {
      Object.keys(schema.columns).forEach(colId => columnSet.add(colId))
    }
    // Drop columns deleted from the schema, even though their cell values may
    // still linger in row data until they decay out of the timeline.
    const deleted = new Set<string>(schema?.deleted_columns ?? [])
    return Array.from(columnSet)
      .filter(colId => !deleted.has(colId))
      .map(colId => {
        const def = schema?.columns?.[colId]
        return {
          id: colId,
          name: def?.name || colId.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
          column_type: def?.column_type || 'text',
          options: def?.options,
          order: typeof def?.order === 'number' ? def.order : null,
        }
      })
      // Sort by the schema's explicit column order; columns without one (legacy
      // tables or row-only keys) fall to the end, ordered by id.
      .sort((a, b) => {
        if (a.order != null && b.order != null) return a.order - b.order
        if (a.order != null) return -1
        if (b.order != null) return 1
        return a.id.localeCompare(b.id)
      })
  }, [rows, schema])

  const columnsById = React.useMemo(
    () =>
      Object.fromEntries(columnsMeta.map(c => [c.id, { id: c.id, column_type: c.column_type }])),
    [columnsMeta],
  )
  // Pre-filter rows with the per-column conditions; TanStack still applies the
  // global text search + sort on top of the result.
  const filteredRows = React.useMemo(
    () => applyFilters(rows as Record<string, unknown>[], conditions, columnsById),
    [rows, conditions, columnsById],
  )

  useEffect(() => {
    if (workspace && tableId) {
      try {
        setSchema(JSON.parse(workspace.getTableSchema(tableId)))
      } catch (err) {
        console.error('Failed to load schema:', err)
      }
    }
  }, [workspace, tableId, rows])

  // Load a saved view's filters + sort once when it opens (issue: Real filter UI).
  // Ad-hoc filtering on a raw table (no viewId) starts empty.
  useEffect(() => {
    if (!workspace || !viewId) {
      loadedViewIdRef.current = null
      setLoadedView(null)
      return
    }
    if (loadedViewIdRef.current === viewId) return
    loadedViewIdRef.current = viewId
    try {
      const cfg = JSON.parse(workspace.getView(viewId))
      setLoadedView({ id: viewId, name: cfg.name ?? '' })
      const { conditions: c, sorting: s } = mapViewFilters(cfg)
      setConditions(c)
      setSorting(s)
      if (c.length > 0) setShowFilter(true)
    } catch (err) {
      console.error('Failed to load view config:', err)
    }
  }, [workspace, viewId])

  const showCellError = (err: any) => {
    const msg = err?.message ?? String(err)
    if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('M_LIMIT_EXCEEDED')) {
      setToast('Rate limited — slow down a bit')
    } else {
      setToast(`Update failed: ${msg}`)
    }
    setTimeout(() => setToast(null), 4000)
  }

  // Column drag-to-reorder. A 6px threshold means a click still sorts.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const handleColumnDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id || !tableId || !workspace) return
    const ids = columnsMeta.map(c => c.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const reordered = arrayMove(ids, from, to)
    // reorderColumns applies locally (synchronous in WASM) before its network
    // send, so re-reading the schema right away reflects the new order instantly
    // while the send happens in the background.
    const result = workspace.reorderColumns(tableId, JSON.stringify(reordered))
    try {
      setSchema(JSON.parse(workspace.getTableSchema(tableId)))
    } catch {
      /* keep current schema */
    }
    Promise.resolve(result).catch(showCellError)
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
  }

  // Row drag-to-reorder. Writes a fractional-index `_order` key (one cell for an
  // already-ordered table; a one-time backfill on the first reorder). Optimistic
  // like the column reorder: apply + re-read, send in the background.
  const handleRowDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id || !tableId || !workspace) return
    let keyMap: Record<string, string> = {}
    try {
      keyMap = JSON.parse(workspace.getRowOrderKeys?.(tableId) ?? '{}')
    } catch {
      /* no keys yet — computeReorderWrites will backfill */
    }
    const orderRows: OrderRow[] = tableRows.map(r => ({
      id: r.original._row_id,
      key: keyMap[r.original._row_id] ?? null,
    }))
    const writes = computeReorderWrites(orderRows, String(active.id), String(over.id))
    for (const w of writes) {
      updateCell(w.id, '_order', w.key).catch(showCellError)
    }
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
    refresh()
  }

  const handleDeleteColumn = (colId: string, colName: string) => {
    if (!tableId || !workspace) return
    if (!window.confirm(`Delete column "${colName}"? Its values will stop showing.`)) return
    const result = workspace.deleteColumn(tableId, colId)
    try {
      setSchema(JSON.parse(workspace.getTableSchema(tableId)))
    } catch {
      /* keep current schema */
    }
    Promise.resolve(result).catch(showCellError)
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
  }

  // Apply a column-schema change (e.g. rename). Optimistic like reorder: the
  // local schema updates synchronously, the network send runs in the background.
  const handleUpdateColumn = (colId: string, patch: Record<string, any>) => {
    if (!tableId || !workspace) return
    const result = workspace.updateColumn(tableId, colId, JSON.stringify(patch))
    try {
      setSchema(JSON.parse(workspace.getTableSchema(tableId)))
    } catch {
      /* keep current schema */
    }
    Promise.resolve(result).catch(showCellError)
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
  }

  // Open the Edit-column modal, prefilled from the column's current schema and
  // seeded with the column's distinct existing values (so changing the type to
  // Select can auto-detect options).
  const openEditColumn = (colId: string) => {
    const meta = columnsMeta.find(c => c.id === colId)
    if (!meta) return
    const schemaCol = schema?.columns?.[colId]
    const seen = new Set<string>()
    for (const row of rows) {
      const v = (row as any)[colId]
      const vals = Array.isArray(v) ? v : [v]
      for (const item of vals) {
        if (item == null) continue
        const s = String(item).trim()
        if (s) seen.add(s)
      }
    }
    setEditingColumn({
      id: colId,
      initial: {
        name: meta.name,
        columnType: (meta.column_type as any) ?? 'text',
        options: meta.options ?? [],
        defaultValue: schemaCol?.default_value != null ? String(schemaCol.default_value) : undefined,
      },
      existingValues: Array.from(seen).sort().slice(0, 50),
    })
  }

  // Save edits from the modal: rename / retype / options / default in one patch.
  const handleSaveColumn = (def: NewColumnDef) => {
    if (!editingColumn) return
    const patch: Record<string, any> = { name: def.name, column_type: def.columnType }
    if (def.columnType === 'select' || def.columnType === 'multiselect') {
      patch.options = def.options
    }
    if (def.columnType === 'select' && def.defaultValue) {
      patch.default_value = def.defaultValue
    }
    handleUpdateColumn(editingColumn.id, patch)
    setEditingColumn(null)
  }

  const handleAddColumn = async (def: NewColumnDef) => {
    if (!workspace || !tableId) return
    const columnId = def.name.toLowerCase().replace(/\s+/g, '_')
    const columnDef = {
      id: columnId,
      name: def.name,
      column_type: def.columnType,
      required: false,
      ...(def.options.length > 0 ? { options: def.options } : {}),
      ...(def.defaultValue !== undefined && def.defaultValue !== ''
        ? { default_value: def.defaultValue }
        : {}),
    }
    try {
      await workspace.addColumn(tableId, JSON.stringify(columnDef))
      setIsAddingColumn(false)
      refresh()
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
    } catch (err) {
      console.error('Failed to add column:', err)
    }
  }

  // Promote the faded shadow row to a real entry: editing one of its cells
  // persists the prefilled column defaults plus the edited value under the
  // shadow id, then rotates the shadow id so a fresh ghost row appears. Mirrors
  // the new-entry default-flush in EntryView, but inline.
  const handleShadowCommit = async (colId: string, value: any) => {
    if (!tableId || !workspace) return
    const id = shadowId
    setShadowId(`row_${Date.now()}`)
    setEditing(null)
    try {
      for (const col of columnsMeta) {
        if (col.id === colId) continue
        const def = schema?.columns?.[col.id]?.default_value
        if (def !== undefined && def !== null && def !== '') {
          await updateCell(id, col.id, def)
        }
      }
      await updateCell(id, colId, value)
      // The new row lives in WASM now; re-read so it materializes in the grid
      // (the hook's optimistic update only touches existing rows).
      refresh()
    } catch (err) {
      showCellError(err)
    }
  }

  // Resolve the records of a referenced table (id + a text-column label) so
  // `reference` cells can pick from / display real rows instead of raw ids.
  const referenceLookup = React.useCallback((refTableId: string) => {
    if (!workspace) return []
    try {
      const refRows = JSON.parse(workspace.getTableRows(refTableId)) as Array<Record<string, any>>
      let labelColId: string | undefined
      try {
        const refSchema = JSON.parse(workspace.getTableSchema(refTableId))
        labelColId = (Object.values(refSchema.columns ?? {}) as any[]).find(c => c.column_type === 'text')?.id
      } catch { /* no schema — fall back to the row id */ }
      return refRows.map(r => ({
        id: r._row_id,
        label: labelColId && r[labelColId] != null ? String(r[labelColId]) : r._row_id,
      }))
    } catch {
      return []
    }
  }, [workspace])

  // Latest displayed rows/columns in refs so moveEditing stays stable (it's
  // captured by the memoized cell renderer). tableRowsRef is set after the table
  // model is built, below.
  const tableRowsRef = useRef<any[]>([])
  const columnsMetaRef = useRef(columnsMeta)
  columnsMetaRef.current = columnsMeta

  // Keyboard nav: move edit focus to an adjacent cell. Walks the displayed
  // (sorted/filtered) rows × visible columns; Tab wraps across rows, and running
  // past the first/last cell exits edit mode.
  const moveEditing = React.useCallback(
    (rowId: string, colId: string, dir: 'up' | 'down' | 'left' | 'right') => {
      const rowIds = tableRowsRef.current.map((r: any) => r.original._row_id)
      const colIds = columnsMetaRef.current.map(c => c.id)
      let ri = rowIds.indexOf(rowId)
      let ci = colIds.indexOf(colId)
      if (ri < 0 || ci < 0) { setEditing(null); return }
      if (dir === 'right') { ci++; if (ci >= colIds.length) { ci = 0; ri++ } }
      else if (dir === 'left') { ci--; if (ci < 0) { ci = colIds.length - 1; ri-- } }
      else if (dir === 'down') ri++
      else if (dir === 'up') ri--
      if (ri < 0 || ri >= rowIds.length || ci < 0 || ci >= colIds.length) {
        setEditing(null)
        return
      }
      setEditing(`${rowIds[ri]}:${colIds[ci]}`)
    },
    [],
  )

  // ── TanStack column model (data columns only; add-column + actions are
  //    rendered separately so the grid model stays purely schema-driven) ──
  const columns = useMemo<ColumnDef<TableRow>[]>(() => {
    return columnsMeta.map(col => ({
      id: col.id,
      accessorFn: (row: TableRow) => row[col.id],
      header: col.name,
      enableSorting: true,
      cell: ctx => {
        const rowId = ctx.row.original._row_id
        const cellKey = `${rowId}:${col.id}`
        const value = ctx.getValue()
        const cellColumn: CellColumn = {
          id: col.id,
          name: col.name,
          column_type: col.column_type,
          options: col.options,
        }
        if (editing === cellKey) {
          return (
            <CellEditor
              column={cellColumn}
              value={value}
              autoFocus
              popover
              lookup={referenceLookup}
              members={members}
              commit={v => updateCell(rowId, col.id, v).catch(showCellError)}
              onNavigate={dir => moveEditing(rowId, col.id, dir)}
              onDone={() => setEditing(null)}
            />
          )
        }
        // A concurrent remote write just overwrote this user's recent edit
        // (legitimate LWW loss) — flash briefly; history is the recovery path.
        const conflicted = conflictCells.has(`${rowId}:${col.id}`)
        return (
          <div
            className={conflicted ? 'cell-click cell-conflict' : 'cell-click'}
            title={conflicted ? 'Your change was replaced by a newer edit' : undefined}
            onClick={e => { e.stopPropagation(); setEditing(cellKey) }}
          >
            <CellDisplay column={cellColumn} value={value} lookup={referenceLookup} members={members} />
          </div>
        )
      },
    }))
  }, [columnsMeta, editing, updateCell, referenceLookup, members, moveEditing, conflictCells])

  const table = useReactTable({
    data: filteredRows as TableRow[],
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: globalTextFilter,
    // Search all columns, not just those whose first-row value is a string —
    // otherwise an empty first-row select cell excludes the column (see
    // globalTextFilter).
    getColumnCanGlobalFilter: () => true,
    getRowId: (row: TableRow) => row._row_id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const tableRows = table.getRowModel().rows
  // Expose the displayed rows to the stable moveEditing callback (keyboard nav).
  tableRowsRef.current = tableRows

  // Manual row reordering applies only to the natural (unsorted, unfiltered)
  // view — a column sort or filter defines its own order, so drag is disabled
  // then to avoid an ambiguous result.
  const rowsReorderable = sorting.length === 0 && !globalFilter && conditions.length === 0

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // Assume a viewport even before measurement so rows render under jsdom/SSR.
    initialRect: { width: 1000, height: 800 },
  })
  const virtualRows = virtualizer.getVirtualItems()
  // Fall back to rendering every row when the virtualizer has no measurable
  // viewport (jsdom / SSR / zero-height container). In a real browser the
  // viewport is measured, so only the visible window renders.
  const useVirtual = virtualRows.length > 0
  const totalSize = virtualizer.getTotalSize()
  const paddingTop = useVirtual ? virtualRows[0].start : 0
  const paddingBottom = useVirtual ? totalSize - virtualRows[virtualRows.length - 1].end : 0
  const displayRows = useVirtual ? virtualRows.map(v => tableRows[v.index]) : tableRows

  // total columns including the leading open button, the add-column spacer, and
  // the actions column
  // Leading open-entry column + trailing actions column flank the data columns.
  const totalColSpan = columnsMeta.length + 2

  if (!tableId) {
    return <div className="table-view"><div className="state-empty"><p>No table selected</p></div></div>
  }

  if (loading) {
    return (
      <div className="table-view">
        <Toolbar title={tableId} />
        <div className="state-empty">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="table-view">
        <Toolbar title={tableId} />
        <div className="state-error"><h3>Error loading table</h3><p>{error.message}</p></div>
      </div>
    )
  }

  // ── Saving the current filters + sort into a view ──────────────────────────
  const buildViewPayload = (id: string, name: string) =>
    JSON.stringify({
      id,
      name,
      table_id: tableId,
      view_type: 'table',
      sort: sorting.map(s => ({ column_id: s.id, direction: s.desc ? 'descending' : 'ascending' })),
      filters: conditions.map(c => ({
        column_id: c.columnId,
        operator: c.operator,
        value: c.value ?? null,
      })),
    })

  const saveAsView = async () => {
    const name = newViewName.trim()
    if (!name) return
    const id = globalThis.crypto?.randomUUID?.() ?? `view_${Date.now()}`
    try {
      await workspace.createView(buildViewPayload(id, name))
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      setSavingView(false)
      setNewViewName('')
      navigate(`/workspace/${workspaceId}/table/${tableId}/view/${id}`)
    } catch (err: any) {
      showCellError(err)
    }
  }

  const saveChanges = async () => {
    if (!loadedView) return
    try {
      await workspace.createView(buildViewPayload(loadedView.id, loadedView.name))
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      setToast('View updated')
      setTimeout(() => setToast(null), 2000)
    } catch (err: any) {
      showCellError(err)
    }
  }

  /** Reset ephemeral filter edits back to the baseline: a saved view's persisted
   *  filters + sort, or empty on a raw table. Also clears the text search. */
  const resetFilters = () => {
    setGlobalFilter('')
    if (loadedView) {
      try {
        const { conditions: c, sorting: s } = mapViewFilters(JSON.parse(workspace.getView(loadedView.id)))
        setConditions(c)
        setSorting(s)
        return
      } catch (err) {
        console.error('Failed to reset to the saved view:', err)
      }
    }
    setConditions([])
    setSorting([])
  }

  const tableTitle = schema?.name || tableId

  return (
    <div className="table-view">
      <Toolbar
        title={tableTitle}
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />} label="Filter" active={showFilter} onClick={() => setShowFilter(s => !s)} />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarButton icon={<HistoryIcon />} label="History" active={showHistory} onClick={() => setShowHistory(true)} title="Change history" />
            <ToolbarButton icon={<PlusIcon />} label="Add column" title="Add column" onClick={() => setIsAddingColumn(true)} />
            <ToolbarPrimaryButton onClick={newEntry}>New entry</ToolbarPrimaryButton>
          </>
        }
      />

      {showHistory && (
        <HistoryDrawer
          workspace={workspace}
          tableId={tableId}
          onClose={() => setShowHistory(false)}
          onReverted={() => {
            refresh()
            if (workspaceId) notifyWorkspaceChanged(workspaceId)
          }}
        />
      )}

      {showFilter && (
        <div className="table-filter-bar table-filter-bar--stacked">
          <div className="table-filter-row">
            <input
              className="table-filter-input"
              placeholder="Search all columns…"
              value={globalFilter}
              onChange={e => setGlobalFilter(e.target.value)}
            />
            <span className="table-filter-count">
              {tableRows.length} row{tableRows.length === 1 ? '' : 's'}
            </span>
            {(globalFilter || conditions.length > 0) && (
              <button
                className="ghost table-filter-clear"
                onClick={resetFilters}
                title={loadedView ? 'Reset to this view’s saved filters' : 'Clear all filters'}
              >
                Reset
              </button>
            )}
          </div>
          <FilterBar columns={columnsMeta} conditions={conditions} onChange={setConditions} />
          <div className="table-filter-actions">
            {/* Filters are ephemeral until saved: tweak freely, then either
                commit to this view ("Save view") or fork a new one. */}
            {loadedView && (
              <button className="ghost" onClick={saveChanges} title={`Update “${loadedView.name}”`}>
                Save view
              </button>
            )}
            {!savingView ? (
              <button
                className="ghost"
                onClick={() => {
                  setNewViewName('')
                  setSavingView(true)
                }}
              >
                {loadedView ? 'Save as separate view' : 'Save view'}
              </button>
            ) : (
              <span className="table-save-view">
                <input
                  className="table-filter-input"
                  placeholder="View name"
                  value={newViewName}
                  autoFocus
                  onChange={e => setNewViewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveAsView()
                  }}
                />
                <button className="ghost" onClick={() => void saveAsView()} disabled={!newViewName.trim()}>
                  Save
                </button>
                <button className="ghost" onClick={() => setSavingView(false)}>
                  Cancel
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="table-view__content">
        <div className="table-scroll" ref={scrollRef}>
          <table className="data-table">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleColumnDragEnd}
            >
            <thead>
              <tr>
                <th className="col-open-header" />
                <SortableContext
                  items={columnsMeta.map(c => c.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  {table.getHeaderGroups()[0]?.headers.map(header => {
                    const label = String(header.column.columnDef.header)
                    return (
                      <SortableHeader
                        key={header.id}
                        id={header.column.id}
                        label={label}
                        sorted={header.column.getIsSorted()}
                        onSort={header.column.getToggleSortingHandler()}
                        onEdit={() => openEditColumn(header.column.id)}
                        onDelete={() => handleDeleteColumn(header.column.id, label)}
                      />
                    )
                  })}
                </SortableContext>
                <th className="col-actions-header" />
              </tr>
            </thead>
            </DndContext>
            <tbody>
              {paddingTop > 0 && (
                <tr aria-hidden="true"><td colSpan={totalColSpan} style={{ height: paddingTop, padding: 0 }} /></tr>
              )}

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleRowDragEnd}
              >
                <SortableContext
                  items={tableRows.map(r => r.original._row_id)}
                  strategy={verticalListSortingStrategy}
                >
                  {displayRows.map(row => {
                    const rowId = row.original._row_id
                    return (
                      <SortableTableRow
                        key={row.id}
                        rowId={rowId}
                        reorderable={rowsReorderable}
                        onOpen={() => openEntry(rowId)}
                      >
                        {row.getVisibleCells().map(cell => (
                          <td key={cell.id}>
                            {(cell.column.columnDef.cell as any)(cell.getContext())}
                          </td>
                        ))}
                        <td className="cell-actions" onClick={e => e.stopPropagation()}>
                          <button
                            className="ghost cell-delete-btn"
                            disabled={deletingRows.has(rowId)}
                            onClick={() => {
                              setDeletingRows(prev => new Set(prev).add(rowId))
                              deleteRow(rowId)
                                .catch(console.error)
                                .finally(() => setDeletingRows(prev => {
                                  const next = new Set(prev)
                                  next.delete(rowId)
                                  return next
                                }))
                            }}
                            title="Delete row"
                          >
                            {deletingRows.has(rowId) ? (
                              <span className="cell-delete-spinner" />
                            ) : (
                              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                                <polyline points="1,3 12,3" />
                                <path d="M4.5 3V2a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1" />
                                <rect x="2.5" y="3" width="8" height="8.5" rx="1" />
                              </svg>
                            )}
                          </button>
                        </td>
                      </SortableTableRow>
                    )
                  })}
                </SortableContext>
              </DndContext>

              {paddingBottom > 0 && (
                <tr aria-hidden="true"><td colSpan={totalColSpan} style={{ height: paddingBottom, padding: 0 }} /></tr>
              )}

              {/* Shadow row: a faded, prefilled-with-defaults ghost row for quick
                  inline adds. Editing any cell promotes it to a real entry. Also
                  the empty-table state (issue c79ce975): the first entry is added
                  inline here, no separate CTA. */}
              {columnsMeta.length > 0 && (
                <tr className="row-shadow" style={{ height: ROW_HEIGHT }} title="Add a new entry">
                  <td className="cell-open" aria-hidden="true">
                    <span className="cell-shadow-plus">+</span>
                  </td>
                  {columnsMeta.map(col => {
                    const cellKey = `${shadowId}:${col.id}`
                    const cellColumn: CellColumn = {
                      id: col.id,
                      name: col.name,
                      column_type: col.column_type,
                      options: col.options,
                    }
                    const value = schema?.columns?.[col.id]?.default_value ?? null
                    if (editing === cellKey) {
                      return (
                        <td key={col.id}>
                          <CellEditor
                            column={cellColumn}
                            value={value}
                            autoFocus
                            popover
                            lookup={referenceLookup}
                            commit={v => handleShadowCommit(col.id, v)}
                            onDone={() => setEditing(null)}
                          />
                        </td>
                      )
                    }
                    return (
                      <td key={col.id}>
                        <div className="cell-click cell-shadow" onClick={() => setEditing(cellKey)}>
                          <CellDisplay column={cellColumn} value={value} lookup={referenceLookup} members={members} />
                        </div>
                      </td>
                    )
                  })}
                  <td className="cell-actions" aria-hidden="true" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add column modal */}
      {isAddingColumn && (
        <AddColumnModal
          onAdd={handleAddColumn}
          onClose={() => setIsAddingColumn(false)}
        />
      )}

      {/* Edit column modal (rename / retype / options / default) */}
      {editingColumn && (
        <AddColumnModal
          key={editingColumn.id}
          onAdd={handleSaveColumn}
          onClose={() => setEditingColumn(null)}
          initial={editingColumn.initial}
          existingValues={editingColumn.existingValues}
        />
      )}

      {toast && (
        <div className="table-toast" role="alert">
          {toast}
          <button className="table-toast__close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
    </div>
  )
}
