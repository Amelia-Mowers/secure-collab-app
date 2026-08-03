import { useEffect, useRef, useState } from 'react'
import './EncryptionWarningBanner.css'

interface EncryptionWarningBannerProps {
  workspace: any
  /** Re-check the count when sync delivers more (possibly undecryptable) events. */
  syncCount?: number
}

/** First retry delay; doubles up to {@link MAX_RETRY_MS} while anything is stuck. */
const MIN_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000

/**
 * Workspace-level warning shown when the connected workspace has room events it
 * could not decrypt (no key). Surfacing this is important here because the
 * workspace is materialized from the encrypted timeline — undecryptable events
 * are silently skipped, so the workspace would otherwise come up missing data
 * with no indication. See `docs/adr/0001-e2e-key-management.md` / review §4.2.
 *
 * Reads `ConnectedWorkspace::undecryptableCount()`; renders nothing for the
 * local-only / mock workspace (which doesn't expose it) or when the count is 0.
 *
 * While the warning is up it retries `retryUndecryptable()` on a doubling
 * backoff. A missing room key is usually a timing problem — the sender's
 * to-device key or a backup restore lands seconds later — so most of these
 * clear themselves, and a warning that could only ever go up would train people
 * to ignore the one that matters.
 */
export function EncryptionWarningBanner({ workspace, syncCount }: EncryptionWarningBannerProps) {
  const [count, setCount] = useState(0)
  // Bumped after every retry to re-arm the timer. Without it, a retry that
  // changed nothing would leave `count` untouched, the effect's deps unchanged,
  // and the backoff would stop after exactly one attempt.
  const [attempt, setAttempt] = useState(0)
  // Kept in a ref, not state: it must survive re-renders (so the backoff keeps
  // growing) without causing one of its own.
  const delayRef = useRef(MIN_RETRY_MS)

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

  useEffect(() => {
    if (count <= 0 || typeof workspace?.retryUndecryptable !== 'function') return
    let cancelled = false
    const timer = setTimeout(() => {
      Promise.resolve(workspace.retryUndecryptable())
        .then((remaining: number) => {
          if (cancelled) return
          // Only back off when the retry changed nothing. Progress means keys
          // are arriving, so the next batch is worth asking for promptly.
          const left = Number(remaining) || 0
          delayRef.current =
            left < count ? MIN_RETRY_MS : Math.min(delayRef.current * 2, MAX_RETRY_MS)
          setCount(left)
          setAttempt((n) => n + 1)
        })
        .catch(() => {
          if (cancelled) return
          delayRef.current = Math.min(delayRef.current * 2, MAX_RETRY_MS)
          setAttempt((n) => n + 1)
        })
    }, delayRef.current)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspace, count, attempt])

  if (count <= 0) return null

  return (
    <div className="encryption-warning" role="alert">
      <span className="encryption-warning__icon" aria-hidden="true">⚠</span>
      <span className="encryption-warning__text">
        {count} {count === 1 ? 'item' : 'items'} in this workspace couldn&apos;t be decrypted on
        this device — some data may be missing. Still waiting for the keys; this usually clears on
        its own. If it doesn&apos;t, restore your encryption keys from backup or verify this device.
      </span>
    </div>
  )
}
