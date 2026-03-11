import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { AccountSwitcher } from '@/components/AccountSwitcher'
import './WorkspacesPage.css'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function WorkspacesPage() {
  const { workspaces, createWorkspace, joinWorkspace, refreshWorkspaces } = useAuth()
  const navigate = useNavigate()
  const [isCreating, setIsCreating] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [newName, setNewName] = useState('')
  const [joinRoomId, setJoinRoomId] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || actionLoading) return
    setActionLoading(true)
    setActionError(null)
    try {
      const ws = await createWorkspace(newName.trim())
      setNewName('')
      setIsCreating(false)
      navigate(`/workspace/${encodeURIComponent(ws.id)}`)
    } catch (err: any) {
      setActionError(err?.message ?? 'Failed to create workspace')
    } finally {
      setActionLoading(false)
    }
  }

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault()
    if (!joinRoomId.trim() || actionLoading) return
    setActionLoading(true)
    setActionError(null)
    try {
      const ws = await joinWorkspace(joinRoomId.trim())
      setJoinRoomId('')
      setIsJoining(false)
      navigate(`/workspace/${encodeURIComponent(ws.id)}`)
    } catch (err: any) {
      setActionError(err?.message ?? 'Failed to join workspace')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRefresh = async () => {
    setActionLoading(true)
    try {
      await refreshWorkspaces()
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="workspaces-page">
      {/* Top bar */}
      <div className="workspaces-page__topbar">
        <div className="workspaces-page__brand">
          <div className="workspaces-page__brand-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="7" width="12" height="8" rx="1.5" />
              <path d="M5 7V5a3 3 0 016 0v2" />
            </svg>
          </div>
          Secure Collab
        </div>
        <div className="workspaces-page__user">
          <AccountSwitcher direction="down" />
        </div>
      </div>

      {/* Content */}
      <div className="workspaces-page__content">
        <div className="workspaces-page__header-row">
          <div>
            <h1 className="workspaces-page__heading">Workspaces</h1>
            <p className="workspaces-page__sub">Select a workspace or create a new one.</p>
          </div>
          <button
            className="workspaces-page__refresh"
            onClick={handleRefresh}
            disabled={actionLoading}
            title="Refresh from server"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1.5 7a5.5 5.5 0 019.8-3.3M12.5 7a5.5 5.5 0 01-9.8 3.3" />
              <polyline points="11.3,1.2 11.3,3.7 8.8,3.7" />
              <polyline points="2.7,12.8 2.7,10.3 5.2,10.3" />
            </svg>
          </button>
        </div>

        {actionError && (
          <div className="workspaces-page__error" role="alert">
            {actionError}
            <button className="workspaces-page__error-dismiss" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="workspaces-grid">
          {workspaces.map(ws => (
            <div
              key={ws.id}
              className="workspace-card"
              onClick={() => navigate(`/workspace/${encodeURIComponent(ws.id)}`)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && navigate(`/workspace/${encodeURIComponent(ws.id)}`)}
            >
              <div className="workspace-card__icon">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="14" height="14" rx="2" />
                  <path d="M2 7h14M7 7v9" />
                </svg>
              </div>
              <div className="workspace-card__name">{ws.name}</div>
              <div className="workspace-card__meta">
                {ws.id.startsWith('!') ? ws.id : `Created ${formatDate(ws.createdAt)}`}
              </div>
            </div>
          ))}

          {/* New workspace */}
          {isCreating ? (
            <div className="workspace-card">
              <form className="workspace-new-form" onSubmit={handleCreate}>
                <input
                  type="text"
                  placeholder="Workspace name"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  autoFocus
                  disabled={actionLoading}
                />
                <div className="workspace-new-form__actions">
                  <button type="submit" className="primary" disabled={!newName.trim() || actionLoading}>
                    {actionLoading ? 'Creating...' : 'Create'}
                  </button>
                  <button type="button" className="ghost" onClick={() => { setIsCreating(false); setNewName('') }}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div
              className="workspace-card workspace-card--new"
              onClick={() => setIsCreating(true)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && setIsCreating(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 4v12M4 10h12" />
              </svg>
              New workspace
            </div>
          )}

          {/* Join workspace */}
          {isJoining ? (
            <div className="workspace-card">
              <form className="workspace-new-form" onSubmit={handleJoin}>
                <input
                  type="text"
                  placeholder="!room_id:homeserver.com"
                  value={joinRoomId}
                  onChange={e => setJoinRoomId(e.target.value)}
                  autoFocus
                  disabled={actionLoading}
                />
                <div className="workspace-new-form__actions">
                  <button type="submit" className="primary" disabled={!joinRoomId.trim() || actionLoading}>
                    {actionLoading ? 'Joining...' : 'Join'}
                  </button>
                  <button type="button" className="ghost" onClick={() => { setIsJoining(false); setJoinRoomId('') }}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div
              className="workspace-card workspace-card--new"
              onClick={() => setIsJoining(true)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && setIsJoining(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 4v12M4 10h12" />
              </svg>
              Join workspace
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
