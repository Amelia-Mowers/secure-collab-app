import { useEffect, useState } from 'react'
import { useRole } from '@/hooks/useRole'
import './EncryptionWarningBanner.css'

interface ReadOnlyBannerProps {
  workspace: any
  /** Re-check when sync delivers events (encryption state is known after the
   *  room loads). */
  syncCount?: number
}

/**
 * Workspace-level banner for the two reasons editing can be unavailable:
 *
 * 1. The room is NOT end-to-end encrypted — a "legacy" room from before
 *    encryption was required. The bridge send path fails closed, so writes
 *    never persist.
 * 2. This user's role is `viewer`. That's a Matrix power level below
 *    `events_default`, so the HOMESERVER refuses their events — the read-only
 *    state is real, not a UI convention.
 *
 * Either way the user needs to know why their changes won't save.
 *
 * Mirrors EncryptionWarningBanner: reads `ConnectedWorkspace::isEncrypted()`,
 * renders nothing for the local-only / mock workspace (which doesn't expose it)
 * or when the room is encrypted.
 */
export function ReadOnlyBanner({ workspace, syncCount }: ReadOnlyBannerProps) {
  const [unencrypted, setUnencrypted] = useState(false)
  const role = useRole(workspace, syncCount)

  useEffect(() => {
    if (workspace && typeof workspace.isEncrypted === 'function') {
      try {
        setUnencrypted(!workspace.isEncrypted())
      } catch {
        setUnencrypted(false)
      }
    } else {
      setUnencrypted(false)
    }
  }, [workspace, syncCount])

  const viewer = role === 'viewer'
  if (!unencrypted && !viewer) return null

  return (
    <div className="encryption-warning" role="alert">
      <span className="encryption-warning__icon" aria-hidden="true">🔒</span>
      <span className="encryption-warning__text">
        {unencrypted ? (
          <>
            This workspace is read-only because it isn&apos;t end-to-end encrypted (a legacy room).
            You can view its contents, but changes can&apos;t be saved.
          </>
        ) : (
          <>
            You have <strong>view-only</strong> access to this workspace. You can read everything
            here, but changes can&apos;t be saved. Ask an admin for editor access.
          </>
        )}
      </span>
    </div>
  )
}
