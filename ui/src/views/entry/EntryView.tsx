import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { FieldRenderer } from './FieldRenderer'
import './EntryView.css'

interface EntryViewProps {
  workspace: any | null
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

export function EntryView({ workspace }: EntryViewProps) {
  const { workspaceId, tableId, rowId } = useParams<{ workspaceId: string; tableId: string; rowId: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  // Entry counter carried through navigation state
  const locationState = (location.state as { entryCount?: number } | null) ?? {}
  const [entryCount] = useState<number>(locationState.entryCount ?? 0)

  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [rowData, setRowData] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stable row ID for new entries — created on first keystroke, never changes URL
  const stableRowId = useRef<string>(rowId && rowId !== 'new' ? rowId : `row_${Date.now()}`)
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
      }
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setLoading(false)
    }
  }, [workspace, tableId, rowId])

  const handleFieldChange = async (columnId: string, value: any) => {
    if (!workspace || !tableId) return
    try {
      workspace.updateCell(tableId, stableRowId.current, columnId, JSON.stringify(value))
      setRowData(prev => ({ ...prev, [columnId]: value }))
    } catch (err) {
      console.error('Failed to update field:', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const handleReturn = () => {
    // If we're still on /entry/new and nothing was written, no row exists — just go back.
    // If a real rowId exists and we're in new-entry mode, the first field write already
    // navigated us away from /new, so isNewEntry is false by then. Either way, navigate back.
    if (tableId) navigate(`/workspace/${workspaceId}/table/${tableId}`)
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
    navigate(`/workspace/${workspaceId}/table/${tableId}/entry/new`, { state: { entryCount: nextCount } })
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

  // TODO: use schema-defined sort_order when available
  const columns = Object.values(schema.columns).sort((a, b) => a.name.localeCompare(b.name))
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
