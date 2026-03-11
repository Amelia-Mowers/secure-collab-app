import { useState, useCallback } from 'react'

export interface WorkspaceEntry {
  id: string
  name: string
  createdAt: number
}

const USERNAME_KEY = 'collab:username'
const WORKSPACES_KEY = 'collab:workspaces'

function loadUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY)
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

export function useAuth() {
  const [username, setUsername] = useState<string | null>(loadUsername)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(loadWorkspaces)

  const signIn = useCallback((name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    localStorage.setItem(USERNAME_KEY, trimmed)
    setUsername(trimmed)
  }, [])

  const signOut = useCallback(() => {
    localStorage.removeItem(USERNAME_KEY)
    setUsername(null)
  }, [])

  const createWorkspace = useCallback((name: string): WorkspaceEntry => {
    const id = `ws_${name.toLowerCase().replace(/\s+/g, '-')}_${Date.now()}`
    const entry: WorkspaceEntry = { id, name: name.trim(), createdAt: Date.now() }
    setWorkspaces(prev => {
      const next = [...prev, entry]
      saveWorkspaces(next)
      return next
    })
    return entry
  }, [])

  const deleteWorkspace = useCallback((id: string) => {
    setWorkspaces(prev => {
      const next = prev.filter(w => w.id !== id)
      saveWorkspaces(next)
      return next
    })
  }, [])

  return { username, workspaces, signIn, signOut, createWorkspace, deleteWorkspace }
}
