import { useEffect, useState } from 'react'
import './UnverifiedDevicesBanner.css'

interface UnverifiedDevicesBannerProps {
  workspace: any
  /** Re-check when sync may have brought new members/devices into the room. */
  syncCount?: number
}

/**
 * Workspace-level caution shown when the room has member devices this device
 * hasn't verified. The SDK shares room keys with *every* device in an encrypted
 * room — verified or not — so a malicious/compromised homeserver could inject a
 * device and receive the keys. Surfacing this is the "warn-on-unverified" step
 * of E2E trust (ADR 0001 Phase D / review §4.2); device verification (to clear
 * the warning) follows.
 *
 * Reads `ConnectedWorkspace::unverifiedDeviceCount()` (async); renders nothing
 * for the local-only / mock workspace (which doesn't expose it) or when the
 * count is 0.
 */
export function UnverifiedDevicesBanner({ workspace, syncCount }: UnverifiedDevicesBannerProps) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (workspace && typeof workspace.unverifiedDeviceCount === 'function') {
      Promise.resolve(workspace.unverifiedDeviceCount())
        .then((n: any) => {
          if (!cancelled) setCount(Number(n) || 0)
        })
        .catch(() => {
          if (!cancelled) setCount(0)
        })
    } else {
      setCount(0)
    }
    return () => {
      cancelled = true
    }
  }, [workspace, syncCount])

  if (count <= 0) return null

  const one = count === 1

  return (
    <div className="unverified-warning" role="status">
      <span className="unverified-warning__icon" aria-hidden="true">🛡</span>
      <span className="unverified-warning__text">
        {count} unverified {one ? 'device' : 'devices'} in this workspace. Encrypted data is shared
        with {one ? 'it' : 'them'}, but {one ? 'its' : 'their'} identity hasn&apos;t been confirmed —
        verify {one ? 'it' : 'them'} to be sure your data only reaches devices you trust.
      </span>
    </div>
  )
}
