import { useState, useCallback, useContext, createContext, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { getWasmModule } from '../wasm/loader'

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  id: string
  name: string
  createdAt: number
}

/** Persisted per-account data (shared across tabs via localStorage). */
export interface AccountSession {
  homeserverUrl: string
  userId: string
  username: string
  /** Opaque JSON blob returned by MatrixSession.sessionData() */
  matrixSessionData: string
}

interface AuthState {
  // Active account state
  username: string | null
  userId: string | null
  homeserverUrl: string | null
  matrixSession: any
  workspaces: WorkspaceEntry[]
  /** True during sign-in or session restoration. */
  loading: boolean
  error: string | null

  // Multi-account
  accounts: AccountSession[]
  activeAccountId: string | null

  // Actions
  signIn: (homeserver: string, user: string, password: string) => Promise<void>
  signOut: () => void
  createWorkspace: (name: string) => Promise<WorkspaceEntry>
  joinWorkspace: (roomId: string) => Promise<WorkspaceEntry>
  refreshWorkspaces: () => Promise<void>

  // Multi-account actions
  switchAccount: (userId: string) => Promise<void>
  removeAccount: (userId: string) => void

  /** Nuclear option: clear all stored data and reload the app. */
  resetApp: () => void
}

// ── Local-storage keys ───────────────────────────────────────────────────────

const ACCOUNTS_KEY = 'collab:accounts'
const ACTIVE_ACCOUNT_KEY = 'collab:activeAccount'
const WORKSPACES_KEY = 'collab:workspaces'

// Legacy key — used for migration from single-account format
const LEGACY_SESSION_KEY = 'collab:session'

// ── Account pool (localStorage — shared across tabs) ─────────────────────────

function loadAccounts(): AccountSession[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    if (raw) return JSON.parse(raw)

    // Migrate from single-account format
    const legacy = localStorage.getItem(LEGACY_SESSION_KEY)
    if (legacy) {
      const session = JSON.parse(legacy)
      if (session?.matrixSessionData) {
        const account: AccountSession = {
          homeserverUrl: session.homeserverUrl,
          userId: session.userId,
          username: session.username,
          matrixSessionData: session.matrixSessionData,
        }
        saveAccounts([account])
        localStorage.removeItem(LEGACY_SESSION_KEY)
        return [account]
      }
    }
    return []
  } catch {
    return []
  }
}

function saveAccounts(accounts: AccountSession[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts))
  // Clean up legacy key if it exists
  localStorage.removeItem(LEGACY_SESSION_KEY)
}

// ── Active account (sessionStorage — per-tab/window) ─────────────────────────

function loadActiveAccountId(accounts: AccountSession[]): string | null {
  try {
    const id = sessionStorage.getItem(ACTIVE_ACCOUNT_KEY)
    // Validate that the account still exists in the pool
    if (id && accounts.some(a => a.userId === id)) return id
    // Fall back to the first account
    return accounts.length > 0 ? accounts[0].userId : null
  } catch {
    return accounts.length > 0 ? accounts[0].userId : null
  }
}

function saveActiveAccountId(userId: string | null) {
  if (userId) {
    sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, userId)
  } else {
    sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY)
  }
}

// ── Per-account workspace storage ────────────────────────────────────────────

function workspacesKey(userId: string): string {
  return `${WORKSPACES_KEY}:${userId}`
}

function loadWorkspaces(userId: string | null): WorkspaceEntry[] {
  if (!userId) return []
  try {
    // Try per-account key first
    const perAccount = localStorage.getItem(workspacesKey(userId))
    if (perAccount) return JSON.parse(perAccount)
    // Fall back to legacy shared key
    const legacy = localStorage.getItem(WORKSPACES_KEY)
    if (legacy) return JSON.parse(legacy)
    return []
  } catch {
    return []
  }
}

function saveWorkspaces(userId: string, workspaces: WorkspaceEntry[]) {
  localStorage.setItem(workspacesKey(userId), JSON.stringify(workspaces))
}

function clearWorkspaces(userId: string) {
  localStorage.removeItem(workspacesKey(userId))
}

// ── Workspace room filtering ─────────────────────────────────────────────────

