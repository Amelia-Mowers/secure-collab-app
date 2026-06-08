import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import './RecoveryGate.css'

/**
 * Modal that keeps a freshly signed-in device out of the useless
 * "signed in but can't read history" state (review §4.2 / ADR 0001 Phase B).
 *
 * Driven by `useAuth().recoveryPrompt`:
 *  - `save`  — the first device just bootstrapped Secure Backup; show the
 *    generated recovery key and require the user to confirm they saved it.
 *  - `enter` — a returning device must supply its saved recovery key to
 *    restore history, with an explicit (warned) "continue without history"
 *    escape so a lost key can't lock the user out of the app entirely.
 */
export function RecoveryGate() {
  const { recoveryPrompt, submitRecoveryKey, dismissRecoveryPrompt } = useAuth()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  if (!recoveryPrompt) return null

  const handleCopy = async () => {
    if (recoveryPrompt.kind !== 'save') return
    try {
      await navigator.clipboard.writeText(recoveryPrompt.recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable; the key is still selectable in the box.
    }
  }

  const handleRestore = async () => {
    setError(null)
    setBusy(true)
    try {
      await submitRecoveryKey(key.trim())
    } catch (err: any) {
      setError(err?.message ?? 'Could not restore from backup. Check the key and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="recovery-gate__overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-gate-title"
    >
      <div className="recovery-gate">
        {recoveryPrompt.kind === 'save' ? (
          <>
            <h2 id="recovery-gate-title" className="recovery-gate__title">
              Save your recovery key
            </h2>
            <p className="recovery-gate__body">
              This key is the only way to read your workspace history on another device.
              Store it somewhere safe — it can&apos;t be recovered for you.
            </p>
            <div className="recovery-gate__key">
              <code className="recovery-gate__key-text">{recoveryPrompt.recoveryKey}</code>
              <button type="button" className="recovery-gate__copy" onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="recovery-gate__actions">
              <button
                type="button"
                className="recovery-gate__primary"
                onClick={dismissRecoveryPrompt}
              >
                I&apos;ve saved it
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="recovery-gate-title" className="recovery-gate__title">
              Restore your history
            </h2>
            <p className="recovery-gate__body">
              This device doesn&apos;t have the keys for your encrypted history yet. Enter your
              recovery key to restore it.
            </p>
            <input
              type="text"
              className="recovery-gate__input"
              placeholder="Recovery key"
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={busy}
              autoFocus
            />
            {error && (
              <p className="recovery-gate__error" role="alert">
                {error}
              </p>
            )}
            <div className="recovery-gate__actions">
              <button
                type="button"
                className="recovery-gate__secondary"
                onClick={dismissRecoveryPrompt}
                disabled={busy}
              >
                Continue without history
              </button>
              <button
                type="button"
                className="recovery-gate__primary"
                onClick={handleRestore}
                disabled={busy || key.trim().length === 0}
              >
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
