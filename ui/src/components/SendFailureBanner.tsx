import { useEffect, useRef, useState } from 'react'
import { notifyWorkspaceChanged } from '../hooks/useTable'
import './EncryptionWarningBanner.css'

interface SendFailureBannerProps {
  workspace: any
  workspaceId?: string
}

const POLL_MS = 5_000

/**
 * Surfaces permanently-rejected writes (ADR 0003 phase 3). When the bridge
 * drops a batch it can never send (forbidden, unencrypted room, too large…)
 * it reverts the cells to converged state and bumps `rejectedWrites()` — this
 * banner tells the user what happened and why, and nudges the views to
 * re-read so the reverted values render. Dismissible; reappears only if MORE
 * writes are rejected after the dismissal.
 */
export function SendFailureBanner({ workspace, workspaceId }: SendFailureBannerProps) {
  const [visible, setVisible] = useState(false)
  const [reason, setReason] = useState('')
  const [count, setCount] = useState(0)
  // Rejections the user has already dismissed — only NEW ones re-open.
  const ackedRef = useRef(0)

  useEffect(() => {
    if (!workspace || typeof workspace.rejectedWrites !== 'function') return
    let cancelled = false
    const check = () => {
      if (cancelled) return
      try {
        const info = JSON.parse(workspace.rejectedWrites())
        if (info.count > ackedRef.current) {
          setCount(info.count - ackedRef.current)
          setReason(String(info.lastReason ?? ''))
          setVisible(v => {
            // First sighting of new rejections: refresh views so the
            // reverted (converged) values render.
            if (!v && workspaceId) notifyWorkspaceChanged(workspaceId)
            return true
          })
        }
      } catch {
        /* best-effort */
      }
    }
    check()
    const interval = setInterval(check, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspace, workspaceId])

  if (!visible) return null

  const dismiss = () => {
    ackedRef.current += count
    setVisible(false)
  }

  return (
    <div className="encryption-warning" role="alert">
      <span className="encryption-warning__icon" aria-hidden="true">⚠️</span>
      <span className="encryption-warning__text">
        {count === 1 ? 'A change' : `${count} changes`} couldn&apos;t be saved and{' '}
        {count === 1 ? 'was' : 'were'} reverted
        {reason ? <> — {reason}</> : null}. Earlier versions are in the table history.
      </span>
      <button className="encryption-warning__dismiss" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}
