import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
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
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { NewViewButton } from '@/components/NewViewDropdown'
import { NewTableModal } from '@/components/NewTableModal'
import {
  CsvImportModal,
  type CsvIssue,
  type CsvPreviewColumn,
} from '@/components/CsvImportModal'
import { AccountSwitcher } from '@/components/AccountSwitcher'
import { notifyWorkspaceChanged, useCurrentUserId } from '@/hooks/useTable'
import { computeReorderWrites, type OrderRow } from '@/fractionalIndex'
import { TrialBadge } from '@/components/TrialStatus'
import { buildTableDefinition, type TableTemplate } from '@/tableTemplates'
import './Sidebar.css'
import { ROLE_LABELS, type Role, type WorkspaceMember } from '@/lib/roles'
import { useRole } from '@/hooks/useRole'
import { LeaveWorkspaceModal } from './LeaveWorkspaceModal'

interface SidebarProps {
  workspace: any
  workspaceId: string
  syncCount?: number
  /** Narrow screens render the sidebar as an off-canvas drawer; this is whether
   *  it is showing. Ignored above the breakpoint, where it is always in flow.
   *  Closing is driven by the route changing, in the shell — the sidebar
   *  navigates from eight places and none of them should have to remember. */
  mobileOpen?: boolean
}

interface TableInfo {
  id: string
  name: string
}

interface ViewInfo {
  id: string
  name: string
  view_type: 'table' | 'kanban' | 'calendar' | 'card' | string
  table_id: string
  tableName?: string
}

// ── SVG icon set ────────────────────────────────────────────
const TableIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="11" height="11" rx="2" />
    <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" />
    <line x1="5.5" y1="5.5" x2="5.5" y2="12.5" />
  </svg>
)

const KanbanIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1" y="2" width="3" height="9" rx="1" />
    <rect x="5.5" y="2" width="3" height="6" rx="1" />
    <rect x="10" y="2" width="3" height="10" rx="1" />
  </svg>
)

const CardIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1" y="1" width="5" height="5.5" rx="1.5" />
    <rect x="8" y="1" width="5" height="5.5" rx="1.5" />
    <rect x="1" y="8" width="5" height="5" rx="1.5" />
    <rect x="8" y="8" width="5" height="5" rx="1.5" />
  </svg>
)

const HashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <line x1="3.5" y1="1" x2="2.5" y2="13" />
    <line x1="10" y1="1" x2="9" y2="13" />
    <line x1="1" y1="4.5" x2="13" y2="4.5" />
    <line x1="1" y1="9.5" x2="13" y2="9.5" />
  </svg>
)

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="6" y1="1.5" x2="6" y2="10.5" />
    <line x1="1.5" y1="6" x2="10.5" y2="6" />
  </svg>
)

const SunIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="6.5" cy="6.5" r="2.5" />
    <line x1="6.5" y1="0.5" x2="6.5" y2="2" />
    <line x1="6.5" y1="11" x2="6.5" y2="12.5" />
    <line x1="0.5" y1="6.5" x2="2" y2="6.5" />
    <line x1="11" y1="6.5" x2="12.5" y2="6.5" />
    <line x1="2.5" y1="2.5" x2="3.5" y2="3.5" />
    <line x1="9.5" y1="9.5" x2="10.5" y2="10.5" />
    <line x1="2.5" y1="10.5" x2="3.5" y2="9.5" />
    <line x1="9.5" y1="3.5" x2="10.5" y2="2.5" />
  </svg>
)

const MoonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M11 7.5A5 5 0 115 1.5 4.5 4.5 0 0011 7.5z" />
  </svg>
)

const LockIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="2" y="4.5" width="6" height="4.5" rx="1" />
    <path d="M3.5 4.5V3.5a1.5 1.5 0 013 0v1" />
  </svg>
)

const SearchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="5" cy="5" r="3.5" />
    <line x1="7.5" y1="7.5" x2="11" y2="11" />
  </svg>
)

const SettingsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="6" cy="6" r="2" />
    <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.4 2.4l1.06 1.06M8.54 8.54l1.06 1.06M2.4 9.6l1.06-1.06M8.54 3.46l1.06-1.06" />
  </svg>
)

const ShareIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="9" cy="2.5" r="1.8" />
    <circle cx="9" cy="9.5" r="1.8" />
    <circle cx="3" cy="6" r="1.8" />
    <line x1="4.6" y1="5.1" x2="7.4" y2="3.4" />
    <line x1="4.6" y1="6.9" x2="7.4" y2="8.6" />
  </svg>
)

const UserIcon = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="5.5" cy="3.5" r="2" />
    <path d="M1.5 10a4 4 0 018 0" />
  </svg>
)

// ── Share modal ──────────────────────────────────────────────
interface ShareModalProps {
  workspace: any
  onClose: () => void
}

function ShareModal({ workspace, onClose }: ShareModalProps) {
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = userId.trim()
    if (!trimmed) return

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      await workspace.inviteUser(trimmed)
      setSuccess(`Invited ${trimmed}`)
      setUserId('')
    } catch (err: any) {
      setError(err?.message ?? 'Failed to invite user')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal share-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="share-modal__header">
          <h2 className="share-modal__title">Share workspace</h2>
          <button className="share-modal__close ghost" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="share-modal__description">
          Invite someone by their Matrix user ID (e.g. <code>@user:server</code>).
          The server part is the homeserver domain without the port.
          They'll see it as a pending invitation on their Workspaces page.
        </p>
        <form className="share-modal__form" onSubmit={handleInvite}>
          <input
            type="text"
            className="share-modal__input"
            placeholder="@user:server"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            disabled={loading}
            autoFocus
          />
          <button type="submit" className="primary" disabled={!userId.trim() || loading}>
            {loading ? 'Inviting...' : 'Invite'}
          </button>
        </form>
        {error && <p className="share-modal__error">{error}</p>}
        {success && <p className="share-modal__success">{success}</p>}
      </div>
    </div>
  )
}

function viewIcon(viewType: string) {
  if (viewType === 'kanban') return <KanbanIcon />
  if (viewType === 'card') return <CardIcon />
  return <TableIcon />
}

/** Build a navigation path for a view. All view types — including `table` —
 *  route to `/view/:viewId`, so a saved table view's filters + sort actually
 *  apply (a table view is no longer identical to the raw table). */
export function viewPath(view: ViewInfo, workspaceId: string): string {
  return `/workspace/${workspaceId}/table/${view.table_id}/view/${view.id}`
}

const PencilIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M8.6 1.9 11.1 4.4 4.5 11H2v-2.5z" />
  </svg>
)

const DownloadIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M6 1v6.5" />
    <path d="M3.5 5.5 6 8l2.5-2.5" />
    <path d="M2 9.5v1h8v-1" />
  </svg>
)

/** The download arrow, reversed — import into this table. */
const UploadIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M6 8V1.5" />
    <path d="M3.5 4 6 1.5 8.5 4" />
    <path d="M2 9.5v1h8v-1" />
  </svg>
)

const ShieldIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M6 1 2 2.5v3.2C2 8.2 3.7 10.3 6 11c2.3-.7 4-2.8 4-5.3V2.5z" />
    <path d="M4.3 6 5.6 7.3 7.9 4.7" />
  </svg>
)

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <line x1="2" y1="3" x2="10" y2="3" />
    <path d="M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" />
    <path d="M4.5 3V2a1 1 0 011-1h1a1 1 0 011 1v1" />
  </svg>
)

/** A draggable, deletable table entry in the sidebar list. The whole row is the
 *  drag handle (a <6px move still registers as a click → navigate); the trash
 *  button stops pointer/click propagation so it neither drags nor navigates. */
