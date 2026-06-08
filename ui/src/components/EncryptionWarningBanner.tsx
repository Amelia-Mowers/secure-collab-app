import { useEffect, useState } from 'react'
import './EncryptionWarningBanner.css'

interface EncryptionWarningBannerProps {
  workspace: any
  /** Re-check the count when sync delivers more (possibly undecryptable) events. */
  syncCount?: number
}

/**
 * Workspace-level warning shown when the connected workspace has room events it
 * could not decrypt (no key). Surfacing this is important here because the
 * workspace is materialized from the encrypted timeline — undecryptable events
 * are silently skipped, so the workspace would otherwise come up missing data
 * with no indication. See `docs/adr/0001-e2e-key-management.md` / review §4.2.
 *
 * Reads `ConnectedWorkspace::undecryptableCount()`; renders nothing for the
 * local-only / mock workspace (which doesn't expose it) or when the count is 0.
 */
export function EncryptionWarningBanner({ workspace, syncCount }: EncryptionWarningBannerProps) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (workspace && typeof workspace.undecryptableCount === 'function') {
      try {
        setCount(Number(workspace.undecryptableCount()) || 0)
      } catch {
        setCount(0)
      }
    } else {
      setCount(0)
    }
  }, [workspace, syncCount])

  if (count <= 0) return null

  return (
    <div className="encryption-warning" role="alert">
      <span className="encryption-warning__icon" aria-hidden="true">⚠</span>
      <span className="encryption-warning__text">
        {count} {count === 1 ? 'item' : 'items'} in this workspace couldn&apos;t be decrypted on
        this device — some data may be missing. Restore your encryption keys from backup, or verify
        this device, to see everything.
      </span>
    </div>
  )
}
