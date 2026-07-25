import { useEffect, useState } from 'react'
import type { Role } from '@/lib/roles'

/**
 * This user's role in the connected workspace.
 *
 * Defaults to `editor` when the workspace can't tell us (a local-only or mock
 * workspace, or older bindings). That direction is deliberate: the homeserver
 * is the real gate, so guessing "editor" at worst offers a control whose write
 * the server then refuses — whereas guessing "viewer" would lock a legitimate
 * editor out of their own data over a missing method.
 */
export function useRole(workspace: any, syncCount?: number): Role {
  const [role, setRole] = useState<Role>('editor')

  useEffect(() => {
    let cancelled = false
    if (!workspace || typeof workspace.myRole !== 'function') {
      setRole('editor')
      return
    }
    Promise.resolve(workspace.myRole())
      .then((r: string) => {
        if (!cancelled && (r === 'admin' || r === 'editor' || r === 'viewer')) setRole(r)
      })
      .catch(() => {
        if (!cancelled) setRole('editor')
      })
    return () => {
      cancelled = true
    }
  }, [workspace, syncCount])

  return role
}
