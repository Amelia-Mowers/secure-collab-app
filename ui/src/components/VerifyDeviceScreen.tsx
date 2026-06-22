import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'
import type { VerificationState } from '../hooks/useAuth'
import './VerifyDeviceScreen.css'

/**
 * The standard new-device security screen and verification prompts
 * (ADR 0001 Phase D-3). A new device that can't yet read history is taken here
 * to establish trust — by verifying with another signed-in device (SAS emoji)
 * or entering its master key. This is a normal step, not a warning, and there
 * is deliberately **no bypass**: the only ways forward are to verify, restore
 * with the master key, or sign out.
 *
 * It also renders the active-verification UI (emoji comparison) and the
 * incoming-request prompt shown on an existing device when a new one asks to
 * verify.
 */
export function VerifyDeviceScreen() {
  const {
    recoveryPrompt,
    submitRecoveryKey,
    dismissRecoveryPrompt,
    retryRecoverySetup,
    passkeyAvailable,
    passkeyEnrolled,
    setupPasskeyRecovery,
    setupKeyRecovery,
    unlockWithPasskey,
    signOut,
    verification,
    startVerification,
    acceptIncomingVerification,
    confirmVerification,
    cancelVerification,
  } = useAuth()

  // An active verification takes over the screen (emoji / waiting / incoming).
  if (verification) {
    return (
      <VerificationFlow
        verification={verification}
        onAccept={acceptIncomingVerification}
        onConfirm={confirmVerification}
        onCancel={cancelVerification}
      />
    )
  }

  if (recoveryPrompt?.kind === 'setup') {
    return (
      <ChooseRecoveryMethod onPasskey={setupPasskeyRecovery} onRecoveryKey={setupKeyRecovery} />
    )
  }

  if (recoveryPrompt?.kind === 'save') {
    return (
      <SaveRecoveryKey
        recoveryKey={recoveryPrompt.recoveryKey}
        viaPasskey={recoveryPrompt.viaPasskey}
        onDone={dismissRecoveryPrompt}
      />
    )
  }

  if (recoveryPrompt?.kind === 'verify') {
    return (
      <VerifyThisDevice
        onVerify={startVerification}
        onMasterKey={submitRecoveryKey}
        canUnlockWithPasskey={passkeyAvailable && passkeyEnrolled}
        onPasskey={unlockWithPasskey}
      />
    )
  }

  if (recoveryPrompt?.kind === 'error') {
    return (
      <RecoverySetupFailed
        message={recoveryPrompt.message}
        onRetry={retryRecoverySetup}
        onSignOut={signOut}
      />
    )
  }

  return null
}

// ── First device: choose how to protect history (passkey vs recovery key) ───

