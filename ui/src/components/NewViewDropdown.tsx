import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { notifyWorkspaceChanged } from '@/hooks/useTable'
import './NewViewDropdown.css'

// ── View type icons ────────────────────────────────────────────
const TableIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
    <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" />
    <line x1="5.5" y1="5.5" x2="5.5" y2="12.5" />
  </svg>
)

const KanbanIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1" y="2" width="3" height="9" rx="1" />
    <rect x="5.5" y="2" width="3" height="6" rx="1" />
    <rect x="10" y="2" width="3" height="10" rx="1" />
  </svg>
)

const CardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1" y="1" width="5" height="5.5" rx="1.5" />
    <rect x="8" y="1" width="5" height="5.5" rx="1.5" />
    <rect x="1" y="8" width="5" height="5" rx="1.5" />
    <rect x="8" y="8" width="5" height="5" rx="1.5" />
  </svg>
)

const CalendarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" />
    <line x1="1.5" y1="6" x2="12.5" y2="6" />
    <line x1="4.5" y1="1" x2="4.5" y2="4" />
    <line x1="9.5" y1="1" x2="9.5" y2="4" />
  </svg>
)

const PlusIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="5" y1="1.5" x2="5" y2="8.5" />
    <line x1="1.5" y1="5" x2="8.5" y2="5" />
  </svg>
)

// ── Types ──────────────────────────────────────────────────────
export type ViewType = 'table' | 'kanban' | 'card' | 'calendar'

interface ColumnMeta {
  id: string
  name: string
  column_type: string
  options?: string[]
}

interface TableInfo {
  id: string
  name: string
}

interface ViewTypeOption {
  type: ViewType
  label: string
  description: string
  icon: React.ReactNode
  stub?: boolean
}

const VIEW_TYPE_OPTIONS: ViewTypeOption[] = [
  {
    type: 'table',
    label: 'Table',
    description: 'Spreadsheet-style grid view',
    icon: <TableIcon />,
  },
  {
    type: 'kanban',
    label: 'Kanban',
    description: 'Group rows into columns by status',
    icon: <KanbanIcon />,
  },
  {
    type: 'card',
    label: 'Card',
    description: 'Gallery of card tiles',
    icon: <CardIcon />,
  },
  {
    type: 'calendar',
    label: 'Calendar',
    description: 'Coming soon',
    icon: <CalendarIcon />,
    stub: true,
  },
]

// ── KanbanConfigFields ─────────────────────────────────────────
interface KanbanConfig {
  groupByColumn: string
  titleColumn: string
}

interface KanbanConfigFieldsProps {
  columns: ColumnMeta[]
  config: KanbanConfig
  onChange: (c: KanbanConfig) => void
}

function KanbanConfigFields({ columns, config, onChange }: KanbanConfigFieldsProps) {
  // Only select/multiselect columns can serve as the "group by" axis
  const selectColumns = columns.filter(
    col => col.column_type === 'select' || col.column_type === 'multiselect',
  )

  // Preview the options that will be used as kanban columns
  const selectedCol = selectColumns.find(c => c.id === config.groupByColumn)
  const previewOptions = selectedCol?.options ?? []

  return (
    <>
      <div className="nvm__form-group">
        <label className="nvm__label">Group by column <span className="nvm__hint">(select columns only)</span></label>
        {selectColumns.length === 0 ? (
          <p className="nvm__hint nvm__hint--warn">
            No select columns in this table. Add a Select column first.
          </p>
        ) : (
          <select
            className="nvm__select"
            value={config.groupByColumn}
            onChange={e => onChange({ ...config, groupByColumn: e.target.value })}
          >
            <option value="">Choose a column...</option>
            {selectColumns.map(col => (
              <option key={col.id} value={col.id}>{col.name}</option>
            ))}
          </select>
        )}
        {/* Show derived column options as a read-only preview */}
        {previewOptions.length > 0 && (
          <div className="nvm__option-preview">
            {previewOptions.map(opt => (
              <span key={opt} className="nvm__option-chip">{opt}</span>
            ))}
          </div>
        )}
      </div>
      <div className="nvm__form-group">
        <label className="nvm__label">Card title column</label>
        <select
          className="nvm__select"
          value={config.titleColumn}
          onChange={e => onChange({ ...config, titleColumn: e.target.value })}
        >
          <option value="">Choose a column...</option>
          {columns.map(col => (
            <option key={col.id} value={col.id}>{col.name}</option>
          ))}
        </select>
      </div>
    </>
  )
}

// ── NewViewModal ───────────────────────────────────────────────
export interface NewViewModalProps {
  /** If provided, the table selector is pre-set and hidden */
  initialTableId?: string
  workspace: any
  onCreated: (viewId: string, viewType: ViewType, tableId: string) => void
  onClose: () => void
}

function loadTableColumns(workspace: any, tableId: string): ColumnMeta[] {
  try {
    const schema = JSON.parse(workspace.getTableSchema(tableId))
    if (!schema?.columns) return []
    return Object.values(schema.columns as Record<string, any>).map((col: any) => ({
      id: col.id,
      name: col.name || col.id,
      column_type: col.column_type || 'text',
      options: col.options,
    }))
  } catch {
    return []
  }
}

function loadTables(workspace: any): TableInfo[] {
  try {
    const ids = JSON.parse(workspace.listTables()) as string[]
    return ids.map(id => {
      try {
        const schema = JSON.parse(workspace.getTableSchema(id))
        return { id, name: schema.name || id }
      } catch {
        return { id, name: id }
      }
    })
  } catch {
    return []
  }
}

