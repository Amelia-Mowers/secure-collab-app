import { Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Sidebar } from '@/components/Sidebar'
import { TableView } from '@/views/table/TableView'
import { EntryView } from '@/views/entry/EntryView'
import { CardView } from '@/views/card/CardView'
import { ViewRouter } from '@/views/ViewRouter'
import { useDemoWorkspace, DEMO_WORKSPACE_ID } from '@/hooks/useDemoWorkspace'
import './DemoShell.css'

/**
 * The no-account demo (ADR 0002's funnel).
 *
 * Mounted at `/workspace/demo/*`, and that is load-bearing rather than
 * incidental: every internal link in the views — sidebar entries, card clicks,
 * view switches, entry routes — builds `/workspace/${workspaceId}/…` by hand.
 * Mounting anywhere else would leave the demo full of dead links, or force a
 * path-prefix parameter through a dozen components. Reusing the real path
 * shape means none of them need to know a demo exists.
 *
 * What is deliberately NOT here, versus WorkspaceShell:
 *
 *  - `RequireAuth`. The whole point is that a stranger sees the product before
 *    being asked for an account, a terms acceptance and a recovery key.
 *  - `ConnectionStatus`. It ORs in the browser's online state, so an offline
 *    visitor would get a full-screen "editing is paused" dialog over a
 *    workspace that never needed a network in the first place.
 *  - The encryption / read-only / send-failure banners. Each is about the state
 *    of a Matrix room, and there isn't one.
 */
export function DemoShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const { workspace, error, changeCount } = useDemoWorkspace()

  if (error) {
    return (
      <div className="app-error">
        <h3>The demo could not start</h3>
        <p>{error.message}</p>
        <button className="loading-reset" type="button" onClick={() => navigate('/signin')}>
          Create an account instead
        </button>
      </div>
    )
  }

  if (!workspace) {
    return (
      <div className="app-loading">
        <LoadingSpinner message="Building a sample workspace…" />
      </div>
    )
  }

  return (
    <div className="app">
      <DemoBanner />
      <Sidebar
        workspace={workspace}
        workspaceId={DEMO_WORKSPACE_ID}
        syncCount={changeCount}
      />
      <div className="app-main">
        <Routes>
          <Route path="/" element={<DemoHome />} />
          <Route path="/table/:tableId" element={<TableView workspace={workspace} syncCount={changeCount} />} />
          <Route
            path="/table/:tableId/view/:viewId"
            element={<ViewRouter workspace={workspace} syncCount={changeCount} />}
          />
          <Route path="/table/:tableId/cards" element={<CardView workspace={workspace} syncCount={changeCount} />} />
          <Route
            path="/table/:tableId/entry/:rowId"
            element={<EntryView workspace={workspace} syncCount={changeCount} key={location.key} />}
          />
          <Route
            path="/table/:tableId/entry/new"
            element={<EntryView workspace={workspace} syncCount={changeCount} key={location.key} />}
          />
        </Routes>
      </div>
    </div>
  )
}

/** Always visible, because the one thing a demo must never do is let someone
 *  believe they are building something that will still be there tomorrow. */
function DemoBanner() {
  const navigate = useNavigate()
  return (
    <div className="demo-banner" role="status">
      <span className="demo-banner__dot" aria-hidden="true" />
      <span className="demo-banner__text">
        <strong>Demo.</strong> Everything here runs in this tab — nothing is saved,
        and nothing is sent anywhere.
      </span>
      <button type="button" className="demo-banner__cta" onClick={() => navigate('/signin')}>
        Create an account
      </button>
    </div>
  )
}

function DemoHome() {
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-logo" />
        <h1 className="welcome-title">A sample workspace</h1>
        <p className="welcome-subtitle">
          Pick a table or a board on the left. Edit anything you like — it is
          yours until you close the tab.
        </p>
      </div>
    </div>
  )
}
