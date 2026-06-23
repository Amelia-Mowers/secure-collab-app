import { useEffect, useState } from 'react'
import './EncryptionWarningBanner.css'

interface ReadOnlyBannerProps {
  workspace: any
  /** Re-check when sync delivers events (encryption state is known after the
   *  room loads). */
  syncCount?: number
}

/**
 * Workspace-level banner shown when the connected room is NOT end-to-end
 * encrypted — a "legacy" room from before encryption was required. Such rooms
 * are read-only: the bridge send path fails closed, so writes never persist;
 * this banner explains why changes can't be saved.
 *
 * Mirrors EncryptionWarningBanner: reads `ConnectedWorkspace::isEncrypted()`,
 * renders nothing for the local-only / mock workspace (which doesn't expose it)
 * or when the room is encrypted.
 */
export function ReadOnlyBanner({ workspace, syncCount }: ReadOnlyBannerProps) {
  const [readOnly, setReadOnly] = useState(false)

  useEffect(() => {
    if (workspace && typeof workspace.isEncrypted === 'function') {
      try {
        setReadOnly(!workspace.isEncrypted())
      } catch {
        setReadOnly(false)
      }
    } else {
      setReadOnly(false)
    }
  }, [workspace, syncCount])

  if (!readOnly) return null

  return (
    <div className="encryption-warning" role="alert">
      <span className="encryption-warning__icon" aria-hidden="true">🔒</span>
      <span className="encryption-warning__text">
        This workspace is read-only because it isn&apos;t end-to-end encrypted (a legacy room). You
        can view its contents, but changes can&apos;t be saved.
      </span>
    </div>
  )
}
