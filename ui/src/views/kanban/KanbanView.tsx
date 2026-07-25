import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTable, useMembers, useCurrentUserId, notifyWorkspaceChanged } from '@/hooks/useTable'
import { computeReorderWrites } from '@/fractionalIndex'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import { ViewSettingsModal } from '@/components/ViewSettingsModal'
import { FilterPanel } from '@/components/FilterPanel'
import { type FilterColumnMeta } from '@/views/table/FilterBar'
import { applyFilters, type FilterCondition } from '@/lib/filters'
import { makeReferenceLookup } from '@/lib/referenceLookup'
import { memberLabel } from '@/cells/cellRegistry'
import { resolveTargetColumn } from './kanbanUtils'
import './KanbanView.css'

const GearIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="7" cy="7" r="2.2" />
    <path d="M7 1.2v1.9M7 10.9v1.9M1.2 7h1.9M10.9 7h1.9M2.9 2.9l1.35 1.35M9.75 9.75l1.35 1.35M11.1 2.9 9.75 4.25M4.25 9.75 2.9 11.1" />
  </svg>
)

interface KanbanViewProps {
  workspace: any
  syncCount?: number
}

interface KanbanCard {
  id: string
  title: string
  [key: string]: any
}

interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

// Deterministic avatar colour from string
function avatarColor(str: string): string {
  const palette = ['#6d9fff','#a78bfa','#f472b6','#4ade80','#f59e0b','#f87171']
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff
  return palette[h % palette.length]
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="k-avatar" style={{ background: avatarColor(name) }}>
      {name?.[0]?.toUpperCase() ?? '?'}
    </span>
  )
}

// Status dot colour
function statusColor(colTitle: string) {
  const lc = colTitle.toLowerCase()
  if (lc === 'done' || lc === 'complete') return 'var(--green)'
  if (lc.includes('progress')) return 'var(--accent)'
  if (lc === 'blocked') return 'var(--red)'
  return 'var(--text-tertiary)'
}

function SortableCard({ card, hiddenKeys, person, onOpen }: { card: KanbanCard; hiddenKeys: Set<string>; person: string | null; onOpen: (card: KanbanCard) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  // Skip internal keys and any deleted column whose values still linger in the
  // row data (decay model) — they must not resurface on the card.
  const extraFields = Object.entries(card).filter(
    ([k]) => k !== 'id' && k !== 'title' && k !== '_row_id' && k !== 'status' && !hiddenKeys.has(k)
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="kcard"
      onClick={() => onOpen(card)}
    >
      <button
        type="button"
        className="kcard__expand"
        title="Open full entry"
        aria-label="Open full entry"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onOpen(card) }}
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 2h4M2 2v4M2 2l4.5 4.5" />
          <path d="M11 11H7M11 11V7M11 11L6.5 6.5" />
        </svg>
      </button>
      <div className="kcard__title">{card.title || 'Untitled'}</div>
      {extraFields.length > 0 && (
        <div className="kcard__fields">
          {extraFields.map(([k, v]) => (
            <div key={k} className="kcard__field">
              <span className="kcard__field-label">{k}</span>
              <span className="kcard__field-value">{String(v ?? '')}</span>
            </div>
          ))}
        </div>
      )}
      {person && (
        <div className="kcard__footer">
          <Avatar name={person} />
          <span className="kcard__assignee">{person}</span>
        </div>
      )}
    </div>
  )
}

/**
 * A droppable zone that covers the entire column area.
 * This allows cards to be dropped onto empty columns — dnd-kit's
 * SortableContext only registers cards as droppable, so empty columns
 * would otherwise be unreachable drag targets.
 */