function ChooseRecoveryMethod({
  onPasskey,
  onRecoveryKey,
}: {
  onPasskey: () => Promise<void>
  onRecoveryKey: () => Promise<void>
}) {
  const [busy, setBusy] = useState<null | 'passkey' | 'key'>(null)
  const [error, setError] = useState<string | null>(null)

  const run = (which: 'passkey' | 'key', fn: () => Promise<void>) => async () => {
    setError(null)
    setBusy(which)
    try {
      await fn()
      // On success the prompt advances to `save`; leave busy until unmount.
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
      setBusy(null)
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Protect your history
      </h2>
      <p className="verify__body">
        TideWork end-to-end encrypts your workspaces. Choose how to unlock them on a new device. A
        passkey (Touch ID / Windows Hello) is easiest — nothing to write down — and you&apos;ll still
        get a recovery key to keep as a backup.
      </p>
      {error && (
        <p className="verify__error" role="alert">
          {error}
        </p>
      )}
      <div className="verify__actions verify__actions--stacked">
        <button
          type="button"
          className="verify__primary"
          disabled={busy !== null}
          onClick={run('passkey', onPasskey)}
        >
          {busy === 'passkey' ? <><Spinner />Setting up…</> : 'Set up a passkey'}
        </button>
        <button
          type="button"
          className="verify__link"
          disabled={busy !== null}
          onClick={run('key', onRecoveryKey)}
        >
          {busy === 'key' ? <><Spinner />Working…</> : 'Use a recovery key instead'}
        </button>
      </div>
    </Overlay>
  )
}

// ── First device: recovery bootstrap failed — blocking, never silent ────────

function RecoverySetupFailed({
  message,
  onRetry,
  onSignOut,
}: {
  message: string
  onRetry: () => Promise<void>
  onSignOut: () => void
}) {
  const [busy, setBusy] = useState(false)

  const handleRetry = async () => {
    setBusy(true)
    try {
      await onRetry()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Couldn&apos;t set up recovery
      </h2>
      <p className="verify__body">
        You&apos;re signed in, but your <strong>recovery key could not be created</strong>. Without
        it, your encrypted history cannot be restored on a new device — if you lose this one, that
        data is gone. Please retry; if it keeps failing, sign out and try again later.
      </p>
      <p className="verify__error" role="alert">
        {message}
      </p>
      <div className="verify__actions">
        <button type="button" className="verify__primary" onClick={handleRetry} disabled={busy}>
          {busy ? <><Spinner />Retrying…</> : 'Retry'}
        </button>
        <button type="button" className="verify__link" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </div>
    </Overlay>
  )
}

// ── First device: save the generated recovery (master) key ──────────────────

function SaveRecoveryKey({
  recoveryKey,
  viaPasskey,
  onDone,
}: {
  recoveryKey: string
  viaPasskey?: boolean
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the key is selectable in the box */
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        {viaPasskey ? 'Save your backup key' : 'Save your master key'}
      </h2>
      <p className="verify__body">
        {viaPasskey
          ? 'Your passkey unlocks your history on a new device. Keep this recovery key somewhere safe as a backup, in case you ever lose access to your passkey.'
          : "This key restores your encrypted history on a new device if you can't verify with an existing one. Store it somewhere safe — it can't be recovered for you."}
      </p>
      <div className="verify__key">
        <code className="verify__key-text">{recoveryKey}</code>
        <button type="button" className="verify__copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="verify__actions">
        <button type="button" className="verify__primary" onClick={onDone}>
          I&apos;ve saved it
        </button>
      </div>
    </Overlay>
  )
}

// ── New device: verify (SAS) or restore with the master key. No bypass. ──────

function VerifyThisDevice({
  onVerify,
  onMasterKey,
  canUnlockWithPasskey,
  onPasskey,
}: {
  onVerify: () => Promise<void>
  onMasterKey: (key: string) => Promise<void>
  canUnlockWithPasskey: boolean
  onPasskey: () => Promise<void>
}) {
  const [mode, setMode] = useState<'choose' | 'key'>('choose')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Verify this device
      </h2>
      {mode === 'choose' ? (
        <>
          <p className="verify__body">
            To keep your workspace history end-to-end encrypted, confirm this is really you.
            {canUnlockWithPasskey
              ? ' Unlock with your passkey, verify with another signed-in device, or use your master key.'
              : ' Verify with another device you’re signed in on, or use your master key.'}
          </p>
          {error && (
            <p className="verify__error" role="alert">
              {error}
            </p>
          )}
          <div className="verify__actions verify__actions--stacked">
            {canUnlockWithPasskey && (
              <button
                type="button"
                className="verify__primary"
                disabled={busy}
                onClick={() => run(onPasskey)}
              >
                {busy ? <><Spinner />Working…</> : 'Unlock with passkey'}
              </button>
            )}
            <button
              type="button"
              className={canUnlockWithPasskey ? 'verify__link' : 'verify__primary'}
              disabled={busy}
              onClick={() => run(onVerify)}
            >
              {!canUnlockWithPasskey && busy ? (
                <><Spinner />Working…</>
              ) : (
                'Verify with another device'
              )}
            </button>
            <button
              type="button"
              className="verify__link"
              disabled={busy}
              onClick={() => {
                setError(null)
                setMode('key')
              }}
            >
              Use your master key instead
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="verify__body">Enter the master key you saved when you first signed up.</p>
          <input
            type="text"
            className="verify__input"
            placeholder="Master key"
            value={key}
            onChange={e => setKey(e.target.value)}
            disabled={busy}
            autoFocus
          />
          {error && (
            <p className="verify__error" role="alert">
              {error}
            </p>
          )}
          <div className="verify__actions">
            <button
              type="button"
              className="verify__link"
              disabled={busy}
              onClick={() => {
                setError(null)
                setMode('choose')
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="verify__primary"
              disabled={busy || key.trim().length === 0}
              onClick={() => run(() => onMasterKey(key.trim()))}
            >
              {busy ? <><Spinner />Restoring…</> : 'Restore'}
            </button>
          </div>
          {busy && (
            <p className="verify__progress" role="status">
              Fetching and decrypting your history from secure backup — this can take a few seconds.
            </p>
          )}
        </>
      )}
    </Overlay>
  )
}

// ── Active verification: incoming prompt / emoji comparison / waiting ────────

function VerificationFlow({
  verification,
  onAccept,
  onConfirm,
  onCancel,
}: {
  verification: VerificationState
  onAccept: () => Promise<void>
  onConfirm: () => Promise<void>
  onCancel: () => Promise<void>
}) {
  const { role, status, emoji } = verification

  if (status === 'done') {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          Device verified
        </h2>
        <p className="verify__body">This device is now trusted and can read your history.</p>
      </Overlay>
    )
  }

  if (role === 'incoming' && status === 'pending') {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          Verify a new device
        </h2>
        <p className="verify__body">
          Another device signed in to your account is asking to verify. If this is you, continue and
          compare the emoji.
        </p>
        <div className="verify__actions">
          <button type="button" className="verify__link" onClick={() => void onCancel()}>
            Not now
          </button>
          <button type="button" className="verify__primary" onClick={() => void onAccept()}>
            Verify
          </button>
        </div>
      </Overlay>
    )
  }

  if (status === 'emoji' && emoji.length > 0) {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          Do these match?
        </h2>
        <p className="verify__body">
          Confirm the same emoji appear on both devices, in the same order.
        </p>
        <div className="verify__emoji" role="list">
          {emoji.map((e, i) => (
            <div key={i} className="verify__emoji-item" role="listitem">
              <span className="verify__emoji-symbol" aria-hidden="true">
                {e.symbol}
              </span>
              <span className="verify__emoji-name">{e.description}</span>
            </div>
          ))}
        </div>
        <div className="verify__actions">
          <button type="button" className="verify__link" onClick={() => void onCancel()}>
            They don&apos;t match
          </button>
          <button type="button" className="verify__primary" onClick={() => void onConfirm()}>
            They match
          </button>
        </div>
      </Overlay>
    )
  }

  // pending (self) / started — waiting for the other device.
  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Verifying…
      </h2>
      <p className="verify__body">
        Waiting for the other device. Keep both open and accept the request there.
      </p>
      <div className="verify__actions">
        <button type="button" className="verify__link" onClick={() => void onCancel()}>
          Cancel
        </button>
      </div>
    </Overlay>
  )
}

function Overlay({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <div className="verify__overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="verify">{children}</div>
    </div>
  )
}

/** Inline spinner for in-button busy states (master-key restore can take a few
 *  seconds while the SDK fetches + decrypts the backup). */
function Spinner() {
  return <span className="verify__spinner" aria-hidden="true" />
}
