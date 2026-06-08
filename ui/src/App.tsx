import { useEffect } from 'react'
import { Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from './hooks/useTable'
import { LoadingSpinner } from './components/LoadingSpinner'
import { Sidebar } from './components/Sidebar'
import { EncryptionWarningBanner } from './components/EncryptionWarningBanner'
import { UnverifiedDevicesBanner } from './components/UnverifiedDevicesBanner'
import { RecoveryGate } from './components/RecoveryGate'
import { TableView } from './views/table/TableView'
import { EntryView } from './views/entry/EntryView'
import { CardView } from './views/card/CardView'
import { ViewRouter } from './views/ViewRouter'
import { SignInPage } from './views/auth/SignInPage'
import { WorkspacesPage } from './views/workspaces/WorkspacesPage'
import './App.css'

/** Guard: redirect to /signin if not authenticated */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username, accounts, resetApp } = useAuth()
  const navigate = useNavigate()

  // `username` is derived synchronously from localStorage (accounts + activeAccountId),
  // so it's available immediately even before the Matrix session finishes restoring.
  // We only need to redirect when there truly are no stored accounts.
  useEffect(() => {
    if (!username && accounts.length === 0) {
      navigate('/signin', { replace: true })
    }
  }, [username, accounts.length, navigate])

  // If we have stored accounts but username isn't set yet (e.g. accounts exist
  // but activeAccountId couldn't be resolved), show a brief spinner.
  if (!username && accounts.length > 0) {
    return (
      <div className="app-loading">
        <LoadingSpinner message="Restoring session..." onReset={resetApp} />
      </div>
    )
  }

  if (!username) return null
  return <>{children}</>
}

/** The main workspace shell — loads WASM for a specific workspace ID */
function WorkspaceShell() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { matrixSession, resetApp } = useAuth()
  const location = useLocation()
  const decodedWorkspaceId = decodeURIComponent(workspaceId!)
  const { workspace, loading, error, syncCount } = useWorkspace(decodedWorkspaceId, matrixSession)

  if (loading || (!workspace && !error)) {
    return (
      <div className="app-loading">
        <LoadingSpinner
          message={matrixSession ? 'Initializing workspace...' : 'Connecting...'}
          onReset={resetApp}
        />
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
        <button className="loading-reset" onClick={resetApp} type="button" style={{ marginTop: 16 }}>
          Reset app data
        </button>
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar workspace={workspace} workspaceId={decodedWorkspaceId} syncCount={syncCount} />
      <div className="app-main">
        <EncryptionWarningBanner workspace={workspace} syncCount={syncCount} />
        <UnverifiedDevicesBanner workspace={workspace} syncCount={syncCount} />
        <Routes>
          <Route path="/" element={<WorkspaceHome syncing={!!matrixSession} />} />
          <Route path="/table/:tableId" element={<TableView workspace={workspace} syncCount={syncCount} />} />
          <Route path="/table/:tableId/view/:viewId" element={<ViewRouter workspace={workspace} syncCount={syncCount} />} />
          <Route path="/table/:tableId/cards" element={<CardView workspace={workspace} syncCount={syncCount} />} />
          <Route
            path="/table/:tableId/entry/:rowId"
            element={<EntryView workspace={workspace} syncCount={syncCount} key={location.key} />}
          />
          <Route
            path="/table/:tableId/entry/new"
            element={<EntryView workspace={workspace} syncCount={syncCount} key={location.key} />}
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
    <>
      {/* Global recovery gate: ensures a signed-in device can reach history
          (bootstrap on first device, or restore on a returning one). */}
      <RecoveryGate />
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
    </>
  )
}

function RootRedirect() {
  const { username, accounts } = useAuth()
  const navigate = useNavigate()

  // Don't wait for the full session restore here — just decide where to go.
  // If accounts exist in localStorage the user has signed in before, so send
  // them to /workspaces where RequireAuth will show a spinner while the
  // session finishes restoring.  This avoids getting stuck on "Restoring
  // session..." at the root URL when initialSync is slow.
  useEffect(() => {
    if (username || accounts.length > 0) {
      navigate('/workspaces', { replace: true })
    } else {
      navigate('/signin', { replace: true })
    }
  }, [username, accounts.length, navigate])

  return null
}