function DroppableColumn({
  column,
  children,
}: {
  column: KanbanColumn
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  return (
    <div ref={setNodeRef} className={`kcol__drop-area${isOver ? ' kcol__drop-area--over' : ''}`}>
      {children}
    </div>
  )
}

export function KanbanView({ workspace, syncCount }: KanbanViewProps) {
  const { workspaceId, tableId, viewId } = useParams<{ workspaceId: string; tableId: string; viewId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { rows, loading, error, updateCell, refresh } = useTable(workspace, tableId!, workspaceId, syncCount)
  const [viewConfig, setViewConfig] = useState<any>(null)
  const [viewError, setViewError] = useState<Error | null>(null)
  const [schema, setSchema] = useState<any>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [regroupCol, setRegroupCol] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  // Per-column conditions, same engine and editor as the table view (issue
  // aaae6f3f). Loaded from the view, tweakable ad hoc, saveable back.
  const [showFilter, setShowFilter] = useState(false)
  const [conditions, setConditions] = useState<FilterCondition[]>([])

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    if (workspace && viewId) {
      try {
        const cfg = JSON.parse(workspace.getView(viewId))
        setViewConfig(cfg)
        const saved: FilterCondition[] = (cfg?.filters ?? []).map((f: any) => ({
          columnId: f.column_id,
          operator: f.operator,
          value: f.value ?? undefined,
        }))
        setConditions(saved)
        if (saved.length > 0) setShowFilter(true)
        setViewError(null)
      } catch (err) {
        console.error('Failed to load view config:', err)
        setViewError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }, [workspace, viewId])

  // Load the table schema so we can (a) drop deleted columns from cards and
  // (b) detect when the board groups by a column that no longer exists.
  useEffect(() => {
    if (workspace && tableId) {
      try { setSchema(JSON.parse(workspace.getTableSchema(tableId))) } catch { /* keep prior */ }
    }
  }, [workspace, tableId, syncCount])

  const deletedCols = useMemo<Set<string>>(
    () => new Set<string>(schema?.deleted_columns ?? []),
    [schema],
  )

  // Columns still present in the schema (for the "group by" picker).
  const availableColumns = useMemo<Array<{ id: string; name: string; column_type?: string; options?: string[] }>>(() => {
    const cols = schema?.columns ? (Object.values(schema.columns) as any[]) : []
    return cols.filter(c => !deletedCols.has(c.id))
  }, [schema, deletedCols])

  // The card footer's person comes from the view's CONFIGURED assignee
  // column — an explicit, optional setting (lean-on-view-settings rule: a
  // table can have several member columns; which one is "the assignee" is the
  // user's choice, never inferred). Unset, or pointing at a since-deleted
  // column → no footer.
  const members = useMembers(workspace)
  const me = useCurrentUserId(workspace)
  const referenceLookup = useMemo(() => makeReferenceLookup(workspace), [workspace])
  const memberCol = useMemo(() => {
    const configured = viewConfig?.kanban_config?.assignee_column
    if (!configured) return null
    return availableColumns.find(c => c.id === configured) ?? null
  }, [availableColumns, viewConfig])
  const personFor = (card: KanbanCard): string | null => {
    if (!memberCol) return null
    const v = card[memberCol.id]
    const first = Array.isArray(v) ? v[0] : v
    if (first == null || first === '') return null
    return memberLabel(members, String(first))
  }

  // Only select/multiselect columns can serve as the "group by" axis — same
  // rule as NewViewDropdown's kanban config (issue 6e2011e3): grouping by free
  // text/number would make every distinct value a lane.
  const regroupColumns = useMemo(
    () =>
      availableColumns.filter(
        c => c.column_type === 'select' || c.column_type === 'multiselect',
      ),
    [availableColumns],
  )

  const groupByColumn: string | undefined = viewConfig?.kanban_config?.group_by_column
  // Only flag a missing group-by once the schema has actually loaded.
  const groupByMissing =
    !!viewConfig?.kanban_config &&
    !!schema &&
    (deletedCols.has(groupByColumn as string) || !availableColumns.some(c => c.id === groupByColumn))

  const handleRegroup = async () => {
    if (!regroupCol || !viewConfig || !viewId || !tableId) return
    const chosen = regroupColumns.find(c => c.id === regroupCol)
    if (!chosen) return
    const newConfig = {
      id: viewId,
      name: viewConfig.name,
      table_id: tableId,
      view_type: 'kanban',
      sort: viewConfig.sort ?? [],
      filters: viewConfig.filters ?? [],
      kanban_config: {
        group_by_column: regroupCol,
        title_column: viewConfig.kanban_config?.title_column,
        display_columns: viewConfig.kanban_config?.display_columns ?? [],
        column_options: chosen?.options ?? [],
        ...(viewConfig.kanban_config?.assignee_column
          ? { assignee_column: viewConfig.kanban_config.assignee_column }
          : {}),
      },
    }
    try {
      await workspace.createView(JSON.stringify(newConfig))
      setViewConfig(JSON.parse(workspace.getView(viewId)))
      setRegroupCol('')
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
    } catch (err) {
      setToast(`Could not update board: ${err instanceof Error ? err.message : String(err)}`)
      setTimeout(() => setToast(null), 4000)
    }
  }

  // Filter columns for the editor, and the type map the engine needs.
  const filterColumns: FilterColumnMeta[] = useMemo(
    () =>
      availableColumns.map(c => ({
        id: c.id,
        name: c.name,
        column_type: c.column_type ?? 'text',
        options: c.options,
        reference_table: (c as any).reference_table,
        reference_display_column: (c as any).reference_display_column,
      })),
    [availableColumns],
  )
  const columnsById = useMemo(
    () => Object.fromEntries(filterColumns.map(c => [c.id, { id: c.id, column_type: c.column_type }])),
    [filterColumns],
  )
  // Cards come from the filtered rows — `@me` resolves against this viewer, so
  // a shared "assigned to me" board is personal to whoever opens it.
  const filteredRows = useMemo(
    () => applyFilters(rows as Record<string, unknown>[], conditions, columnsById, { me }),
    [rows, conditions, columnsById, me],
  )

  /** Persist the current conditions into this view, leaving the rest of the
   *  config (name, sort, kanban_config) exactly as it was. */
  const saveFilters = async () => {
    if (!viewConfig || !viewId || !tableId) return
    const payload = {
      ...viewConfig,
      id: viewId,
      table_id: tableId,
      view_type: 'kanban',
      filters: conditions.map(c => ({
        column_id: c.columnId,
        operator: c.operator,
        value: c.value ?? null,
      })),
    }
    try {
      await workspace.createView(JSON.stringify(payload))
      setViewConfig(JSON.parse(workspace.getView(viewId)))
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      setToast('Filters saved to this board')
    } catch (err) {
      setToast(`Could not save filters: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTimeout(() => setToast(null), 3000)
  }

  /** Back to the view's saved filters (the grid's Reset, same semantics). */
  const resetFilters = () => {
    setConditions(
      (viewConfig?.filters ?? []).map((f: any) => ({
        columnId: f.column_id,
        operator: f.operator,
        value: f.value ?? undefined,
      })),
    )
  }

  /** Fork the current filters into a NEW board over the same table. */
  const saveAsView = async (name: string) => {
    if (!viewConfig || !tableId) return
    const id = globalThis.crypto?.randomUUID?.() ?? `view_${Date.now()}`
    const payload = {
      ...viewConfig,
      id,
      name,
      table_id: tableId,
      view_type: 'kanban',
      filters: conditions.map(c => ({
        column_id: c.columnId,
        operator: c.operator,
        value: c.value ?? null,
      })),
    }
    try {
      await workspace.createView(JSON.stringify(payload))
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      navigate(`/workspace/${workspaceId}/table/${tableId}/view/${id}`)
    } catch (err) {
      setToast(`Could not save view: ${err instanceof Error ? err.message : String(err)}`)
      setTimeout(() => setToast(null), 3000)
    }
  }

  const columns: KanbanColumn[] = useMemo(() => {
    if (!viewConfig?.kanban_config || !filteredRows) return []
    const { group_by_column, title_column, column_options } = viewConfig.kanban_config
    const groupMap = new Map<string, KanbanCard[]>()
    if (column_options?.length) {
      column_options.forEach((opt: string) => groupMap.set(opt, []))
    }
    filteredRows.forEach(row => {
      const groupValue = String(row[group_by_column] || 'Uncategorized')
      const card: KanbanCard = { id: String(row._row_id), title: String(row[title_column] || 'Untitled'), ...row }
      if (!groupMap.has(groupValue)) groupMap.set(groupValue, [])
      groupMap.get(groupValue)!.push(card)
    })
    return Array.from(groupMap.entries()).map(([groupValue, cards]) => ({
      id: groupValue,
      title: groupValue,
      cards,
    }))
  }, [filteredRows, viewConfig])

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id))

  const onSendError = (err: any) => {
    const msg = err?.message ?? String(err)
    if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('M_LIMIT_EXCEEDED')) {
      setToast('Rate limited — change will retry. Slow down a bit.')
    } else {
      setToast(`Update failed: ${msg}`)
    }
    setTimeout(() => setToast(null), 4000)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || !viewConfig?.kanban_config) { setActiveId(null); return }

    const activeCardId = String(active.id)
    const overId = String(over.id)
    let sourceColumn: KanbanColumn | undefined
    let cardData: KanbanCard | undefined

    for (const col of columns) {
      const card = col.cards.find(c => c.id === activeCardId)
      if (card) { sourceColumn = col; cardData = card; break }
    }

    if (!cardData || !sourceColumn) { setActiveId(null); return }

    const targetColumnId = resolveTargetColumn(overId, columns)
    if (!targetColumnId) { setActiveId(null); return }

    let changed = false

    // Drag to a different column → update the group-by cell.
    if (sourceColumn.id !== targetColumnId) {
      const { group_by_column } = viewConfig.kanban_config
      updateCell(activeCardId, group_by_column, targetColumnId).catch(onSendError)
      changed = true
    }

    // Dropped onto a specific card → write the row's `_order` key for the new
    // position. Kanban groups are slices of one global `_order`, so reusing the
    // global row order keeps the card between its target-column neighbours.
    const droppedOnCard =
      overId !== activeCardId && columns.some(c => c.cards.some(cc => cc.id === overId))
    if (droppedOnCard) {
      let keyMap: Record<string, string> = {}
      try {
        keyMap = JSON.parse(workspace.getRowOrderKeys?.(tableId!) ?? '{}')
      } catch {
        /* no keys yet — computeReorderWrites will backfill */
      }
      const globalRows = rows.map(r => ({ id: r._row_id, key: keyMap[r._row_id] ?? null }))
      const writes = computeReorderWrites(globalRows, activeCardId, overId)
      for (const w of writes) updateCell(w.id, '_order', w.key).catch(onSendError)
      if (writes.length) changed = true
    }

    if (changed) refresh()
    setActiveId(null)
  }

  if (!tableId || !viewId) {
    return <div className="kanban-view"><div className="state-empty"><p>No view selected</p></div></div>
  }

  if (loading || (!viewConfig && !viewError)) {
    return (
      <div className="kanban-view">
        <Toolbar title="Kanban" />
        <div className="state-empty">Loading...</div>
      </div>
    )
  }

  if (error || viewError) {
    const msg = (error || viewError)!.message
    return (
      <div className="kanban-view">
        <Toolbar title="Kanban" />
        <div className="state-error"><h3>Error loading view</h3><p>{msg}</p></div>
      </div>
    )
  }

  const activeCard = activeId ? columns.flatMap(c => c.cards).find(c => c.id === activeId) : null

  return (
    <div className="kanban-view">
      <Toolbar
        title={viewConfig.name}
        actions={
          <>
            <ToolbarButton
              icon={<FilterIcon />}
              label="Filter"
              active={showFilter}
              onClick={() => setShowFilter(s => !s)}
            />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarButton
              icon={<GearIcon />}
              label="Settings"
              active={showSettings}
              onClick={() => setShowSettings(true)}
              title="View settings"
            />
            <ToolbarPrimaryButton onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`)}>New entry</ToolbarPrimaryButton>
          </>
        }
      />

      {showSettings && viewId && tableId && (
        <ViewSettingsModal
          workspace={workspace}
          tableId={tableId}
          viewId={viewId}
          viewConfig={viewConfig}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false)
            try {
              setViewConfig(JSON.parse(workspace.getView(viewId)))
            } catch {
              /* keep the current config; the next sync refreshes it */
            }
            if (workspaceId) notifyWorkspaceChanged(workspaceId)
          }}
        />
      )}

      {showFilter && (
        <FilterPanel
          columns={filterColumns}
          conditions={conditions}
          onChange={setConditions}
          members={members}
          lookup={referenceLookup}
          count={{ shown: filteredRows.length, total: rows.length, noun: 'card' }}
          onReset={conditions.length > 0 ? resetFilters : undefined}
          loadedViewName={viewConfig?.name ?? null}
          onSaveView={saveFilters}
          onSaveAsView={saveAsView}
        />
      )}

      {/* Invalid settings block the board (issue cc70fdc5): grouping by a
          deleted column would render a meaningless single-lane board, so the
          re-edit prompt replaces it until a valid group-by is chosen. */}
      {groupByMissing ? (
        <div className="kanban-reconfig" role="alert">
          <div className="kanban-reconfig__msg">
            This board groups by <strong>{String(groupByColumn)}</strong>, which no longer exists.
            Pick a select column to group by:
          </div>
          {regroupColumns.length === 0 ? (
            <div className="kanban-reconfig__msg">
              No select columns in this table — add a Select column first.
            </div>
          ) : (
            <div className="kanban-reconfig__actions">
              <select
                className="kanban-reconfig__select"
                value={regroupCol}
                onChange={e => setRegroupCol(e.target.value)}
              >
                <option value="">Choose a column…</option>
                {regroupColumns.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button className="primary" disabled={!regroupCol} onClick={handleRegroup}>
                Use this column
              </button>
            </div>
          )}
        </div>
      ) : (
      <div className="kanban-board-wrap">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="kanban-board">
            {columns.map(column => (
              <div key={column.id} className="kcol">
                {/* Column header */}
                <div className="kcol__header">
                  <span
                    className="kcol__dot"
                    style={{ background: statusColor(column.title) }}
                  />
                  <span className="kcol__title">{column.title}</span>
                  <span className="kcol__count">{column.cards.length}</span>
                </div>

                {/* Cards — wrapped in DroppableColumn so empty columns accept drops */}
                <DroppableColumn column={column}>
                  <SortableContext
                    items={column.cards.map(c => c.id)}
                    strategy={verticalListSortingStrategy}
                    id={column.id}
                  >
                    <div className="kcol__cards">
                      {column.cards.map(card => (
                        <SortableCard
                          key={card.id}
                          card={card}
                          hiddenKeys={deletedCols}
                          person={personFor(card)}
                          onOpen={(c) => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/${c._row_id ?? c.id}`, { state: { from: location.pathname } })}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DroppableColumn>

                {/* Add entry — pre-fills status column via query param */}
                <button
                  className="kcol__add"
                  onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new?status=${encodeURIComponent(column.id)}`, { state: { from: location.pathname } })}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <line x1="6" y1="1.5" x2="6" y2="10.5" />
                    <line x1="1.5" y1="6" x2="10.5" y2="6" />
                  </svg>
                  Add entry
                </button>
              </div>
            ))}
          </div>

          <DragOverlay>
            {activeCard ? (
              <div className="kcard kcard--dragging">
                <div className="kcard__title">{activeCard.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      )}

      {toast && (
        <div className="kanban-toast" role="alert">
          {toast}
          <button className="kanban-toast__close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
    </div>
  )
}