function SortableTableItem({
  table,
  active,
  canDelete,
  canRename,
  canExport,
  canImport,
  onOpen,
  onDelete,
  onRename,
  onExport,
  onImport,
}: {
  table: TableInfo
  active: boolean
  canDelete: boolean
  canRename: boolean
  canExport: boolean
  canImport: boolean
  onOpen: () => void
  onDelete: () => void
  onRename: () => void
  onExport: () => void
  onImport: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: table.id,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sidebar__item sidebar__item--table ${active ? 'sidebar__item--active' : ''}`}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <HashIcon />
      <span className="sidebar__item-label">{table.name}</span>
      {canRename && (
        <button
          className="sidebar__item-delete ghost"
          title={`Rename table ${table.name}`}
          aria-label="Rename table"
          onClick={e => {
            e.stopPropagation()
            onRename()
          }}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <PencilIcon />
        </button>
      )}
      {canImport && (
        <button
          className="sidebar__item-delete ghost"
          title={`Import a CSV into ${table.name}`}
          aria-label="Import CSV into table"
          onClick={e => {
            e.stopPropagation()
            onImport()
          }}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <UploadIcon />
        </button>
      )}
      {canExport && (
        <button
          className="sidebar__item-delete ghost"
          title={`Export ${table.name} as CSV`}
          aria-label="Export table as CSV"
          onClick={e => {
            e.stopPropagation()
            onExport()
          }}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <DownloadIcon />
        </button>
      )}
      {canDelete && (
        <button
          className="sidebar__item-delete ghost"
          title={`Delete table ${table.name}`}
          aria-label="Delete table"
          onClick={e => {
            e.stopPropagation()
            onDelete()
          }}
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  )
}

export function Sidebar({
  workspace,
  workspaceId,
  syncCount,
  mobileOpen = false,
}: SidebarProps) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [views, setViews] = useState<ViewInfo[]>([])
  const [isCreatingTable, setIsCreatingTable] = useState(false)
  const [importing, setImporting] = useState(false)
  /** Preselects the destination when import is opened from a table's own row;
   *  the workspace-level button leaves it unset so the user picks. */
  const [importTarget, setImportTarget] = useState<string | undefined>(undefined)
  const [checkingIntegrity, setCheckingIntegrity] = useState(false)
  const [creatingTable, setCreatingTable] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  
  const [showMembers, setShowMembers] = useState(false)
  // null = unknown (e.g. local-only or mock workspace); true/false = real room state.
  const [encrypted, setEncrypted] = useState<boolean | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { workspaces } = useAuth()
  const workspaceName = workspaces.find(w => w.id === workspaceId)?.name ?? 'Workspace'
  /** This user's role — gates the administrative affordances below. */
  const myRole = useRole(workspace, syncCount)
  const myUserId = useCurrentUserId(workspace)
  /** Only a real (Matrix-backed) workspace can be left. */
  const canLeave = !!workspace && typeof (workspace as any).leaveWorkspace === 'function'

  // ── Fetch member list ───────────────────────────────────────
  const loadMembers = useCallback(async () => {
    if (!workspace?.listMembers) return
    try {
      const json = await workspace.listMembers()
      const parsed = JSON.parse(json) as Array<{
        userId: string
        displayName?: string
        role?: Role
      }>
      setMembers(
        parsed.map(m => ({
          id: m.userId,
          name: m.displayName || '',
          role: m.role ?? 'editor',
        })),
      )
    } catch (err) {
      console.error('Failed to load members:', err)
    }
  }, [workspace])

  /** True when demoting this member would leave the workspace with no admin —
   *  which is only ever the case for yourself, since you can't demote another
   *  admin into being the last one. */
  const isLastAdmin = (m: WorkspaceMember) =>
    m.id === myUserId &&
    m.role === 'admin' &&
    !members.some(o => o.id !== m.id && o.role === 'admin')

  /** Only an admin may change roles; the homeserver enforces it regardless, but
   *  offering a control that will be rejected is its own bug. */
  const changeRole = async (member: WorkspaceMember, role: Role) => {
    const ws = workspace as any
    if (!ws || typeof ws.setUserRole !== 'function') return
    const previous = member.role
    setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role } : m)))
    try {
      await ws.setUserRole(member.id, role)
      loadMembers()
    } catch (err) {
      console.error('Failed to set role:', err)
      alert('Failed to change role: ' + (err instanceof Error ? err.message : String(err)))
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: previous } : m)))
    }
  }

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  useEffect(() => {
    if (workspace) refreshData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, location.pathname, syncCount])

  // Reflect the room's *real* E2E encryption state rather than asserting it.
  // Only ConnectedWorkspace exposes isEncrypted(); mocks/local workspaces leave
  // it null (unknown).
  useEffect(() => {
    if (workspace && typeof workspace.isEncrypted === 'function') {
      try {
        setEncrypted(!!workspace.isEncrypted())
      } catch {
        setEncrypted(null)
      }
    } else {
      setEncrypted(null)
    }
  }, [workspace, syncCount])

  const refreshData = () => {
    try {
      const tableIds = JSON.parse(workspace.listTables()) as string[]

      // Build table list (try schema for name, fall back to id)
      const tableList: TableInfo[] = tableIds.map(id => {
        try {
          const schema = JSON.parse(workspace.getTableSchema(id))
          return { id, name: schema.name || id }
        } catch {
          return { id, name: id }
        }
      })
      setTables(tableList)

      // If the table we're currently viewing was deleted (here or on another
      // device, arriving via sync), leave its now-dead route so the user isn't
      // stranded on an empty page.
      const m = location.pathname.match(/\/workspace\/[^/]+\/table\/([^/]+)/)
      const currentTableId = m ? decodeURIComponent(m[1]) : null
      if (currentTableId && !tableList.some(t => t.id === currentTableId)) {
        navigate(`/workspace/${workspaceId}`)
      }

      // Build flat view list across all tables
      const viewList: ViewInfo[] = []
      for (const table of tableList) {
        try {
          const viewIds = JSON.parse(workspace.listViewsForTable(table.id)) as string[]
          for (const viewId of viewIds) {
            try {
              const v = JSON.parse(workspace.getView(viewId))
              viewList.push({
                id: viewId,
                name: v.name,
                view_type: v.view_type,
                table_id: table.id,
                tableName: table.name,
              })
            } catch { /* skip malformed view */ }
          }
        } catch { /* skip */ }
      }
      setViews(viewList)
    } catch (err) {
      console.error('Failed to load sidebar data:', err)
    }
  }

  const handleCreateTable = async (name: string, template: TableTemplate) => {
    if (!name.trim() || creatingTable) return
    setCreatingTable(true)
    try {
      const tableId = name.toLowerCase().replace(/\s+/g, '-')
      await workspace.createTable(JSON.stringify(buildTableDefinition(tableId, name, template)))
      setIsCreatingTable(false)
      refreshData()
      notifyWorkspaceChanged(workspaceId)
      navigate(`/workspace/${workspaceId}/table/${tableId}`)
    } catch (err) {
      // Bridge errors are plain-string JsValues (no `.message`), so don't assume
      // an Error object — otherwise this showed "...: undefined".
      console.error('Failed to create table:', err)
      const msg = err instanceof Error ? err.message : String(err)
      alert('Failed to create table: ' + msg)
    } finally {
      setCreatingTable(false)
    }
  }

  const isActive = (path: string) => location.pathname === path

  const canMutateTables = !!workspace && typeof workspace.deleteTable === 'function'

  // Drag-to-reorder the table list. A 6px threshold keeps a plain click as a
  // navigate. Mirrors the row reorder in TableView: write a fractional `_order`
  // key (one write for an already-ordered list, a one-time backfill otherwise).
  const tableSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleTableDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id || !workspace || typeof workspace.setTableOrder !== 'function') {
      return
    }
    let keyMap: Record<string, string> = {}
    try {
      keyMap = JSON.parse(workspace.getTableOrderKeys?.() ?? '{}')
    } catch {
      /* no keys yet — computeReorderWrites backfills */
    }
    const orderRows: OrderRow[] = tables.map(t => ({ id: t.id, key: keyMap[t.id] ?? null }))
    const writes = computeReorderWrites(orderRows, String(active.id), String(over.id))
    if (writes.length === 0) return

    // Optimistic: reflect the new order immediately; the writes sync in the bg.
    const ids = tables.map(t => t.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) setTables(arrayMove(tables, from, to))

    for (const w of writes) {
      Promise.resolve(workspace.setTableOrder(w.id, w.key)).catch((err: unknown) =>
        console.error('Failed to reorder table:', err),
      )
    }
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
  }

  const canRenameTables = !!workspace && typeof workspace.renameTable === 'function'
  const canDeleteViews = !!workspace && typeof workspace.deleteView === 'function'

  /** Rename in place — the table keeps its id, columns, rows, and views.
   *
   *  Deliberately NOT optimistic. A rename is one small write, so optimism buys
   *  no perceptible speed; what it does buy is a window where the new name is
   *  on screen but not yet persisted — reload inside it and the rename is gone
   *  with no error shown. Showing the name only once the write lands makes the
   *  UI mean what it says. */
  const handleRenameTable = async (table: TableInfo) => {
    if (!workspace || typeof workspace.renameTable !== 'function') return
    const name = window.prompt('Rename table', table.name)?.trim()
    if (!name || name === table.name) return
    try {
      await workspace.renameTable(table.id, name)
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      refreshData()
    } catch (err: unknown) {
      console.error('Failed to rename table:', err)
      alert('Failed to rename table: ' + (err instanceof Error ? err.message : String(err)))
      refreshData()
    }
  }

  /** Rename a view by rewriting its config under the same id (LWW). Same
   *  reasoning as `handleRenameTable`: await the write, then show the result,
   *  and never swallow a failure — the old version reported success by
   *  updating local state and logged the error to the console, so a failed
   *  rename looked identical to a successful one until the next reload. */
  const handleRenameView = async (view: ViewInfo) => {
    if (!workspace) return
    const name = window.prompt('Rename view', view.name)?.trim()
    if (!name || name === view.name) return
    try {
      const cfg = JSON.parse(workspace.getView(view.id))
      await workspace.createView(JSON.stringify({ ...cfg, name }))
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      refreshData()
    } catch (err: unknown) {
      console.error('Failed to rename view:', err)
      alert('Failed to rename view: ' + (err instanceof Error ? err.message : String(err)))
      refreshData()
    }
  }

  /** Delete a view. Only the projection goes — the table and its rows stay. */
  const handleDeleteView = (view: ViewInfo) => {
    if (!workspace || typeof workspace.deleteView !== 'function') return
    if (!window.confirm(`Delete view "${view.name}"? The table and its data are not affected.`)) {
      return
    }
    setViews(prev => prev.filter(v => v.id !== view.id))
    if (location.pathname.includes(`/view/${view.id}`)) {
      navigate(`/workspace/${workspaceId}/table/${view.table_id}`)
    }
    Promise.resolve(workspace.deleteView(view.id))
      .then(() => {
        if (workspaceId) notifyWorkspaceChanged(workspaceId)
        refreshData()
      })
      .catch((err: unknown) => {
        console.error('Failed to delete view:', err)
        alert('Failed to delete view: ' + (err instanceof Error ? err.message : String(err)))
        refreshData()
      })
  }

  const canExportCsv = !!workspace && typeof workspace.exportTableCsv === 'function'
  const canImportCsv =
    !!workspace &&
    typeof workspace.previewCsvImport === 'function' &&
    typeof workspace.importCsv === 'function'

  /** Download one table as a standalone CSV (ADR 0004) — column names as
   *  headers, references as labels, so it opens as an ordinary spreadsheet. */
  const handleExportCsv = async (table: TableInfo) => {
    if (!workspace || typeof workspace.exportTableCsv !== 'function') return
    try {
      // Awaited: local on the in-tab client, a worker round-trip otherwise.
      const csv = await workspace.exportTableCsv(table.id)
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${table.name}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      console.error('Failed to export table:', err)
      alert('Failed to export table: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const previewCsv = useCallback(
    async (tableId: string, csv: string, overrides: CsvPreviewColumn[]) => {
      if (!workspace || typeof workspace.previewCsvImport !== 'function') {
        throw new Error('Import is not available on this workspace')
      }
      // The bridge takes the column list in its own schema shape, so map the
      // preview's `type` back onto `column_type` before handing it over.
      const asColumns = overrides.map(c => ({
        id: c.id,
        name: c.name,
        column_type: c.type,
        required: false,
        default_value: null,
        options: c.options ?? null,
        reference_table: null,
      }))
      return JSON.parse(await workspace.previewCsvImport(tableId, csv, 8, JSON.stringify(asColumns)))
    },
    [workspace],
  )

  const canExportWorkspace = !!workspace && typeof workspace.exportWorkspaceZip === 'function'
  const canCheckIntegrity = !!workspace && typeof workspace.checkIntegrity === 'function'

  /** Audit this workspace against a full re-gather of the room's history and
   *  repair any difference (issue 48f042ba).
   *
   *  Deliberately manual. It re-paginates the entire history — precisely what
   *  the snapshot exists to avoid — so running it on a schedule would undo the
   *  incremental cold start. Repair is local-only: the server already holds
   *  anything we are missing. */
  const handleCheckIntegrity = async () => {
    if (!workspace || typeof workspace.checkIntegrity !== 'function' || checkingIntegrity) return
    setCheckingIntegrity(true)
    try {
      const r = JSON.parse(await workspace.checkIntegrity()) as {
        checked: number
        missing: number
        stale: number
        repaired: number
        undecryptable: number
      }
      if (workspaceId) notifyWorkspaceChanged(workspaceId)
      refreshData()
      const problems = r.missing + r.stale
      alert(
        problems === 0
          ? `No problems found. ${r.checked} cells checked against the server.` +
              (r.undecryptable > 0
                ? `

${r.undecryptable} event(s) could not be decrypted — those are a key problem, not a sync gap.`
                : '')
          : `Repaired ${r.repaired} of ${r.checked} cells.

` +
              `${r.missing} were missing locally, ${r.stale} were out of date. ` +
              'They are now restored from the server.',
      )
    } catch (err: unknown) {
      console.error('Integrity check failed:', err)
      alert('Integrity check failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setCheckingIntegrity(false)
    }
  }

  /** Download the whole workspace as one zip (ADR 0004) — the same container
   *  `tidework import` reads, so an export is portable between the app and the
   *  CLI rather than being an app-only convenience. */
  const handleExportWorkspace = async () => {
    if (!workspace || typeof workspace.exportWorkspaceZip !== 'function') return
    try {
      const name = workspaceName || 'workspace'
      const bytes = await workspace.exportWorkspaceZip(name)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      console.error('Failed to export workspace:', err)
      alert('Failed to export workspace: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  /** Not memoized, unlike `previewCsv`: this one fires on a click rather than
   *  feeding the modal's effect deps, so a stable identity buys nothing. */
  const importCsv = async (
    tableId: string,
    tableName: string,
    csv: string,
    columns: CsvPreviewColumn[],
  ) => {
    if (!workspace || typeof workspace.importCsv !== 'function') {
      throw new Error('Import is not available on this workspace')
    }
    const asColumns = columns.map((c, i) => ({
      id: c.id,
      name: c.name,
      column_type: c.type,
      required: false,
      default_value: null,
      options: c.options ?? null,
      reference_table: null,
      order: i,
    }))
    const raw = await workspace.importCsv(tableId, tableName, csv, JSON.stringify(asColumns))
    const result = JSON.parse(raw) as { rowsWritten: number; issues: CsvIssue[] }
    if (workspaceId) notifyWorkspaceChanged(workspaceId)
    refreshData()
    return result
  }

  const handleDeleteTable = (table: TableInfo) => {
    if (!workspace || typeof workspace.deleteTable !== 'function') return
    if (!window.confirm(`Delete table "${table.name}"? All of its rows will be removed.`)) return

    // Optimistic removal; if we're viewing it, leave the route now.
    setTables(prev => prev.filter(t => t.id !== table.id))
    if (location.pathname.startsWith(`/workspace/${workspaceId}/table/${table.id}`)) {
      navigate(`/workspace/${workspaceId}`)
    }
    Promise.resolve(workspace.deleteTable(table.id))
      .then(() => {
        if (workspaceId) notifyWorkspaceChanged(workspaceId)
        refreshData()
      })
      .catch((err: unknown) => {
        console.error('Failed to delete table:', err)
        alert('Failed to delete table: ' + (err instanceof Error ? err.message : String(err)))
        refreshData() // roll back to the real state
      })
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${
        mobileOpen ? 'sidebar--open' : ''
      }`}
    >
      {/* Workspace header / collapse toggle */}
      <div className="sidebar__workspace">
        <div className="sidebar__logo" onClick={() => setCollapsed(c => !c)} />
        {!collapsed && (
          <div className="sidebar__workspace-text" onClick={() => setCollapsed(c => !c)}>
            <span className="sidebar__workspace-name">{workspaceName}</span>
            <span className={`sidebar__workspace-badge${encrypted === false ? ' sidebar__workspace-badge--warn' : ''}`}>
              {encrypted === false ? (
                <>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                    <path d="M6 1.2 1 10.8h10L6 1.2z" />
                    <line x1="6" y1="5" x2="6" y2="8" />
                    <circle cx="6" cy="9.6" r="0.5" fill="currentColor" stroke="none" />
                  </svg>
                  Not encrypted
                </>
              ) : (
                <>
                  <LockIcon /> E2E Encrypted
                </>
              )}
            </span>
          </div>
        )}
        {!collapsed && (
          <button
            className="sidebar__back-btn"
            title="All workspaces"
            onClick={() => navigate('/workspaces')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2H3a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V4L8 2z" />
              <path d="M8 2v2h2" />
              <line x1="4" y1="7" x2="8" y2="7" />
              <line x1="4" y1="5" x2="6" y2="5" />
            </svg>
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {/* Search */}
          <div className="sidebar__search-wrap">
            <div className="sidebar__search">
              <SearchIcon />
              <span className="sidebar__search-placeholder">Search...</span>
              <span className="sidebar__search-shortcut">⌘K</span>
            </div>
          </div>

          {/* Tables section */}
          <div className="sidebar__section">
            <div className="sidebar__section-label">Tables</div>

            <DndContext
              sensors={tableSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleTableDragEnd}
            >
              <SortableContext
                items={tables.map(t => t.id)}
                strategy={verticalListSortingStrategy}
              >
                {tables.map(table => (
                  <SortableTableItem
                    key={table.id}
                    table={table}
                    active={isActive(`/workspace/${workspaceId}/table/${table.id}`)}
                    canDelete={canMutateTables}
                    canRename={canRenameTables}
                    canExport={canExportCsv}
                    canImport={canImportCsv}
                    onOpen={() => navigate(`/workspace/${workspaceId}/table/${table.id}`)}
                    onDelete={() => handleDeleteTable(table)}
                    onRename={() => void handleRenameTable(table)}
                    onExport={() => handleExportCsv(table)}
                    onImport={() => {
                      setImportTarget(table.id)
                      setImporting(true)
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <button
              className="sidebar__item sidebar__item--add"
              onClick={() => setIsCreatingTable(true)}
            >
              <PlusIcon />
              <span>New table</span>
            </button>

            {canImportCsv && (
              <button
                className="sidebar__item sidebar__item--add"
                onClick={() => {
                  setImportTarget(undefined)
                  setImporting(true)
                }}
              >
                <UploadIcon />
                <span>Import CSV</span>
              </button>
            )}

            {canExportWorkspace && (
              <button className="sidebar__item sidebar__item--add" onClick={handleExportWorkspace}>
                <DownloadIcon />
                <span>Export workspace</span>
              </button>
            )}

            {canCheckIntegrity && (
              <button
                className="sidebar__item sidebar__item--add"
                onClick={() => void handleCheckIntegrity()}
                disabled={checkingIntegrity}
                title="Compare this workspace against the server and repair anything missing"
              >
                <ShieldIcon />
                <span>{checkingIntegrity ? 'Checking…' : 'Check integrity'}</span>
              </button>
            )}

            {tables.length === 0 && !isCreatingTable && (
              <p className="sidebar__empty">No tables yet</p>
            )}
          </div>

          {/* Views section — flat list, separate from tables */}
          <div className="sidebar__section">
            <div className="sidebar__section-label">Views</div>

            {views.map(view => {
              const path = viewPath(view, workspaceId)
              const active = isActive(path)
              return (
                // A div, not a button: the rename/delete controls are buttons
                // and nesting buttons is invalid HTML.
                <div
                  key={view.id}
                  role="button"
                  tabIndex={0}
                  className={`sidebar__item ${active ? 'sidebar__item--active' : ''}`}
                  onClick={() => navigate(path)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(path)
                    }
                  }}
                  data-testid={`view-item-${view.id}`}
                >
                  {viewIcon(view.view_type)}
                  <span className="sidebar__item-label">{view.name}</span>
                  {view.tableName && (
                    <span className="sidebar__item-badge">{view.tableName}</span>
                  )}
                  {active && (
                    <span className="sidebar__item-settings" title="View settings">
                      <SettingsIcon />
                    </span>
                  )}
                  <button
                    className="sidebar__item-delete ghost"
                    title={`Rename view ${view.name}`}
                    aria-label="Rename view"
                    onClick={e => { e.stopPropagation(); void handleRenameView(view) }}
                  >
                    <PencilIcon />
                  </button>
                  {canDeleteViews && (
                    <button
                      className="sidebar__item-delete ghost"
                      title={`Delete view ${view.name}`}
                      aria-label="Delete view"
                      onClick={e => { e.stopPropagation(); handleDeleteView(view) }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              )
            })}

            <NewViewButton
              workspace={workspace}
              workspaceId={workspaceId}
              onCreated={() => refreshData()}
            />

            {views.length === 0 && (
              <p className="sidebar__empty">No views yet</p>
            )}
          </div>

          {/* Members section */}
          <div className="sidebar__section">
            <div className="sidebar__section-label">
              Members
              <span className="sidebar__member-count">{members.length}</span>
            </div>

            <button
              className="sidebar__item sidebar__item--add"
              onClick={() => setShowShareModal(true)}
            >
              <ShareIcon />
              <span>Share workspace</span>
            </button>

            {canLeave && (
              <button
                className="sidebar__item sidebar__item--add"
                onClick={() => { setShowLeaveModal(true); loadMembers() }}
              >
                <span>Leave workspace…</span>
              </button>
            )}

            {showMembers ? (
              <>
                <div className="sidebar__member-list">
                  {members.map(m => (
                    <div key={m.id} className="sidebar__member">
                      <UserIcon />
                      <span className="sidebar__member-id">{m.name || m.id}</span>
                      {myRole === 'admin' ? (
                        <select
                          className="sidebar__member-role"
                          value={m.role}
                          aria-label={`Role for ${m.name || m.id}`}
                          title={
                            isLastAdmin(m)
                              ? 'You are the only admin — make someone else an admin first'
                              : undefined
                          }
                          onChange={e => void changeRole(m, e.target.value as Role)}
                        >
                          <option value="admin">Admin</option>
                          {/* Stepping down as the ONLY admin would strand the
                              workspace: nobody could manage roles, and raising a
                              power level requires one. Disabled rather than
                              offered-then-rejected. */}
                          <option value="editor" disabled={isLastAdmin(m)}>Editor</option>
                          <option value="viewer" disabled={isLastAdmin(m)}>Viewer</option>
                        </select>
                      ) : (
                        <span className="sidebar__member-role-label">{ROLE_LABELS[m.role]}</span>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  className="sidebar__item sidebar__item--add"
                  onClick={() => setShowMembers(false)}
                >
                  <span>Hide members</span>
                </button>
              </>
            ) : members.length > 0 ? (
              <button
                className="sidebar__item sidebar__item--add"
                onClick={() => { setShowMembers(true); loadMembers() }}
              >
                <UserIcon />
                <span>Show {members.length} member{members.length !== 1 ? 's' : ''}</span>
              </button>
            ) : null}
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Footer: trial status + theme + account switcher */}
          <div className="sidebar__footer">
            <TrialBadge />
            <button className="sidebar__item sidebar__item--theme" onClick={toggleTheme}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <AccountSwitcher />
          </div>
        </>
      )}

      {showLeaveModal && workspace && (
        <LeaveWorkspaceModal
          workspaceName={workspaceName}
          members={members}
          myUserId={myUserId}
          myRole={myRole}
          onPromote={async (userId: string) => {
            await (workspace as any).setUserRole(userId, 'admin')
          }}
          onLeave={async (removeEveryone: boolean) => {
            await (workspace as any).leaveWorkspace(removeEveryone)
            // The workspace is gone from this account — don't linger inside it.
            navigate('/workspaces')
          }}
          onClose={() => setShowLeaveModal(false)}
        />
      )}

      {showShareModal && workspace && (
        <ShareModal
          workspace={workspace}
          onClose={() => { setShowShareModal(false); loadMembers() }}
        />
      )}

      {isCreatingTable && (
        <NewTableModal
          onCreate={handleCreateTable}
          onClose={() => setIsCreatingTable(false)}
          creating={creatingTable}
        />
      )}

      {importing && (
        <CsvImportModal
          tables={tables.map(t => ({ id: t.id, name: t.name }))}
          defaultTableId={importTarget}
          preview={previewCsv}
          onImport={importCsv}
          onClose={() => setImporting(false)}
        />
      )}
    </aside>
  )
}
