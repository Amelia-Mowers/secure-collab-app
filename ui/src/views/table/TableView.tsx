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
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTable, notifyWorkspaceChanged } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import { AddColumnModal, type NewColumnDef } from '@/components/AddColumnModal'
import { CellDisplay, CellEditor, type CellColumn } from '@/cells/cellRegistry'
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

/** Types a column can be changed to in-place. Select/multiselect/reference are
 *  omitted — they need extra config (options / target table). */
const RETYPE_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'document', label: 'Document' },
]

/** A draggable, sortable column header with a ⋯ menu (rename / change type /
 *  delete). A small drag distance is required to start a reorder (see the
 *  PointerSensor), so a plain click still toggles the TanStack sort; the ⋯
 *  trigger sits at the right edge so it never intercepts that click. */
function SortableHeader({
  id,
  label,
  sorted,
  colType,
  onSort,
  onRename,
  onRetype,
  onDelete,
}: {
  id: string
  label: string
  sorted: false | 'asc' | 'desc'
  colType: string
  onSort: ((event: unknown) => void) | undefined
  onRename: (name: string) => void
  onRetype: (type: string) => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(label)
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: renaming ? 'text' : 'grab',
  }

  const commit = () => {
    const next = draft.trim()
    if (next && next !== label) onRename(next)
    setRenaming(false)
  }

  // While renaming we drop the drag listeners so the input behaves normally.
  if (renaming) {
    return (
      <th ref={setNodeRef} style={style} className="col-sortable col-renaming">
        <input
          className="col-rename-input"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={commit}
        />
      </th>
    )
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
          <>
            <div className="col-menu__backdrop" onClick={() => setMenuOpen(false)} />
            <div className="col-menu__dropdown" role="menu">
              <button
                className="col-menu__item"
                onClick={() => { setMenuOpen(false); setDraft(label); setRenaming(true) }}
              >
                Rename
              </button>
              <div className="col-menu__section">
                <span className="col-menu__label">Type</span>
                <select
                  className="col-menu__type"
                  value={colType}
                  onChange={e => { setMenuOpen(false); onRetype(e.target.value) }}
                >
                  {!RETYPE_TYPES.some(t => t.value === colType) && (
                    <option value={colType}>{colType}</option>
                  )}
                  {RETYPE_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <button
                className="col-menu__item col-menu__delete"
                onClick={() => { setMenuOpen(false); onDelete() }}
              >
                Delete column
              </button>
            </div>
          </>
        )}
      </div>
    </th>
  )
}

export function TableView({ workspace, syncCount }: TableViewProps) {
  const { workspaceId, tableId } = useParams<{ workspaceId: string; tableId: string }>()
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
  const { rows, loading, error, updateCell, deleteRow, refresh } = useTable(workspace, tableId!, workspaceId, syncCount)
  const [schema, setSchema] = useState<any>(null)
  const [isAddingColumn, setIsAddingColumn] = useState(false)
  /** Which cell is being edited: "rowId:colId" or null */
  const [editing, setEditing] = useState<string | null>(null)
  const [deletingRows, setDeletingRows] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [showFilter, setShowFilter] = useState(false)

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

  useEffect(() => {
    if (workspace && tableId) {
      try {
        setSchema(JSON.parse(workspace.getTableSchema(tableId)))
      } catch (err) {
        console.error('Failed to load schema:', err)
      }
    }
  }, [workspace, tableId, rows])

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
              lookup={referenceLookup}
              commit={v => updateCell(rowId, col.id, v).catch(showCellError)}
              onDone={() => setEditing(null)}
            />
          )
        }
        return (
          <div
            className="cell-click"
            onClick={e => { e.stopPropagation(); setEditing(cellKey) }}
          >
            <CellDisplay column={cellColumn} value={value} lookup={referenceLookup} />
          </div>
        )
      },
    }))
  }, [columnsMeta, editing, updateCell, referenceLookup])

  const table = useReactTable({
    data: rows as TableRow[],
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
  const totalColSpan = columnsMeta.length + 3

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

  const tableTitle = schema?.name || tableId

  return (
    <div className="table-view">
      <Toolbar
        title={tableTitle}
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />} label="Filter" active={showFilter} onClick={() => setShowFilter(s => !s)} />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarPrimaryButton onClick={newEntry}>New entry</ToolbarPrimaryButton>
          </>
        }
      />

      {showFilter && (
        <div className="table-filter-bar">
          <input
            className="table-filter-input"
            placeholder="Filter rows…"
            value={globalFilter}
            autoFocus
            onChange={e => setGlobalFilter(e.target.value)}
          />
          {globalFilter && (
            <span className="table-filter-count">
              {tableRows.length} match{tableRows.length === 1 ? '' : 'es'}
            </span>
          )}
          {globalFilter && (
            <button className="ghost table-filter-clear" onClick={() => setGlobalFilter('')}>Clear</button>
          )}
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
                    const colType =
                      columnsMeta.find(c => c.id === header.column.id)?.column_type ?? 'text'
                    return (
                      <SortableHeader
                        key={header.id}
                        id={header.column.id}
                        label={label}
                        sorted={header.column.getIsSorted()}
                        colType={colType}
                        onSort={header.column.getToggleSortingHandler()}
                        onRename={name => handleUpdateColumn(header.column.id, { name })}
                        onRetype={type => handleUpdateColumn(header.column.id, { column_type: type })}
                        onDelete={() => handleDeleteColumn(header.column.id, label)}
                      />
                    )
                  })}
                </SortableContext>
                <th className="col-add-header">
                  <button
                    className="col-add-btn ghost"
                    onClick={() => setIsAddingColumn(true)}
                    title="Add column"
                  >+ Add Column</button>
                </th>
                <th className="col-actions-header" />
              </tr>
            </thead>
            </DndContext>
            <tbody>
              {tableRows.length === 0 && (
                <tr className="row-empty-cta">
                  <td colSpan={totalColSpan}>
                    <button className="empty-cta-btn" onClick={newEntry}>
                      + Add your first entry
                    </button>
                  </td>
                </tr>
              )}

              {paddingTop > 0 && (
                <tr aria-hidden="true"><td colSpan={totalColSpan} style={{ height: paddingTop, padding: 0 }} /></tr>
              )}

              {displayRows.map(row => {
                const rowId = row.original._row_id
                return (
                  <tr key={row.id} style={{ height: ROW_HEIGHT }}>
                    <td className="cell-open">
                      <button
                        className="ghost cell-open-btn"
                        onClick={() => openEntry(rowId)}
                        title="Open full entry"
                        aria-label="Open full entry"
                      >
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <path d="M2 2h4M2 2v4M2 2l4.5 4.5" />
                          <path d="M11 11H7M11 11V7M11 11L6.5 6.5" />
                        </svg>
                      </button>
                    </td>
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id}>
                        {(cell.column.columnDef.cell as any)(cell.getContext())}
                      </td>
                    ))}
                    <td onClick={e => e.stopPropagation()} />
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
                  </tr>
                )
              })}

              {paddingBottom > 0 && (
                <tr aria-hidden="true"><td colSpan={totalColSpan} style={{ height: paddingBottom, padding: 0 }} /></tr>
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

      {toast && (
        <div className="table-toast" role="alert">
          {toast}
          <button className="table-toast__close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
    </div>
  )
}
