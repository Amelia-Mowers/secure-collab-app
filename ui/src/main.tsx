import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { DialogProvider } from './components/dialogs/DialogProvider'
import { AuthProvider } from './hooks/useAuth'
import App from './App'
import { reapStores } from './lib/storeReaper'
import './styles/theme.css'
import './index.css'

// Collect IndexedDB stores orphaned by a previous sign-out. This runs HERE,
// before React mounts and therefore before AuthProvider restores a session,
// because that is the one moment in the app's life when the shared worker is
// guaranteed not to hold a store open — and a database somebody has open
// cannot be deleted, only blocked. Deliberately not awaited: a slow reap must
// not delay first paint, and anything it misses is simply queued again.
void reapStores()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* basename keeps routing correct under sub-path deployments (GH Pages
        serves at /<repo>/) — without it the OAuth callback route never
        matches there. '/' on root-path hosts, so this is always right. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        {/* Themed confirm/prompt/notice. Mounted once at the root so any
            component can reach it; outside it the hook falls back to the
            native dialogs (see DialogProvider). */}
        <DialogProvider>
          <App />
        </DialogProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
