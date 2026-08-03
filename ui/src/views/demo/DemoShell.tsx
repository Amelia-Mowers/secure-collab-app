import { useEffect, useState } from 'react'
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

  // The off-canvas drawer, same as WorkspaceShell. It was missing here, and the
  // consequence was worse than a layout blemish: below 768px the sidebar sits at
  // left:-300px, this shell rendered no hamburger and no backdrop, and so a
  // phone visitor arriving from the marketing CTA hit a dead end — on the screen
  // that says "Pick a table or a board on the left", with 19 tables and views
  // off-canvas and nothing on the page able to reach them. The only button was
  // "Create an account". That is the funnel, and it did not work on a phone.
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

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
    // A column: banner, then the shell. The banner used to be `position: fixed`
    // with the shell clearing it via `padding-top: 37px` — a number measured on a
    // desktop, where the banner is one line. At 390px its text wraps to three, so
    // the banner covered the top of the shell, which is exactly where the mobile
    // bar lives: the hamburger rendered, and every tap landed on the banner
    // instead. In normal flow its height is whatever it actually is, at any width
    // and any number of wrapped lines, with no constant to keep in step.
    <div className="demo-shell">
      <DemoBanner />
      <div className="app">
        <Sidebar
          workspace={workspace}
          workspaceId={DEMO_WORKSPACE_ID}
          syncCount={changeCount}
          mobileOpen={navOpen}
        />
        {navOpen && (
          <div className="app__nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
        )}
        <div className="app-main">
          <div className="app-mobile-bar">
            <button
              className="app-mobile-bar__menu"
              onClick={() => setNavOpen(o => !o)}
              aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={navOpen}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="14" y2="12" />
              </svg>
            </button>
          </div>
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
        {/* "on the left" is only true where there IS a left. Below 768px the
            sidebar is a drawer behind the ☰ button, so the instruction has to
            change with it — an empty screen telling you to use something that is
            not on it is worse than saying nothing at all. */}
        <p className="welcome-subtitle">
          <span className="only-wide">Pick a table or a board on the left.</span>
          <span className="only-narrow">Tap ☰ to pick a table or a board.</span> Edit
          anything you like — it is yours until you close the tab.
        </p>
      </div>
    </div>
  )
}
