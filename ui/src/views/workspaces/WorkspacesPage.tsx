import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import './WorkspacesPage.css'

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function WorkspacesPage() {
  const { username, workspaces, signOut, createWorkspace, deleteWorkspace } = useAuth()
  const navigate = useNavigate()
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const ws = createWorkspace(newName.trim())
    setNewName('')
    setIsCreating(false)
    navigate(`/workspace/${ws.id}`)
  }

  const handleSignOut = () => {
    signOut()
    navigate('/signin')
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
          <div className="workspaces-page__avatar">{username?.[0]?.toUpperCase()}</div>
          <span>{username}</span>
          <button className="workspaces-page__signout" onClick={handleSignOut}>Sign out</button>
        </div>
      </div>

      {/* Content */}
      <div className="workspaces-page__content">
        <h1 className="workspaces-page__heading">Workspaces</h1>
        <p className="workspaces-page__sub">Select a workspace or create a new one.</p>

        <div className="workspaces-grid">
          {workspaces.map(ws => (
            <div
              key={ws.id}
              className="workspace-card"
              onClick={() => navigate(`/workspace/${ws.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && navigate(`/workspace/${ws.id}`)}
            >
              <div className="workspace-card__icon">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="14" height="14" rx="2" />
                  <path d="M2 7h14M7 7v9" />
                </svg>
              </div>
              <div className="workspace-card__name">{ws.name}</div>
              <div className="workspace-card__meta">Created {formatDate(ws.createdAt)}</div>
              <button
                className="workspace-card__delete"
                title="Delete workspace"
                onClick={e => { e.stopPropagation(); deleteWorkspace(ws.id) }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <polyline points="1,3 12,3" />
                  <path d="M4.5 3V2a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1" />
                  <rect x="2.5" y="3" width="8" height="8.5" rx="1" />
                </svg>
              </button>
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
                />
                <div className="workspace-new-form__actions">
                  <button type="submit" className="primary" disabled={!newName.trim()}>Create</button>
                  <button type="button" className="ghost" onClick={() => { setIsCreating(false); setNewName('') }}>Cancel</button>
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
        </div>
      </div>
    </div>
  )
}
