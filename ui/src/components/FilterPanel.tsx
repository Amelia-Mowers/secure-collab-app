import { useState, type ReactNode } from 'react'
import { FilterBar, type FilterColumnMeta, type FilterMember } from '@/views/table/FilterBar'
import type { FilterCondition } from '@/lib/filters'
import type { ReferenceLookup } from '@/lib/referenceLookup'
import './FilterPanel.css'

/**
 * The filter panel — one implementation shared by every view that filters
 * (table grid, kanban board). Filtering a board and filtering a grid are the
 * same task, so they get the same controls in the same places: a result count,
 * Reset, the stacked per-column conditions, and the save-into-a-view actions.
 *
 * What differs per view is only what the view alone knows: whether there's a
 * free-text search across cells (the grid has one, a board doesn't) and how to
 * serialize itself into a view config — hence `search` and `buildViewPayload`.
 */
export interface FilterPanelProps {
  columns: FilterColumnMeta[]
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
  /** Room members — member columns offer these plus "Me". */
  members?: FilterMember[]
  /** Resolves referenced rows so reference columns filter by row, not id. */
  lookup?: ReferenceLookup
  /** Free-text search across all cells. Omit for views that don't have one. */
  search?: { value: string; onChange: (value: string) => void; placeholder?: string }
  /** Result count. `total` renders "N of M"; omit it for a plain "N". */
  count: { shown: number; total?: number; noun: string }
  /** Clear ad-hoc filters (back to the view's saved ones). Omit to hide. */
  onReset?: () => void
  /** Name of the saved view being edited, for the "Save view" affordance. */
  loadedViewName?: string | null
  /** Persist the current filters into the open view. */
  onSaveView?: () => void
  /** Fork the current filters into a new view under this name. */
  onSaveAsView?: (name: string) => void
  /** Extra controls, appended to the action row. */
  actions?: ReactNode
}

export function FilterPanel({
  columns,
  conditions,
  onChange,
  members,
  lookup,
  search,
  count,
  onReset,
  loadedViewName,
  onSaveView,
  onSaveAsView,
  actions,
}: FilterPanelProps) {
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')

  const plural = count.shown === 1 ? '' : 's'
  const countText =
    count.total != null && count.total !== count.shown
      ? `${count.shown} of ${count.total} ${count.noun}${count.total === 1 ? '' : 's'}`
      : `${count.shown} ${count.noun}${plural}`

  const submitName = () => {
    const name = newName.trim()
    if (!name || !onSaveAsView) return
    onSaveAsView(name)
    setNaming(false)
  }

  return (
    <div className="filter-panel">
      <div className="filter-panel__row">
        {search && (
          <input
            className="filter-panel__input"
            placeholder={search.placeholder ?? 'Search all columns…'}
            value={search.value}
            onChange={e => search.onChange(e.target.value)}
          />
        )}
        <span className="filter-panel__count">{countText}</span>
        {onReset && (
          <button
            className="ghost filter-panel__clear"
            onClick={onReset}
            title={loadedViewName ? 'Reset to this view’s saved filters' : 'Clear all filters'}
          >
            Reset
          </button>
        )}
      </div>

      <FilterBar
        columns={columns}
        conditions={conditions}
        onChange={onChange}
        members={members}
        lookup={lookup}
      />

      <div className="filter-panel__actions">
        {/* Filters are ephemeral until saved: tweak freely, then either commit
            to this view ("Save view") or fork a new one. */}
        {loadedViewName && onSaveView && (
          <button className="ghost" onClick={onSaveView} title={`Update “${loadedViewName}”`}>
            Save view
          </button>
        )}
        {onSaveAsView &&
          (!naming ? (
            <button
              className="ghost"
              onClick={() => {
                setNewName('')
                setNaming(true)
              }}
            >
              {loadedViewName ? 'Save as separate view' : 'Save view'}
            </button>
          ) : (
            <span className="filter-panel__save-as">
              <input
                className="filter-panel__input"
                placeholder="View name"
                value={newName}
                autoFocus
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitName()
                }}
              />
              <button className="ghost" onClick={submitName} disabled={!newName.trim()}>
                Save
              </button>
              <button className="ghost" onClick={() => setNaming(false)}>
                Cancel
              </button>
            </span>
          ))}
        {actions}
      </div>
    </div>
  )
}
