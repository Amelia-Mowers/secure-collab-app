import { useParams, useNavigate } from 'react-router-dom'
import { useTable } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import './CardView.css'

interface CardViewProps {
  workspace: any
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

export function CardView({ workspace }: CardViewProps) {
  const { tableId } = useParams<{ tableId: string }>()
  const navigate = useNavigate()
  const { rows, loading, error } = useTable(workspace, tableId!)

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
  const titleKey = keys[0]
  const previewKey = keys[1]
  const statusKey = keys.find(k => k.toLowerCase().includes('status'))
  const assigneeKey = keys.find(k => k.toLowerCase().includes('assign'))

  return (
    <div className="card-view">
      <Toolbar
        title="Card View"
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />} label="Filter" />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarPrimaryButton onClick={() => navigate(`/table/${tableId}/entry/new`)}>
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
            const assigneeVal = assigneeKey ? String(row[assigneeKey] ?? '') : null

            return (
              <div
                key={row._row_id}
                className="entry-card"
                onClick={() => navigate(`/table/${tableId}/entry/${row._row_id}`)}
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

                {/* Preview text */}
                {preview && (
                  <div className="entry-card__preview">{String(preview)}</div>
                )}

                {/* Extra fields */}
                <div className="entry-card__fields">
                  {keys
                    .filter(k => k !== titleKey && k !== previewKey && k !== statusKey && k !== assigneeKey)
                    .slice(0, 2)
                    .map(k => (
                      <div key={k} className="entry-card__field">
                        <span className="entry-card__field-label">{k}</span>
                        <span className="entry-card__field-value">{String(row[k] ?? '')}</span>
                      </div>
                    ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