/** Parse the room list JSON and filter to only workspace-tagged rooms. */
function parseWorkspaceRooms(roomsJson: string): WorkspaceEntry[] {
  const rooms: { id: string; name: string; isWorkspace: boolean }[] = JSON.parse(roomsJson)
  return rooms
    .filter(r => r.isWorkspace)
    .map(r => ({
      id: r.id,
      name: r.name || r.id,
      createdAt: Date.now(),
    }))
}

// ── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null)

/** Provide auth state to the component tree. Wrap your <App> with this. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountSession[]>(loadAccounts)
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => {
    const accs = loadAccounts()
    return loadActiveAccountId(accs)
  })
  const [matrixSession, setMatrixSession] = useState<any>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(() =>
    loadWorkspaces(loadActiveAccountId(loadAccounts())),
  )
  // Start loading=true when there's a stored session to restore, so the UI
  // doesn't briefly flash the unauthenticated state before restore completes.
  const [loading, setLoading] = useState(() => {
    const accs = loadAccounts()
    const activeId = loadActiveAccountId(accs)
    return !!accs.find(a => a.userId === activeId)?.matrixSessionData
  })
  const [error, setError] = useState<string | null>(null)

  // Keep a ref so callbacks always see the latest matrixSession
  const matrixSessionRef = useRef<any>(null)

  // Track whether we've attempted auto-restore (to avoid double-restoring)
  const restoredRef = useRef(false)

  // Derive active account info
  const activeAccount = accounts.find(a => a.userId === activeAccountId) ?? null
  const username = activeAccount?.username ?? null
  const userId = activeAccount?.userId ?? null
  const homeserverUrl = activeAccount?.homeserverUrl ?? null

  // ── Helper: restore a Matrix session for an account ────────────────────────
  //
  // `initialSync()` calls the Matrix SDK's `sync_once()` which long-polls the
  // homeserver.  When another tab already holds the sync stream for the same
  // device, the server may hold the request for 30+ seconds, causing the new
  // tab to hang.  We race it against a short timeout so the UI can proceed.
  // The session is still fully usable — `ConnectedWorkspace.create()` may need
  // to retry until the SDK cache is populated.
  const restoreSession = useCallback(async (account: AccountSession) => {
    console.log('[auth] Loading WASM module...')
    const wasm = await getWasmModule()
    console.log('[auth] WASM loaded, restoring Matrix session for', account.userId)

    // Race MatrixSession.restore() against a timeout.  The Rust side builds
    // a Client (connects to homeserver) and calls restore_session — both are
    // async and can hang if the homeserver is unreachable or slow.
    const RESTORE_TIMEOUT_MS = 10_000
    const restorePromise = wasm.MatrixSession.restore(
      account.homeserverUrl,
      account.matrixSessionData,
    )
    const restoreTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MatrixSession.restore() timed out')), RESTORE_TIMEOUT_MS),
    )
    const ms = await Promise.race([restorePromise, restoreTimeout])
    console.log('[auth] Matrix session restored, running initialSync...')

    // Race initialSync against a 5-second timeout.  If it loses, we still
    // return the session and let initialSync finish in the background.
    const SYNC_TIMEOUT_MS = 5_000
    const syncDone = ms.initialSync()
    const timeout = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), SYNC_TIMEOUT_MS),
    )

    const result = await Promise.race([
      syncDone.then(() => 'ok' as const),
      timeout,
    ])

    if (result === 'timeout') {
      console.warn(
        '[auth] initialSync timed out (another tab may hold the sync stream). ' +
        'Continuing with cached session — workspace init will retry.',
      )
      // Let it finish in the background (populates SDK room cache)
      syncDone.catch((err: any) => console.warn('[auth] Background initialSync failed:', err))
    } else {
      console.log('[auth] initialSync completed')
    }

    return ms
  }, [])

  // ── Auto-restore session on mount ──────────────────────────────────────────
  //
  // Note: We intentionally use an empty dependency array and guard with
  // `restoredRef` so this only runs once, even in React Strict Mode.
  // Strict Mode calls cleanup between its double-mount, which would set a
  // `cancelled` flag and cause the async work to silently discard its result
  // — that was the root cause of the "Connecting..." hang on duplicate tabs.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    const accs = loadAccounts()
    const activeId = loadActiveAccountId(accs)
    const account = accs.find(a => a.userId === activeId)
    console.log('[auth] Auto-restore: activeId =', activeId, ', account found =', !!account?.matrixSessionData)
    if (!account?.matrixSessionData) {
      console.log('[auth] No session data to restore, skipping')
      return
    }

    setLoading(true)

    ;(async () => {
      try {
        console.log('[auth] Starting session restore for', account.username)
        const ms = await restoreSession(account)

        console.log('[auth] Session restore complete, setting matrixSession')
        matrixSessionRef.current = ms
        setMatrixSession(ms)

        // Refresh workspace list from server.
        // If initialSync timed out, listRooms may return an empty list
        // because the SDK cache is empty. In that case, keep the locally
        // cached workspaces so the user can still navigate.
        try {
          const roomsJson = await ms.listRooms()
          const entries = parseWorkspaceRooms(roomsJson)
          console.log('[auth] listRooms returned', entries.length, 'workspaces')
          if (entries.length > 0) {
            setWorkspaces(entries)
            saveWorkspaces(account.userId, entries)
          }
        } catch (listErr) {
          console.warn('[auth] listRooms failed after restore (sync may still be running):', listErr)
        }
      } catch (err: any) {
        console.error('[auth] Session restore failed:', err)
        // Don't remove the account on timeout — only on auth errors.
        // A timeout just means the server is slow, not that creds are bad.
        const isTimeout = err?.message?.includes('timed out')
        if (isTimeout) {
          console.warn('[auth] Restore timed out, keeping account but clearing loading state')
          setError('Connection to homeserver is slow. You may need to reload.')
        } else {
          // Remove the stale account from the pool
          const updated = accs.filter(a => a.userId !== account.userId)
          saveAccounts(updated)
          setAccounts(updated)
          clearWorkspaces(account.userId)
          // Switch to next account or clear
          const nextId = updated.length > 0 ? updated[0].userId : null
          setActiveAccountId(nextId)
          saveActiveAccountId(nextId)
          setWorkspaces(nextId ? loadWorkspaces(nextId) : [])
          setError('Session expired. Please sign in again.')
        }
      } finally {
        console.log('[auth] Restore flow finished, setting loading=false')
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── signIn: add or update an account in the pool ───────────────────────────
  const signIn = useCallback(
    async (homeserver: string, user: string, password: string) => {
      setLoading(true)
      setError(null)

      try {
        const wasm = await getWasmModule()
        const ms = await wasm.MatrixSession.login(homeserver, user, password)
        await ms.initialSync()

        const uid = ms.userId() ?? `@${user}:unknown`

        // Persist full session data including tokens
        const matrixSessionData: string = ms.sessionData()

        const account: AccountSession = {
          homeserverUrl: homeserver,
          userId: uid,
          username: user,
          matrixSessionData,
        }

        // Add or update in the account pool
        setAccounts(prev => {
          const updated = prev.filter(a => a.userId !== uid)
          updated.push(account)
          saveAccounts(updated)
          return updated
        })

        // Set as active for this window
        setActiveAccountId(uid)
        saveActiveAccountId(uid)

        matrixSessionRef.current = ms
        setMatrixSession(ms)

        // Populate workspace list from joined rooms (filtered)
        const roomsJson = await ms.listRooms()
        const entries = parseWorkspaceRooms(roomsJson)
        setWorkspaces(entries)
        saveWorkspaces(uid, entries)
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        setError(msg)
        throw new Error(msg)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // ── signOut: remove the active account from the pool ───────────────────────
  const signOut = useCallback(() => {
    const currentId = activeAccountId

    setAccounts(prev => {
      const updated = currentId ? prev.filter(a => a.userId !== currentId) : []
      saveAccounts(updated)

      // Switch to next account if available
      const nextId = updated.length > 0 ? updated[0].userId : null
      setActiveAccountId(nextId)
      saveActiveAccountId(nextId)

      if (currentId) clearWorkspaces(currentId)

      if (nextId) {
        setWorkspaces(loadWorkspaces(nextId))
        // Trigger restore for the new active account on next render
      } else {
        setWorkspaces([])
      }

      return updated
    })

    matrixSessionRef.current = null
    setMatrixSession(null)
    setError(null)
    // Don't clear wasm module — other accounts may still need it
  }, [activeAccountId])

  // ── switchAccount: change which account is active in this window ────────────
  const switchAccount = useCallback(
    async (targetUserId: string) => {
      const account = accounts.find(a => a.userId === targetUserId)
      if (!account) throw new Error(`Account ${targetUserId} not found`)
      if (targetUserId === activeAccountId && matrixSessionRef.current) return

      setLoading(true)
      setError(null)
      matrixSessionRef.current = null
      setMatrixSession(null)

      setActiveAccountId(targetUserId)
      saveActiveAccountId(targetUserId)
      setWorkspaces(loadWorkspaces(targetUserId))

      try {
        const ms = await restoreSession(account)

        matrixSessionRef.current = ms
        setMatrixSession(ms)

        // Refresh workspaces from server
        const roomsJson = await ms.listRooms()
        const entries = parseWorkspaceRooms(roomsJson)
        setWorkspaces(entries)
        saveWorkspaces(targetUserId, entries)
      } catch (err: any) {
        console.error('Switch account failed:', err)
        setError(`Failed to restore session for ${account.username}: ${err.message}`)
      } finally {
        setLoading(false)
      }
    },
    [accounts, activeAccountId, restoreSession],
  )

  // ── removeAccount: remove a specific account from the pool ─────────────────
  const removeAccount = useCallback(
    (targetUserId: string) => {
      setAccounts(prev => {
        const updated = prev.filter(a => a.userId !== targetUserId)
        saveAccounts(updated)
        return updated
      })
      clearWorkspaces(targetUserId)

      // If we removed the active account, switch to another or clear
      if (targetUserId === activeAccountId) {
        const remaining = accounts.filter(a => a.userId !== targetUserId)
        const nextId = remaining.length > 0 ? remaining[0].userId : null

        setActiveAccountId(nextId)
        saveActiveAccountId(nextId)
        matrixSessionRef.current = null
        setMatrixSession(null)
        setWorkspaces(nextId ? loadWorkspaces(nextId) : [])
      }
    },
    [accounts, activeAccountId],
  )

  // ── createWorkspace ────────────────────────────────────────────────────────
  const createWorkspace = useCallback(
    async (name: string): Promise<WorkspaceEntry> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')
      const roomId: string = await ms.createRoom(name)
      const entry: WorkspaceEntry = { id: roomId, name, createdAt: Date.now() }
      setWorkspaces(prev => {
        const next = [...prev, entry]
        if (activeAccountId) saveWorkspaces(activeAccountId, next)
        return next
      })
      return entry
    },
    [activeAccountId],
  )

  // ── joinWorkspace ──────────────────────────────────────────────────────────
  const joinWorkspace = useCallback(
    async (roomId: string): Promise<WorkspaceEntry> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')
      await ms.joinRoom(roomId)
      await ms.initialSync()
      const roomsJson = await ms.listRooms()
      const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
      const room = rooms.find(r => r.id === roomId)
      const entry: WorkspaceEntry = {
        id: roomId,
        name: room?.name || roomId,
        createdAt: Date.now(),
      }
      setWorkspaces(prev => {
        if (prev.some(w => w.id === roomId)) return prev
        const next = [...prev, entry]
        if (activeAccountId) saveWorkspaces(activeAccountId, next)
        return next
      })
      return entry
    },
    [activeAccountId],
  )

  // ── refreshWorkspaces ──────────────────────────────────────────────────────
  const refreshWorkspaces = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms) return
    try {
      await ms.initialSync()
      const roomsJson = await ms.listRooms()
      const entries = parseWorkspaceRooms(roomsJson)
      setWorkspaces(entries)
      if (activeAccountId) saveWorkspaces(activeAccountId, entries)
    } catch (err) {
      console.error('Failed to refresh workspaces:', err)
    }
  }, [activeAccountId])

  // ── resetApp: clear everything and reload ─────────────────────────────────
  const resetApp = useCallback(() => {
    // Clear all collab-related localStorage keys
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('collab:')) keysToRemove.push(key)
    }
    keysToRemove.forEach(k => localStorage.removeItem(k))

    // Also clear legacy key
    localStorage.removeItem(LEGACY_SESSION_KEY)

    // Clear sessionStorage
    sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY)

    // Reload the page to get a clean state
    window.location.replace('/signin')
  }, [])

  const value: AuthState = {
    username,
    userId,
    homeserverUrl,
    matrixSession,
    workspaces,
    loading,
    error,
    accounts,
    activeAccountId,
    signIn,
    signOut,
    createWorkspace,
    joinWorkspace,
    refreshWorkspaces,
    switchAccount,
    removeAccount,
    resetApp,
  }

  return createElement(AuthContext.Provider, { value }, children)
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/** Consume auth state from the nearest AuthProvider. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
