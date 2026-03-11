import { useState } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { useWorkspace } from './hooks/useTable'
import { LoadingSpinner } from './components/LoadingSpinner'
import { Sidebar } from './components/Sidebar'
import { TableView } from './views/table/TableView'
import { EntryView } from './views/entry/EntryView'
import { CardView } from './views/card/CardView'
import { ViewRouter } from './views/ViewRouter'
import './App.css'

function App() {
  const [workspaceId] = useState('demo-workspace')
  const { workspace, loading, error } = useWorkspace(workspaceId)
  const location = useLocation()

  if (loading) {
    return (
      <div className="app-loading">
        <LoadingSpinner message="Initializing workspace..." />
      </div>
    )
  }

  if (error) {
    return (
      <div className="app-error">
        <h3>Failed to Initialize Workspace</h3>
        <p>{error.message}</p>
        <details>
          <summary>Error Details</summary>
          <pre>{error.stack}</pre>
        </details>
        <p className="error-hint">
          Try refreshing the page. If the problem persists, check the browser console.
        </p>
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar workspace={workspace} />
      <div className="app-main">
        <Routes>
          <Route path="/" element={<WelcomeScreen />} />
          <Route path="/table/:tableId" element={<TableView workspace={workspace} />} />
          {/* Named view — dispatches to kanban/card/table/etc based on view_type */}
          <Route path="/table/:tableId/view/:viewId" element={<ViewRouter workspace={workspace} />} />
          {/* Direct card route (kept for compat) */}
          <Route path="/table/:tableId/cards" element={<CardView workspace={workspace} />} />
          <Route path="/table/:tableId/entry/:rowId" element={<EntryView workspace={workspace} key={location.key} />} />
          <Route path="/table/:tableId/entry/new" element={<EntryView workspace={workspace} key={location.key} />} />
        </Routes>
      </div>
    </div>
  )
}

function WelcomeScreen() {
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-logo" />
        <h1 className="welcome-title">Secure Collaborative Workspace</h1>
        <p className="welcome-subtitle">
          End-to-end encrypted, real-time collaboration built on Matrix
        </p>

        <div className="welcome-features">
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 018 0v4" />
              </svg>
            </div>
            <h3>End-to-End Encrypted</h3>
            <p>Your data is encrypted locally before sync</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <h3>Real-time Sync</h3>
            <p>Collaborate seamlessly with your team</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
              </svg>
            </div>
            <h3>Decentralized</h3>
            <p>Built on the Matrix protocol</p>
          </div>
        </div>

        <div className="getting-started">
          <h2>Getting Started</h2>
          <p>Create a table from the sidebar to begin organizing your data.</p>
        </div>
      </div>
    </div>
  )
}

export default App
