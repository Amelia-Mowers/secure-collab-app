import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { FieldRenderer } from './FieldRenderer'
import { useMembers } from '@/hooks/useTable'
import './EntryView.css'

interface EntryViewProps {
  workspace: any | null
  syncCount?: number
}

interface Column {
  id: string
  name: string
  column_type: string
  required: boolean
}

interface TableSchema {
  id: string
  name: string
  columns: Record<string, Column>
}

interface Comment {
  id: string
  author: string
  authorColor: string
  text: string
  timestamp: string
}

const ChevronRightIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="4,1.5 7.5,5.5 4,9.5" />
  </svg>
)

const CommentIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M1.5 2.5h10a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H4.5L1.5 12V3a.5.5 0 01.5-.5z" />
  </svg>
)

function avatarColor(name: string): string {
  const palette = ['#6d9fff', '#a78bfa', '#f472b6', '#4ade80', '#f59e0b', '#f87171']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff
  return palette[h % palette.length]
}

function CommentBubble({ comment }: { comment: Comment }) {
  const color = comment.authorColor || avatarColor(comment.author)
  return (
    <div className="comment">
      <div className="comment__header">
        <span className="comment__avatar" style={{ background: color }}>
          {comment.author[0]?.toUpperCase()}
        </span>
        <span className="comment__author">{comment.author}</span>
        <span className="comment__time">{comment.timestamp}</span>
      </div>
      <div className="comment__body">{comment.text}</div>
    </div>
  )
}

