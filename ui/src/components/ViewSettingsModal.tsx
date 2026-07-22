import { useState } from 'react'
import {
  KanbanConfigFields,
  loadTableColumns,
  type KanbanConfig,
} from './NewViewDropdown'
import './NewViewDropdown.css'

/**
 * Edit an existing view's settings after creation (issue b6b15052): the name
 * for every view type, plus the kanban group-by / card-title columns. Saving
 * upserts via `createView` with the SAME view id (the `_views` table is LWW
 * per cell), so nothing references a new id and other clients converge.
 */
export interface ViewSettingsModalProps {
  workspace: any
  tableId: string
  viewId: string
  /** The parsed current view config (from `workspace.getView`). */
  viewConfig: any
  onSaved: () => void
  onClose: () => void
}

export function ViewSettingsModal({
  workspace,
  tableId,
  viewId,
  viewConfig,
  onSaved,
  onClose,
}: ViewSettingsModalProps) {
  const columns = loadTableColumns(workspace, tableId)
  const isKanban = viewConfig.view_type === 'kanban'
  const [name, setName] = useState<string>(viewConfig.name ?? '')
  const [kanban, setKanban] = useState<KanbanConfig>({
    groupByColumn: viewConfig.kanban_config?.group_by_column ?? '',
    titleColumn: viewConfig.kanban_config?.title_column ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const canSave =
    !!name.trim() && (!isKanban || (!!kanban.groupByColumn && !!kanban.titleColumn))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave || saving) return
    setError(null)
    setSaving(true)
    try {
      const next: any = {
        id: viewId,
        name: name.trim(),
        table_id: tableId,
        view_type: viewConfig.view_type,
        sort: viewConfig.sort ?? [],
        filters: viewConfig.filters ?? [],
      }
      if (isKanban) {
        // column_options track the (possibly new) group-by column's schema
        // options, same as at creation.
        const groupByCol = columns.find(c => c.id === kanban.groupByColumn)
        next.kanban_config = {
          group_by_column: kanban.groupByColumn,
          title_column: kanban.titleColumn,
          display_columns: viewConfig.kanban_config?.display_columns ?? [],
          column_options: groupByCol?.options ?? [],
        }
      }
      await workspace.createView(JSON.stringify(next))
      onSaved()
    } catch (err) {
      // The WASM bridge rejects with plain-string JsValues, not Error objects.
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal nvm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="nvm__header">
          <h2 className="nvm__title">View settings</h2>
          <button className="nvm__close ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="nvm__form-group">
            <label className="nvm__label">View name</label>
            <input
              className="nvm__input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="View name"
            />
          </div>

          {isKanban && (
            <KanbanConfigFields columns={columns} config={kanban} onChange={setKanban} />
          )}

          {error && <p className="nvm__error" role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSave || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
