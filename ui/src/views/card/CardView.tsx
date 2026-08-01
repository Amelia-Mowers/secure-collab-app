import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTable, useMembers } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import { CellDisplay, memberLabel, type CellColumn } from '@/cells/cellRegistry'
import { makeReferenceLookup } from '@/lib/referenceLookup'
import './CardView.css'

interface CardViewProps {
  workspace: any
  syncCount?: number
}

// Pick a colour for the status badge
function statusClass(value: string): string {
  const lc = (value ?? '').toLowerCase()
  if (lc === 'done' || lc === 'complete' || lc === 'completed') return 'card-badge card-badge--green'
  if (lc.includes('progress')) return 'card-badge card-badge--accent'
  if (lc === 'blocked' || lc === 'error') return 'card-badge card-badge--red'
  return 'card-badge card-badge--neutral'
}

function avatarColor(str: string): string {
  const palette = ['#6d9fff', '#a78bfa', '#f472b6', '#4ade80', '#f59e0b', '#f87171']
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff
  return palette[h % palette.length]
}

export function CardView({ workspace, syncCount }: CardViewProps) {
  const { workspaceId, tableId } = useParams<{ workspaceId: string; tableId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { rows, loading, error } = useTable(workspace, tableId!, workspaceId, syncCount)

  // Schema, members and reference labels — everything the shared cell registry
  // needs. Declared BEFORE the early returns below, because hooks cannot be
  // called conditionally.
  const [schema, setSchema] = useState<any>(null)
  useEffect(() => {
    if (workspace && tableId) {
      try {
        setSchema(JSON.parse(workspace.getTableSchema(tableId)))
      } catch {
        /* keep prior */
      }
    }
  }, [workspace, tableId, syncCount])

  const members = useMembers(workspace)
  const referenceLookup = useMemo(() => makeReferenceLookup(workspace), [workspace])

  /** Schema by column id, minus columns deleted under the decay model whose
   *  values still linger in row data. */
  const columnsById = useMemo(() => {
    const deleted = new Set<string>(schema?.deleted_columns ?? [])
    const cols = schema?.columns ? (Object.values(schema.columns) as CellColumn[]) : []
    return new Map(cols.filter(c => !deleted.has(c.id)).map(c => [c.id, c]))
  }, [schema])

  if (!tableId) {
    return <div className="card-view"><div className="state-empty"><p>No table selected</p></div></div>
  }

  if (loading) {
    return (
      <div className="card-view">
        <Toolbar title="Cards" />
        <div className="state-empty">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card-view">
        <Toolbar title="Cards" />
        <div className="state-error"><h3>Error</h3><p>{error.message}</p></div>
      </div>
    )
  }

  // Derive visible column names (exclude internal _row_id)
  const allKeys = new Set<string>()
  rows.forEach(r => Object.keys(r).forEach(k => { if (k !== '_row_id') allKeys.add(k) }))
  const keys = Array.from(allKeys).sort()

  // Title and preview by TYPE, not by alphabetical position. `keys[0]` picked
  // whatever sorted first — on the demo's Projects table that was `assignee`
  // for the title and `client` for the preview, so every card was headed
  // "Untitled" above a raw row id. A title wants text; a preview wants prose.
  const typed = (k: string) => columnsById.get(k)?.column_type
  const titleKey = keys.find(k => typed(k) === 'text') ?? keys[0]
  const previewKey =
    keys.find(k => k !== titleKey && typed(k) === 'document') ??
    keys.find(k => k !== titleKey && typed(k) === 'text')
  const statusKey = keys.find(k => typed(k) === 'select') ?? keys.find(k => k.toLowerCase().includes('status'))
  const assigneeKey = keys.find(k => typed(k) === 'member') ?? keys.find(k => k.toLowerCase().includes('assign'))

  return (
    <div className="card-view">
      <Toolbar
        title="Card View"
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />} label="Filter" />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarPrimaryButton onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`, { state: { from: location.pathname } })}>
              New entry
            </ToolbarPrimaryButton>
          </>
        }
      />

      <div className="card-view__content">
        {rows.length === 0 && (
          <div className="state-empty">
            <p>No entries yet</p>
          </div>
        )}

        <div className="card-grid">
          {rows.map(row => {
            const title = titleKey ? (row[titleKey] ?? 'Untitled') : row._row_id
            const preview = previewKey ? (row[previewKey] ?? '') : ''
            const statusVal = statusKey ? row[statusKey] : null
            // Resolve to a display name: the avatar letter and its tooltip both
            // came from a raw MXID otherwise.
            const assigneeRaw = assigneeKey ? String(row[assigneeKey] ?? '') : ''
            const assigneeVal = assigneeRaw ? memberLabel(members, assigneeRaw) : null

            return (
              <div
                key={row._row_id}
                className="entry-card"
                onClick={() => navigate(`/workspace/${workspaceId}/table/${tableId}/entry/${row._row_id}`, { state: { from: location.pathname } })}
              >
                {/* Top row: status + assignee */}
                <div className="entry-card__top">
                  {statusVal && <span className={statusClass(String(statusVal))}>{statusVal}</span>}
                  <div style={{ flex: 1 }} />
                  {assigneeVal && (
                    <span
                      className="entry-card__avatar"
                      style={{ background: avatarColor(assigneeVal) }}
                      title={assigneeVal}
                    >
                      {assigneeVal[0]?.toUpperCase()}
                    </span>
                  )}
                </div>

                {/* Title */}
                <div className="entry-card__title">{String(title)}</div>

                {/* Preview text — through the registry so a document renders
                    as its one-line preview rather than raw markdown. */}
                {preview !== '' && preview != null && (
                  <div className="entry-card__preview">
                    {previewKey && columnsById.has(previewKey) ? (
                      <CellDisplay
                        column={columnsById.get(previewKey)!}
                        value={preview}
                        lookup={referenceLookup}
                        members={members}
                      />
                    ) : (
                      String(preview)
                    )}
                  </div>
                )}

                {/* Extra fields */}
                <div className="entry-card__fields">
                  {keys
                    .filter(k => k !== titleKey && k !== previewKey && k !== statusKey && k !== assigneeKey)
                    .slice(0, 2)
                    .map(k => {
                      // Same registry as the grid and entry view — hand-rolling
                      // this is what printed raw row ids and ISO dates.
                      const column = columnsById.get(k)
                      return (
                        <div key={k} className="entry-card__field">
                          <span className="entry-card__field-label">{column?.name ?? k}</span>
                          <span className="entry-card__field-value">
                            {column ? (
                              <CellDisplay
                                column={column}
                                value={row[k]}
                                lookup={referenceLookup}
                                members={members}
                              />
                            ) : (
                              String(row[k] ?? '')
                            )}
                          </span>
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