export function EntryView({ workspace, syncCount }: EntryViewProps) {
  const { workspaceId, tableId, rowId } = useParams<{ workspaceId: string; tableId: string; rowId: string }>()
  const members = useMembers(workspace)
  const navigate = useNavigate()
  const location = useLocation()

  // Entry counter + originating view carried through navigation state. `from` is
  // the path of the view that opened this entry (table / kanban / card) so the
  // back action returns there instead of always the default table.
  const locationState = (location.state as { entryCount?: number; from?: string } | null) ?? {}
  const [entryCount] = useState<number>(locationState.entryCount ?? 0)

  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [rowData, setRowData] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stable row ID for new entries — created on first keystroke, never changes URL
  const stableRowId = useRef<string>(rowId && rowId !== 'new' ? rowId : `row_${Date.now()}`)
  // Whether a new entry's row has been persisted yet — gates flushing prefilled
  // column defaults alongside the first user write (rows are created lazily).
  const establishedRef = useRef(!!rowId && rowId !== 'new')
  // Comments are local-only for now (no WASM storage yet)
  const [comments] = useState<Comment[]>([])
  const [commentDraft, setCommentDraft] = useState('')

  useEffect(() => {
    if (!workspace || !tableId) { setLoading(false); return }
    try {
      const parsedSchema = JSON.parse(workspace.getTableSchema(tableId))
      setSchema(parsedSchema)
      if (rowId && rowId !== 'new') {
        const rows = JSON.parse(workspace.getTableRows(tableId))
        const row = rows.find((r: any) => r._row_id === rowId)
        if (row) setRowData(row)
      } else {
        // New entry: prefill column defaults (e.g. a single-select starts on its
        // first option) so the form isn't blank. Persisted on the first write —
        // see handleFieldChange.
        const defaults: Record<string, any> = {}
        for (const col of Object.values(parsedSchema.columns ?? {}) as any[]) {
          if (col.default_value !== undefined && col.default_value !== null) {
            defaults[col.id] = col.default_value
          }
        }
        if (Object.keys(defaults).length > 0) setRowData(defaults)
      }
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setLoading(false)
    }
  }, [workspace, tableId, rowId])

  // Re-read row data and schema when syncCount changes (remote changes already applied in WASM)
  useEffect(() => {
    if (syncCount === undefined || syncCount === 0) return
    if (!workspace || !tableId) return
    try {
      // Re-read schema (e.g. new columns added from another tab)
      const parsedSchema = JSON.parse(workspace.getTableSchema(tableId))
      setSchema(parsedSchema)

      // Re-read row data for existing entries
      if (rowId && rowId !== 'new') {
        const rows = JSON.parse(workspace.getTableRows(tableId))
        const row = rows.find((r: any) => r._row_id === rowId)
        if (row) setRowData(row)
      }
    } catch {
      // Ignore — initial load effect handles errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncCount])

  const handleFieldChange = async (columnId: string, value: any) => {
    if (!workspace || !tableId) return
    try {
      // On a new entry's first write, also persist the prefilled defaults so they
      // aren't lost (the row is created lazily, on the first write).
      if (!establishedRef.current) {
        establishedRef.current = true
        for (const [cid, dval] of Object.entries(rowData)) {
          if (cid !== columnId && dval !== undefined && dval !== null && dval !== '') {
            workspace.updateCell(tableId, stableRowId.current, cid, JSON.stringify(dval))
          }
        }
      }
      workspace.updateCell(tableId, stableRowId.current, columnId, JSON.stringify(value))
      setRowData(prev => ({ ...prev, [columnId]: value }))
    } catch (err) {
      console.error('Failed to update field:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  // Resolve referenced-table records (id + text-column label) for reference fields.
  const referenceLookup = useCallback((refTableId: string) => {
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

  const handleReturn = () => {
    // Return to the view we came from (kanban / card / table) when the opening
    // view recorded it in navigation state; otherwise fall back to the table.
    if (locationState.from) navigate(locationState.from)
    else if (tableId) navigate(`/workspace/${workspaceId}/table/${tableId}`)
    else navigate('/')
  }

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  const handleCreateNext = () => {
    const nextCount = entryCount + 1
    showToast(`Entry ${nextCount} saved`)
    navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`, {
      state: { entryCount: nextCount, from: locationState.from },
    })
  }

  if (loading) {
    return <div className="entry-view entry-view--loading"><span>Loading...</span></div>
  }

  if (error) {
    return (
      <div className="entry-view entry-view--error">
        <h2>Error</h2>
        <p>{error.message}</p>
        <button className="primary" onClick={handleReturn}>Back to Table</button>
      </div>
    )
  }

  if (!schema) {
    return (
      <div className="entry-view entry-view--error">
        <h2>Table not found</h2>
        <button className="primary" onClick={handleReturn}>Back</button>
      </div>
    )
  }

  // Order fields by the schema's explicit column order; columns without one
  // (legacy tables) fall to the end, alphabetically.
  const columns = (Object.values(schema.columns) as any[]).sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : null
    const bo = typeof b.order === 'number' ? b.order : null
    if (ao != null && bo != null) return ao - bo
    if (ao != null) return -1
    if (bo != null) return 1
    return a.name.localeCompare(b.name)
  })
  const titleCol = columns.find(c => c.column_type === 'text')
  const entryTitle = titleCol ? (rowData[titleCol.id] || 'Untitled') : 'Untitled'
  // "new" is the sentinel rowId used by the /entry/new route and the route pattern /entry/:rowId
  const isNewEntry = !rowId || rowId === 'new'
  // Breadcrumb label: "New Entry" for new entries, "Edit Entry" for existing rows
  const breadcrumbLabel = isNewEntry ? 'New Entry' : 'Edit Entry'

  return (
    <div className="entry-view">
      {/* Toolbar strip — breadcrumb + comment count */}
      <div className="entry-view__toolbar">
        <div className="entry-view__breadcrumb">
          <button className="entry-view__back" onClick={handleReturn}>
            Back to {schema.name}
          </button>
          <ChevronRightIcon />
          <span className="entry-view__breadcrumb-current">{breadcrumbLabel}</span>
        </div>
        <div className="entry-view__toolbar-right">
          <span className="entry-view__comment-count">
            <CommentIcon />
            {comments.length}
          </span>
        </div>
      </div>

      {/* Body: main content + comments sidebar */}
      <div className="entry-view__body">
        {/* Main content */}
        <div className="entry-view__main">
          <h1 className="entry-view__title">{isNewEntry ? breadcrumbLabel : entryTitle}</h1>

          <div className="entry-view__fields">
            {columns.map(column => (
              <div key={column.id} className="entry-field-row">
                <FieldRenderer
                  column={column}
                  value={rowData[column.id]}
                  onChange={value => handleFieldChange(column.id, value)}
                  lookup={referenceLookup}
                  members={members}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Comments sidebar */}
        <div className="entry-view__comments">
          <div className="comments__header">
            <CommentIcon />
            Comments
            <span className="comments__count">({comments.length})</span>
          </div>

          <div className="comments__list">
            {comments.length === 0 && (
              <p className="comments__empty">No comments yet</p>
            )}
            {comments.map(comment => (
              <CommentBubble key={comment.id} comment={comment} />
            ))}
          </div>

          {/* Comment input */}
          <div className="comments__input-wrap">
            <textarea
              className="comments__input"
              placeholder="Add a comment..."
              value={commentDraft}
              onChange={e => setCommentDraft(e.target.value)}
              rows={2}
            />
          </div>
        </div>
      </div>

      {/* Persistent bottom bar — always visible */}
      <div className="entry-view__actions">
        <button className="ghost" onClick={handleReturn}>Return</button>
        <div className="entry-view__actions-right">
          {toast && <span className="entry-toast">{toast}</span>}
          <button className="primary" onClick={handleCreateNext}>
            New entry
            {entryCount > 0 && (
              <span className="entry-count-badge">{entryCount}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
