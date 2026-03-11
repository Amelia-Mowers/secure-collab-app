import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { NewViewButton } from '@/components/NewViewDropdown'
import { AccountSwitcher } from '@/components/AccountSwitcher'
import { notifyWorkspaceChanged } from '@/hooks/useTable'
import './Sidebar.css'

interface SidebarProps {
  workspace: any
  workspaceId: string
  syncCount?: number
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

/** Build a navigation path for a view based on its type. */
export function viewPath(view: ViewInfo, workspaceId: string): string {
  if (view.view_type === 'table') return `/workspace/${workspaceId}/table/${view.table_id}`
  return `/workspace/${workspaceId}/table/${view.table_id}/view/${view.id}`
}

export function Sidebar({ workspace, workspaceId, syncCount }: SidebarProps) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [views, setViews] = useState<ViewInfo[]>([])
  const [isCreatingTable, setIsCreatingTable] = useState(false)
  const [newTableName, setNewTableName] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [members, setMembers] = useState<string[]>([])
  const [showMembers, setShowMembers] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { workspaces } = useAuth()
  const workspaceName = workspaces.find(w => w.id === workspaceId)?.name ?? 'Workspace'

  // ── Fetch member list ───────────────────────────────────────
  const loadMembers = useCallback(async () => {
    if (!workspace?.listMembers) return
    try {
      const json = await workspace.listMembers()
      const memberIds = JSON.parse(json) as string[]
      setMembers(memberIds)
    } catch (err) {
      console.error('Failed to load members:', err)
    }
  }, [workspace])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  useEffect(() => {
    if (workspace) refreshData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, location.pathname, syncCount])

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

  const handleCreateTable = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTableName.trim()) return
    try {
      const tableId = newTableName.toLowerCase().replace(/\s+/g, '-')
      await workspace.createTable(JSON.stringify({
        id: tableId,
        name: newTableName,
        columns: {
          name: { id: 'name', name: 'Name', column_type: 'text', required: false },
        },
      }))
      setNewTableName('')
      setIsCreatingTable(false)
      refreshData()
      notifyWorkspaceChanged(workspaceId)
      navigate(`/workspace/${workspaceId}/table/${tableId}`)
    } catch (err) {
      console.error('Failed to create table:', err)
      alert('Failed to create table: ' + (err as Error).message)
    }
  }

  const isActive = (path: string) => location.pathname === path

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      {/* Workspace header / collapse toggle */}
      <div className="sidebar__workspace">
        <div className="sidebar__logo" onClick={() => setCollapsed(c => !c)} />
        {!collapsed && (
          <div className="sidebar__workspace-text" onClick={() => setCollapsed(c => !c)}>
            <span className="sidebar__workspace-name">{workspaceName}</span>
            <span className="sidebar__workspace-badge">
              <LockIcon /> E2E Encrypted
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

            {tables.map(table => {
              const active = isActive(`/workspace/${workspaceId}/table/${table.id}`)
              return (
                <button
                  key={table.id}
                  className={`sidebar__item ${active ? 'sidebar__item--active' : ''}`}
                  onClick={() => navigate(`/workspace/${workspaceId}/table/${table.id}`)}
                >
                  <HashIcon />
                  <span className="sidebar__item-label">{table.name}</span>
                </button>
              )
            })}

            {isCreatingTable ? (
              <form className="sidebar__new-table-form" onSubmit={handleCreateTable}>
                <input
                  type="text"
                  value={newTableName}
                  onChange={e => setNewTableName(e.target.value)}
                  placeholder="Table name..."
                  autoFocus
                  onBlur={() => { if (!newTableName.trim()) setIsCreatingTable(false) }}
                />
              </form>
            ) : (
              <button
                className="sidebar__item sidebar__item--add"
                onClick={() => setIsCreatingTable(true)}
              >
                <PlusIcon />
                <span>New table</span>
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
                <button
                  key={view.id}
                  className={`sidebar__item ${active ? 'sidebar__item--active' : ''}`}
                  onClick={() => navigate(path)}
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
                </button>
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

            {showMembers ? (
              <>
                <div className="sidebar__member-list">
                  {members.map(m => (
                    <div key={m} className="sidebar__member">
                      <UserIcon />
                      <span className="sidebar__member-id">{m}</span>
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

          {/* Footer: theme + account switcher */}
          <div className="sidebar__footer">
            <button className="sidebar__item sidebar__item--theme" onClick={toggleTheme}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <AccountSwitcher />
          </div>
        </>
      )}

      {showShareModal && workspace && (
        <ShareModal
          workspace={workspace}
          onClose={() => { setShowShareModal(false); loadMembers() }}
        />
      )}
    </aside>
  )
}
