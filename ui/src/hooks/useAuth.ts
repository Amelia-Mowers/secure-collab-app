import { useState, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  id: string
  name: string
  createdAt: number
}

/** Persisted session metadata (survives page reloads). */
interface StoredSession {
  homeserverUrl: string
  userId: string
  username: string
}

// ── Local-storage keys ───────────────────────────────────────────────────────

const SESSION_KEY = 'collab:session'
const WORKSPACES_KEY = 'collab:workspaces'

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveSession(session: StoredSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

function loadWorkspaces(): WorkspaceEntry[] {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveWorkspaces(workspaces: WorkspaceEntry[]) {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces))
}

// ── WASM module lazy loader ──────────────────────────────────────────────────

let wasmModulePromise: Promise<any> | null = null

async function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const mod = await import('../wasm/app_core.js')
      await mod.default()
      mod.init_panic_hook()
      return mod
    })()
  }
  return wasmModulePromise
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth() {
  const [session, setSession] = useState<StoredSession | null>(loadSession)
  const [matrixSession, setMatrixSession] = useState<any>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(loadWorkspaces)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived values
  const username = session?.username ?? null
  const userId = session?.userId ?? null
  const homeserverUrl = session?.homeserverUrl ?? null

  /**
   * Log in to a Matrix homeserver.
   * Creates a MatrixSession via WASM, performs initial sync, and persists
   * the session metadata to localStorage.
   */
  const signIn = useCallback(
    async (homeserver: string, user: string, password: string) => {
      setLoading(true)
      setError(null)

      try {
        const wasm = await getWasmModule()
        const ms = await wasm.MatrixSession.login(homeserver, user, password)
        await ms.initialSync()

        const uid = ms.userId() ?? `@${user}:unknown`

        const stored: StoredSession = {
          homeserverUrl: homeserver,
          userId: uid,
          username: user,
        }
        saveSession(stored)
        setSession(stored)
        setMatrixSession(ms)

        // Populate workspace list from joined rooms
        const roomsJson = ms.listRooms()
        const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
        const entries: WorkspaceEntry[] = rooms.map(r => ({
          id: r.id,
          name: r.name || r.id,
          createdAt: Date.now(),
        }))
        setWorkspaces(entries)
        saveWorkspaces(entries)
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

  const signOut = useCallback(() => {
    clearSession()
    localStorage.removeItem(WORKSPACES_KEY)
    setSession(null)
    setMatrixSession(null)
    setWorkspaces([])
    setError(null)
    // Reset WASM module so a fresh login gets a new client
    wasmModulePromise = null
  }, [])

  /**
   * Create a new Matrix room (workspace).
   * Returns the workspace entry once the room is created.
   */
  const createWorkspace = useCallback(
    async (name: string): Promise<WorkspaceEntry> => {
      if (!matrixSession) throw new Error('Not signed in')
      const roomId: string = await matrixSession.createRoom(name)
      const entry: WorkspaceEntry = { id: roomId, name, createdAt: Date.now() }
      setWorkspaces(prev => {
        const next = [...prev, entry]
        saveWorkspaces(next)
        return next
      })
      return entry
    },
    [matrixSession],
  )

  /**
   * Join an existing Matrix room by ID and add it to the workspace list.
   */
  const joinWorkspace = useCallback(
    async (roomId: string): Promise<WorkspaceEntry> => {
      if (!matrixSession) throw new Error('Not signed in')
      await matrixSession.joinRoom(roomId)
      // Re-sync to pick up the new room
      await matrixSession.initialSync()
      const roomsJson = matrixSession.listRooms()
      const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
      const room = rooms.find(r => r.id === roomId)
      const entry: WorkspaceEntry = {
        id: roomId,
        name: room?.name || roomId,
        createdAt: Date.now(),
      }
      setWorkspaces(prev => {
        // Avoid duplicates
        if (prev.some(w => w.id === roomId)) return prev
        const next = [...prev, entry]
        saveWorkspaces(next)
        return next
      })
      return entry
    },
    [matrixSession],
  )

  /** Refresh the workspace list from the Matrix server. */
  const refreshWorkspaces = useCallback(async () => {
    if (!matrixSession) return
    try {
      await matrixSession.initialSync()
      const roomsJson = matrixSession.listRooms()
      const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
      const entries: WorkspaceEntry[] = rooms.map(r => ({
        id: r.id,
        name: r.name || r.id,
        createdAt: Date.now(),
      }))
      setWorkspaces(entries)
      saveWorkspaces(entries)
    } catch (err) {
      console.error('Failed to refresh workspaces:', err)
    }
  }, [matrixSession])

  return {
    // State
    username,
    userId,
    homeserverUrl,
    matrixSession,
    workspaces,
    loading,
    error,
    // Actions
    signIn,
    signOut,
    createWorkspace,
    joinWorkspace,
    refreshWorkspaces,
  }
}
