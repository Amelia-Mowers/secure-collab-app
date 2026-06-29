import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import './RecoveryKeyModal.css'

/**
 * Account view (issue d00dda45): get the account's recovery key for use on
 * another device or with the CLI.
 *
 * - Passkey-custody accounts REVEAL: re-derive the PRF secret behind a fresh
 *   passkey gesture (the tap IS the re-auth) — nothing is held in memory.
 * - Recovery-key (manual) accounts REGENERATE: rotate Secure Backup to a fresh
 *   key (the app can't re-display the saved one). Destructive — the old key
 *   stops working — so it's behind a confirmation.
 */
export function RecoveryKeyModal({ onClose }: { onClose: () => void }) {
  const { passkeyEnrolled, revealRecoveryKey, regenerateRecoveryKey } = useAuth()
  const [key, setKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Escape closes (matches the account switcher / verify dialogs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<string>) => {
    setError(null)
    setBusy(true)
    try {
      setKey(await fn())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
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

        {key ? (
          // Shared "here is your key" view — for a revealed or a freshly generated key.
          <>
            <p className="rkey__body">
              {passkeyEnrolled
                ? 'Your unlock key. Treat it like a password — anyone with it can read your encrypted data. Use it to sign in on another device, or set it as the CLI’s '
                : 'Your new recovery key. Save it somewhere safe — it’s the only way back into your account, and your old key no longer works. You can also set it as the CLI’s '}
              <code>TIDEWORK_RECOVERY_KEY</code>.
            </p>
            <KeyBox value={key} />
            <div className="rkey__actions">
              <button type="button" className="rkey__primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : passkeyEnrolled ? (
          // Passkey account: reveal behind a fresh passkey gesture.
          <>
            <p className="rkey__body">
              Reveal your account’s unlock key to sign in on another device or with the CLI.
              You’ll confirm with your passkey, and the key is shown only here — treat it like a
              password.
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
              <button
                type="button"
                className="rkey__primary"
                onClick={() => run(revealRecoveryKey)}
                disabled={busy}
              >
                {busy ? 'Confirm with passkey…' : 'Reveal key'}
              </button>
            </div>
          </>
        ) : confirming ? (
          // Manual account: confirm the destructive rotation.
          <>
            <p className="rkey__body">
              Generate a new recovery key? Your current key stops working immediately, and you’ll
              use the new one to sign in from now on — you may be asked to sign in again on this
              and other devices.
            </p>
            {error && (
              <p className="rkey__error" role="alert">
                {error}
              </p>
            )}
            <div className="rkey__actions">
              <button
                type="button"
                className="rkey__link"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="rkey__primary"
                onClick={() => run(regenerateRecoveryKey)}
                disabled={busy}
              >
                {busy ? 'Generating…' : 'Generate new key'}
              </button>
            </div>
          </>
        ) : (
          // Manual account: nothing to re-display; offer to regenerate.
          <>
            <p className="rkey__body">
              This account unlocks with the recovery key you saved when you signed up — TideWork
              can’t re-display it. If you’ve lost it or want to rotate it, generate a new one.
            </p>
            <div className="rkey__actions">
              <button type="button" className="rkey__link" onClick={onClose}>
                Close
              </button>
              <button type="button" className="rkey__primary" onClick={() => setConfirming(true)}>
                Generate a new recovery key
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The key value with a copy button — shared by the reveal and regenerate views. */
function KeyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the key is selectable in the box */
    }
  }
  return (
    <div className="rkey__key">
      <code className="rkey__key-text">{value}</code>
      <button type="button" className="rkey__copy" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
