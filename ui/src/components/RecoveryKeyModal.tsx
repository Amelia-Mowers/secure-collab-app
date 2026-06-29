import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import './RecoveryKeyModal.css'

/**
 * Account view (issue d00dda45): reveal the account's master unlock key so it
 * can be used to sign in on another device or with the CLI.
 *
 * For a passkey-custody account it re-derives the PRF secret behind a fresh
 * passkey gesture (the tap IS the re-auth) — nothing is held in memory between
 * reveals. A manual recovery-key account already holds its key, so there's
 * nothing to re-display; regenerating a fresh key (rotating SSSS) is a follow-up.
 */
export function RecoveryKeyModal({ onClose }: { onClose: () => void }) {
  const { passkeyEnrolled, revealRecoveryKey } = useAuth()
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Escape closes (matches the account switcher / verify dialogs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const reveal = async () => {
    setError(null)
    setBusy(true)
    try {
      setKey(await revealRecoveryKey())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not reveal your key. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!key) return
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the key is selectable in the box */
    }
  }

  return (
    <div
      className="rkey__overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rkey-title"
      onMouseDown={onClose}
    >
      <div className="rkey" onMouseDown={e => e.stopPropagation()}>
        <h2 id="rkey-title" className="rkey__title">
          Recovery key
        </h2>

        {!passkeyEnrolled ? (
          <>
            <p className="rkey__body">
              This account unlocks with the recovery key you saved when you signed up.
              TideWork never stores it, so it can&apos;t be shown again here — keep the copy you
              saved. (Generating a fresh key is coming soon.)
            </p>
            <div className="rkey__actions">
              <button type="button" className="rkey__primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : key ? (
          <>
            <p className="rkey__body">
              Your unlock key. Treat it like a password — anyone with it can read your
              encrypted data. Use it to sign in on another device, or set it as the CLI&apos;s{' '}
              <code>TIDEWORK_RECOVERY_KEY</code>.
            </p>
            <div className="rkey__key">
              <code className="rkey__key-text">{key}</code>
              <button type="button" className="rkey__copy" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="rkey__actions">
              <button type="button" className="rkey__primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="rkey__body">
              Reveal your account&apos;s unlock key to sign in on another device or with the
              CLI. You&apos;ll confirm with your passkey, and the key is shown only here — treat
              it like a password.
            </p>
            {error && (
              <p className="rkey__error" role="alert">
                {error}
              </p>
            )}
            <div className="rkey__actions">
              <button type="button" className="rkey__link" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="rkey__primary" onClick={reveal} disabled={busy}>
                {busy ? 'Confirm with passkey…' : 'Reveal key'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
