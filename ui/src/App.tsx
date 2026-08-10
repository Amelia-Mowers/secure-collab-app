import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from './hooks/useTable'
import { LoadingSpinner } from './components/LoadingSpinner'
import { Sidebar } from './components/Sidebar'
import { EncryptionWarningBanner } from './components/EncryptionWarningBanner'
import { ReadOnlyBanner } from './components/ReadOnlyBanner'
import { SendFailureBanner } from './components/SendFailureBanner'
import { VerifyDeviceScreen } from './components/VerifyDeviceScreen'
import { TableView } from './views/table/TableView'
import { EntryView } from './views/entry/EntryView'
import { CardView } from './views/card/CardView'
import { ViewRouter } from './views/ViewRouter'
import { SignInPage } from './views/auth/SignInPage'
import { JoinPage } from './views/auth/JoinPage'
import { useAutoAdmit } from './hooks/useAutoAdmit'
import { OauthCallbackPage } from './views/auth/OauthCallbackPage'
import { TrialGate } from './components/TrialStatus'
import { UpdateBanner } from './components/UpdateBanner'
import { ConnectionStatus } from './components/ConnectionStatus'
import { WorkspacesPage } from './views/workspaces/WorkspacesPage'
import { WhatsNewModal } from './components/WhatsNewModal'
import { DemoShell } from './views/demo/DemoShell'
import './App.css'

/** How long the workspace home will promise incoming tables before falling
 *  back to the ordinary empty state. Long enough for a seeded workspace's
 *  events to come back around through sync on a slow connection, short enough
 *  that a failed seeding doesn't leave someone watching a lie. */
