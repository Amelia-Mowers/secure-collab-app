import { useEffect } from 'react'
import { Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from './hooks/useTable'
import { LoadingSpinner } from './components/LoadingSpinner'
import { Sidebar } from './components/Sidebar'
import { TableView } from './views/table/TableView'
import { EntryView } from './views/entry/EntryView'
import { CardView } from './views/card/CardView'
import { ViewRouter } from './views/ViewRouter'
import { SignInPage } from './views/auth/SignInPage'
import { WorkspacesPage } from './views/workspaces/WorkspacesPage'
import './App.css'

/** Guard: redirect to /signin if not authenticated */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!username) navigate('/signin', { replace: true })
  }, [username, navigate])
  if (!username) return null
  return <>{children}</>
}

/** The main workspace shell — loads WASM for a specific workspace ID */
function WorkspaceShell() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { username, matrixSession } = useAuth()
  const location = useLocation()
  const decodedWorkspaceId = decodeURIComponent(workspaceId!)
  const { workspace, loading, error, syncCount } = useWorkspace(decodedWorkspaceId, matrixSession)

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
      <Sidebar workspace={workspace} username={username} workspaceId={decodedWorkspaceId} />
      <div className="app-main">
        <Routes>
          <Route path="/" element={<WorkspaceHome syncing={!!matrixSession} />} />
          <Route path="/table/:tableId" element={<TableView workspace={workspace} key={syncCount} />} />
          <Route path="/table/:tableId/view/:viewId" element={<ViewRouter workspace={workspace} key={syncCount} />} />
          <Route path="/table/:tableId/cards" element={<CardView workspace={workspace} key={syncCount} />} />
          <Route
            path="/table/:tableId/entry/:rowId"
            element={<EntryView workspace={workspace} key={`${location.key}-${syncCount}`} />}
          />
          <Route
            path="/table/:tableId/entry/new"
            element={<EntryView workspace={workspace} key={`${location.key}-${syncCount}`} />}
          />
        </Routes>
      </div>
    </div>
  )
}

function WorkspaceHome({ syncing }: { syncing?: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-logo" />
        <h1 className="welcome-title">Your Workspace</h1>
        <p className="welcome-subtitle">Create a table from the sidebar to get started.</p>
        {syncing && (
          <p className="welcome-sync-hint">
            Connected to Matrix. Changes sync in real time.
          </p>
        )}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route
        path="/workspaces"
        element={
          <RequireAuth>
            <WorkspacesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/workspace/:workspaceId/*"
        element={
          <RequireAuth>
            <WorkspaceShell />
          </RequireAuth>
        }
      />
      {/* Default redirect */}
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  )
}

function RootRedirect() {
  const { username } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (username) navigate('/workspaces', { replace: true })
    else navigate('/signin', { replace: true })
  }, [username, navigate])
  return null
}