export function NewViewModal({ initialTableId, workspace, onCreated, onClose }: NewViewModalProps) {
  const tables = workspace ? loadTables(workspace) : []

  const [selectedTableId, setSelectedTableId] = useState(initialTableId ?? tables[0]?.id ?? '')
  const [columns, setColumns] = useState<ColumnMeta[]>([])
  const [viewType, setViewType] = useState<ViewType>('kanban')
  const [viewName, setViewName] = useState('')
  const [kanbanConfig, setKanbanConfig] = useState<KanbanConfig>({
    groupByColumn: '',
    titleColumn: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Load columns whenever the selected table changes
  useEffect(() => {
    if (workspace && selectedTableId) {
      const cols = loadTableColumns(workspace, selectedTableId)
      setColumns(cols)
      // Reset kanban config when table changes
      setKanbanConfig({ groupByColumn: '', titleColumn: '' })
    } else {
      setColumns([])
    }
  }, [workspace, selectedTableId])

  const canSubmit = (() => {
    if (!viewName.trim()) return false
    if (!selectedTableId) return false
    if (viewType === 'kanban') {
      return !!kanbanConfig.groupByColumn && !!kanbanConfig.titleColumn
    }
    return true
  })()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || creating) return
    setError(null)
    setCreating(true)

    try {
      const viewId = `${selectedTableId}-${viewName.trim().toLowerCase().replace(/\s+/g, '-')}`

      if (viewType === 'kanban') {
        // Derive column_options from the group-by column's schema options
        const groupByCol = columns.find(c => c.id === kanbanConfig.groupByColumn)
        const columnOptions = groupByCol?.options ?? []

        await workspace.createView(JSON.stringify({
          id: viewId,
          name: viewName.trim(),
          table_id: selectedTableId,
          view_type: 'kanban',
          sort: [],
          filters: [],
          kanban_config: {
            group_by_column: kanbanConfig.groupByColumn,
            title_column: kanbanConfig.titleColumn,
            display_columns: [],
            column_options: columnOptions,
          },
        }))
      } else if (viewType === 'card') {
        await workspace.createView(JSON.stringify({
          id: viewId,
          name: viewName.trim(),
          table_id: selectedTableId,
          view_type: 'card',
          sort: [],
          filters: [],
        }))
      } else if (viewType === 'table') {
        await workspace.createView(JSON.stringify({
          id: viewId,
          name: viewName.trim(),
          table_id: selectedTableId,
          view_type: 'table',
          sort: [],
          filters: [],
        }))
      }

      onCreated(viewId, viewType, selectedTableId)
    } catch (err) {
      // The WASM bridge rejects with plain-string JsValues, not Error objects.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal nvm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="nvm__header">
          <h2 className="nvm__title">New view</h2>
          <button className="nvm__close ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Table selector — shown when opened from the sidebar (no pre-selected table) */}
          {!initialTableId && (
            <div className="nvm__form-group">
              <label className="nvm__label">Table</label>
              {tables.length === 0 ? (
                <p className="nvm__hint nvm__hint--warn">No tables yet. Create a table first.</p>
              ) : (
                <select
                  className="nvm__select"
                  value={selectedTableId}
                  onChange={e => setSelectedTableId(e.target.value)}
                >
                  <option value="">Choose a table...</option>
                  {tables.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* View name */}
          <div className="nvm__form-group">
            <label className="nvm__label">View name</label>
            <input
              className="nvm__input"
              type="text"
              value={viewName}
              onChange={e => setViewName(e.target.value)}
              placeholder="My View"
              autoFocus
            />
          </div>

          {/* View type picker */}
          <div className="nvm__form-group">
            <label className="nvm__label">View type</label>
            <div className="nvm__type-grid">
              {VIEW_TYPE_OPTIONS.map(opt => (
                <button
                  key={opt.type}
                  type="button"
                  className={`nvm__type-tile ${viewType === opt.type ? 'nvm__type-tile--active' : ''} ${opt.stub ? 'nvm__type-tile--stub' : ''}`}
                  onClick={() => { if (!opt.stub) setViewType(opt.type) }}
                  disabled={opt.stub}
                  title={opt.stub ? opt.description : undefined}
                >
                  <span className="nvm__type-icon">{opt.icon}</span>
                  <span className="nvm__type-label">{opt.label}</span>
                  {opt.stub && <span className="nvm__type-soon">Soon</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Type-specific config */}
          {viewType === 'kanban' && selectedTableId && (
            <KanbanConfigFields
              columns={columns}
              config={kanbanConfig}
              onChange={setKanbanConfig}
            />
          )}

          {error && <p className="nvm__error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={creating}>Cancel</button>
            <button type="submit" className="primary" disabled={!canSubmit || creating}>
              {creating ? 'Creating...' : 'Create view'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── NewViewButton ──────────────────────────────────────────────
// Standalone button + modal for the Sidebar (no pre-selected table)
interface NewViewButtonProps {
  workspace: any
  workspaceId: string
  onCreated?: (viewId: string, viewType: ViewType, tableId: string) => void
}

export function NewViewButton({ workspace, workspaceId, onCreated }: NewViewButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const navigate = useNavigate()

  const handleCreated = (viewId: string, viewType: ViewType, tableId: string) => {
    setIsOpen(false)
    onCreated?.(viewId, viewType, tableId)
    notifyWorkspaceChanged(workspaceId)
    if (viewType === 'table') {
      navigate(`/workspace/${workspaceId}/table/${tableId}`)
    } else {
      navigate(`/workspace/${workspaceId}/table/${tableId}/view/${viewId}`)
    }
  }

  return (
    <>
      <button
        className="sidebar__item sidebar__item--add"
        onClick={() => setIsOpen(true)}
      >
        <PlusIcon />
        <span>New view</span>
      </button>

      {isOpen && (
        <NewViewModal
          workspace={workspace}
          onCreated={handleCreated}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
