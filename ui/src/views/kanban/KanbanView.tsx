import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
import { useTable } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import { resolveTargetColumn } from './kanbanUtils'
import './KanbanView.css'

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

function SortableCard({ card, onOpen }: { card: KanbanCard; onOpen: (card: KanbanCard) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const extraFields = Object.entries(card).filter(
    ([k]) => k !== 'id' && k !== 'title' && k !== '_row_id' && k !== 'status'
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
      {card.assignee && (
        <div className="kcard__footer">
          <Avatar name={String(card.assignee)} />
          <span className="kcard__assignee">{String(card.assignee)}</span>
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
  const { rows, loading, error, updateCell } = useTable(workspace, tableId!, workspaceId, syncCount)
  const [viewConfig, setViewConfig] = useState<any>(null)
  const [viewError, setViewError] = useState<Error | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    if (workspace && viewId) {
      try {
        setViewConfig(JSON.parse(workspace.getView(viewId)))
        setViewError(null)
      } catch (err) {
        console.error('Failed to load view config:', err)
        setViewError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }, [workspace, viewId])

  const columns: KanbanColumn[] = useMemo(() => {
    if (!viewConfig?.kanban_config || !rows) return []
    const { group_by_column, title_column, column_options } = viewConfig.kanban_config
    const groupMap = new Map<string, KanbanCard[]>()
    if (column_options?.length) {
      column_options.forEach((opt: string) => groupMap.set(opt, []))
    }
    rows.forEach(row => {
      const groupValue = String(row[group_by_column] || 'Uncategorized')
      const card: KanbanCard = { id: row._row_id, title: String(row[title_column] || 'Untitled'), ...row }
      if (!groupMap.has(groupValue)) groupMap.set(groupValue, [])
      groupMap.get(groupValue)!.push(card)
    })
    return Array.from(groupMap.entries()).map(([groupValue, cards]) => ({
      id: groupValue,
      title: groupValue,
      cards,
    }))
  }, [rows, viewConfig])

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id))

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

    if (sourceColumn.id !== targetColumnId) {
      const { group_by_column } = viewConfig.kanban_config
      updateCell(cardData.id, group_by_column, targetColumnId)
        .catch(err => {
          const msg = err?.message ?? String(err)
          if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('M_LIMIT_EXCEEDED')) {
            setToast('Rate limited — change will retry. Slow down a bit.')
          } else {
            setToast(`Update failed: ${msg}`)
          }
          setTimeout(() => setToast(null), 4000)
        })
    }
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
            <ToolbarButton icon={<FilterIcon />} label="Filter" />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarPrimaryButton onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`)}>New entry</ToolbarPrimaryButton>
          </>
        }
      />

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
                          onOpen={(c) => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/${c._row_id ?? c.id}`)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DroppableColumn>

                {/* Add entry — pre-fills status column via query param */}
                <button
                  className="kcol__add"
                  onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new?status=${encodeURIComponent(column.id)}`)}
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

      {toast && (
        <div className="kanban-toast" role="alert">
          {toast}
          <button className="kanban-toast__close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
    </div>
  )
}