const SEEDED_WAIT_MS = 20_000

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
  // Narrow screens get the sidebar as an off-canvas drawer instead of a
  // permanent 220px column. The state lives here rather than in Sidebar because
  // the backdrop and the toggle are siblings of it, not children.
  const [navOpen, setNavOpen] = useState(false)

  // Close the drawer once the user has gone somewhere — otherwise it stays over
  // the content they just asked for. Driven by the route rather than by each of
  // the sidebar's navigation call sites.
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])
  const { workspace, loading, error, syncCount } = useWorkspace(decodedWorkspaceId, matrixSession)

  // Let in anyone knocking with a valid invite link, while this workspace is
  // open. There is deliberately no server-side party that could do it instead
  // (issue 5e362d42), so it happens in a member's browser or not at all.
  useAutoAdmit(workspace, syncCount)

  if (loading || (!workspace && !error)) {
    return (
      <div className="app-loading">
        <LoadingSpinner
          message={matrixSession ? 'Loading history…' : 'Connecting...'}
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
      <ConnectionStatus workspace={workspace} />
      <Sidebar
        workspace={workspace}
        workspaceId={decodedWorkspaceId}
        syncCount={syncCount}
        mobileOpen={navOpen}
      />
      {/* Tapping outside the drawer closes it. Rendered only when open so it
          never intercepts clicks on a wide screen. */}
      {navOpen && (
        <div className="app__nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}
      <div className="app-main">
        {/* Mobile-only header. Lives in the shell so the hamburger does not have
            to be threaded through every view's Toolbar. */}
        <div className="app-mobile-bar">
          <button
            className="app-mobile-bar__menu"
            onClick={() => setNavOpen(o => !o)}
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <line x1="2" y1="4" x2="14" y2="4" />
              <line x1="2" y1="8" x2="14" y2="8" />
              <line x1="2" y1="12" x2="14" y2="12" />
            </svg>
          </button>
        </div>
        <ReadOnlyBanner workspace={workspace} syncCount={syncCount} />
        <SendFailureBanner workspace={workspace} workspaceId={decodedWorkspaceId} />
        <EncryptionWarningBanner workspace={workspace} syncCount={syncCount} />
        <Routes>
          <Route
            path="/"
            element={
              <WorkspaceHome
                syncing={!!matrixSession}
                workspace={workspace}
                workspaceId={decodedWorkspaceId}
                syncCount={syncCount}
              />
            }
          />
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

function WorkspaceHome({
  syncing,
  workspace,
  workspaceId,
  syncCount,
}: {
  syncing?: boolean
  workspace?: any
  workspaceId?: string
  syncCount?: number
}) {
  const navigate = useNavigate()
  const location = useLocation()
  // Set by the creation flow when the workspace was seeded from a template or
  // an archive. The seeding happens on a throwaway handle before this shell
  // exists, so the tables are not here yet when we land — they arrive on a
  // later sync tick. Until then this route would tell someone who just picked
  // a pre-filled template that their workspace is empty and they should build
  // one, which is the opposite of what they asked for.
  const hinted = (location.state as { seeded?: boolean } | null)?.seeded === true
  // If the tables never turn up — a seeding that half-failed, or a reload onto
  // a history entry still carrying the hint — stop promising them and show the
  // normal empty state, which at least offers a way forward.
  const [gaveUp, setGaveUp] = useState(false)
  const seeded = hinted && !gaveUp

  useEffect(() => {
    if (!hinted) return
    const t = setTimeout(() => setGaveUp(true), SEEDED_WAIT_MS)
    return () => clearTimeout(t)
  }, [hinted])

  useEffect(() => {
    if (!seeded || !workspace || !workspaceId) return
    let first: string | undefined
    try {
      first = (JSON.parse(workspace.listTables()) as string[])[0]
    } catch {
      return // not readable yet; a later sync tick will re-run this
    }
    if (!first) return
    // `replace`, so Back from the table goes to the workspace list rather than
    // bouncing through a home screen that immediately redirects again.
    navigate(`/workspace/${encodeURIComponent(workspaceId)}/table/${encodeURIComponent(first)}`, {
      replace: true,
    })
  }, [seeded, workspace, workspaceId, syncCount, navigate])

  if (seeded) {
    return (
      <div className="welcome">
        <div className="welcome-content">
          <div className="welcome-logo" />
          <h1 className="welcome-title">Setting up your workspace…</h1>
          <p className="welcome-subtitle">Your tables are on their way.</p>
        </div>
      </div>
    )
  }

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
      {/* Global device-security screen: gates a new device into verifying or
          restoring before it can read history, and renders verification
          prompts (emoji compare / incoming requests). */}
      <VerifyDeviceScreen />
      {/* Full-page subscribe prompt when the hosted account is locked
          (trial over / lapsed) — ADR 0002 trial-first flow. */}
      <TrialGate />
      {/* Connection status outside a workspace: browser-offline only, since
          there's no sync loop to watch yet. Inside a workspace the same
          component also watches homeserver health. */}
      <ConnectionStatus />
      <UpdateBanner />
      {/* Release notes for the version this user has not seen yet. Rendered at
          the root rather than per-route so it survives navigation, and shown at
          most once per release — a first-time visitor sees nothing. */}
      <WhatsNewModal />
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        {/* Following a workspace invite link. Outside RequireAuth on purpose:
            the whole point is that someone with no account can arrive here
            (issue 5e362d42). */}
        <Route path="/join" element={<JoinPage />} />
        {/* OAuth popup redirect target — posts the callback URL to the opener
            (which holds the WASM client mid-flow) and closes. No auth guard:
            it runs while the user is still signing in. */}
        <Route path="/oauth/callback" element={<OauthCallbackPage />} />
        <Route
          path="/workspaces"
          element={
            <RequireAuth>
              <WorkspacesPage />
            </RequireAuth>
          }
        />
        {/* The no-account demo (ADR 0002). Registered BEFORE the general
            workspace route and matched ahead of it, because react-router ranks
            the static `demo` segment above the `:workspaceId` parameter — so
            this is the specific case and the route below stays untouched.

            It lives under /workspace/ on purpose: every internal link in the
            views builds `/workspace/${id}/...` by hand, so mounting the demo
            anywhere else would fill it with dead links. /demo redirects here. */}
        <Route path="/workspace/demo/*" element={<DemoShell />} />
        <Route path="/demo" element={<Navigate to="/workspace/demo" replace />} />
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
