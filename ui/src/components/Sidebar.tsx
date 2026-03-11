import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { NewViewButton } from '@/components/NewViewDropdown'
import './Sidebar.css'

interface SidebarProps {
  workspace: any
  username: string | null
  workspaceId: string
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

function viewIcon(viewType: string) {
  if (viewType === 'kanban') return <KanbanIcon />
  if (viewType === 'card') return <CardIcon />
  return <TableIcon />
}

/** Build a navigation path for a view based on its type. */
export function viewPath(view: ViewInfo): string {
  if (view.view_type === 'table') return `/table/${view.table_id}`
  return `/table/${view.table_id}/view/${view.id}`
}

export function Sidebar({ workspace, username, workspaceId }: SidebarProps) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [views, setViews] = useState<ViewInfo[]>([])
  const [isCreatingTable, setIsCreatingTable] = useState(false)
  const [newTableName, setNewTableName] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, toggleTheme } = useTheme()
  const { workspaces, signOut } = useAuth()
  const workspaceName = workspaces.find(w => w.id === workspaceId)?.name ?? 'Workspace'

  const handleSignOut = () => {
    signOut()
    navigate('/signin')
  }

  useEffect(() => {
    if (workspace) refreshData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, location.pathname])

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

  const handleCreateTable = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTableName.trim()) return
    try {
      const tableId = newTableName.toLowerCase().replace(/\s+/g, '-')
      workspace.createTable(JSON.stringify({
        id: tableId,
        name: newTableName,
        columns: {
          name: { id: 'name', name: 'Name', column_type: 'text', required: false },
        },
      }))
      setNewTableName('')
      setIsCreatingTable(false)
      refreshData()
      navigate(`/table/${tableId}`)
    } catch (err) {
      console.error('Failed to create table:', err)
      alert('Failed to create table: ' + (err as Error).message)
    }
  }

  const isActive = (path: string) => location.pathname === path

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
      {/* Workspace header / collapse toggle */}
      <div className="sidebar__workspace" onClick={() => setCollapsed(c => !c)}>
        <div className="sidebar__logo" />
        {!collapsed && (
          <div className="sidebar__workspace-text">
            <span className="sidebar__workspace-name">{workspaceName}</span>
            <span className="sidebar__workspace-badge">
              <LockIcon /> E2E Encrypted
            </span>
          </div>
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
              const active = isActive(`/table/${table.id}`)
              return (
                <button
                  key={table.id}
                  className={`sidebar__item ${active ? 'sidebar__item--active' : ''}`}
                  onClick={() => navigate(`/table/${table.id}`)}
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
              const path = viewPath(view)
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
              onCreated={() => refreshData()}
            />

            {views.length === 0 && (
              <p className="sidebar__empty">No views yet</p>
            )}
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Footer: user + theme + sign out */}
          <div className="sidebar__footer">
            <button className="sidebar__item sidebar__item--theme" onClick={toggleTheme}>
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <div className="sidebar__user">
              <div className="sidebar__user-avatar">{username?.[0]?.toUpperCase()}</div>
              <span className="sidebar__user-name">{username}</span>
              <button className="sidebar__signout" title="Sign out" onClick={handleSignOut}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M8 6H1M5 3l-3 3 3 3" />
                  <path d="M6 1h4a1 1 0 011 1v8a1 1 0 01-1 1H6" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
