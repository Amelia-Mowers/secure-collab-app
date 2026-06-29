import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'
import type { VerificationState } from '../hooks/useAuth'
import { ManageSubscriptionButton } from './ManageSubscriptionButton'
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
    unlockSessionWithPasskey,
    submitUnlockKey,
    migrateToPasskey,
    signOut,
    verification,
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
        onMasterKey={submitRecoveryKey}
        canUnlockWithPasskey={passkeyAvailable && passkeyEnrolled}
        onPasskey={unlockWithPasskey}
        onSignOut={signOut}
      />
    )
  }

  if (recoveryPrompt?.kind === 'unlock') {
    return (
      <UnlockSession
        custody={recoveryPrompt.custody}
        passkeyAvailable={passkeyAvailable}
        onPasskey={unlockSessionWithPasskey}
        onKey={submitUnlockKey}
        onSignOut={signOut}
      />
    )
  }

  if (recoveryPrompt?.kind === 'offer-passkey') {
    return <OfferPasskeyMigration onSetup={migrateToPasskey} onSkip={dismissRecoveryPrompt} />
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

// ── Legacy account: offer to add a passkey after a master-key unlock ─────────

function OfferPasskeyMigration({
  onSetup,
  onSkip,
}: {
  onSetup: () => Promise<void>
  onSkip: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSetup = async () => {
    setError(null)
    setBusy(true)
    try {
      await onSetup()
      // On success the prompt advances to `save` (the new break-glass key).
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Add a passkey?
      </h2>
      <p className="verify__body">
        You unlocked with your master key. Add a passkey (Touch ID / Windows Hello) so your next
        device unlocks with a tap — nothing to type. You&apos;ll get a fresh backup key to keep, and
        your old master key stops working.
      </p>
      {error && (
        <p className="verify__error" role="alert">
          {error}
        </p>
      )}
      <div className="verify__actions verify__actions--stacked">
        <button type="button" className="verify__primary" disabled={busy} onClick={handleSetup}>
          {busy ? <><Spinner />Setting up…</> : 'Set up a passkey'}
        </button>
        <button type="button" className="verify__link" disabled={busy} onClick={onSkip}>
          Not now
        </button>
      </div>
    </Overlay>
  )
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
  // For a passkey account the key is break-glass insurance, not the primary
  // unlock, so keep it out of the way — revealed only on request (4c). The
  // classic key-only path always shows it: it's the sole way back into history.
  const [revealed, setRevealed] = useState(!viaPasskey)

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
        {viaPasskey ? 'Passkey ready' : 'Save your master key'}
      </h2>
      <p className="verify__body">
        {viaPasskey
          ? 'Your passkey now unlocks your history on any device — nothing to write down. A one-time backup key also exists, in case you ever lose access to your passkey.'
          : "This key restores your encrypted history on a new device if you can't verify with an existing one. Store it somewhere safe — it can't be recovered for you."}
      </p>
      {revealed ? (
        <>
          <div className="verify__key">
            <code className="verify__key-text">{recoveryKey}</code>
            <button type="button" className="verify__copy" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="verify__actions">
            <button type="button" className="verify__primary" onClick={onDone}>
              {viaPasskey ? 'Done' : <>I&apos;ve saved it</>}
            </button>
          </div>
        </>
      ) : (
        // Passkey path, collapsed: proceed by default, reveal the key on demand.
        <div className="verify__actions verify__actions--stacked">
          <button type="button" className="verify__primary" onClick={onDone}>
            Done
          </button>
          <button type="button" className="verify__link" onClick={() => setRevealed(true)}>
            Show backup key
          </button>
        </div>
      )}
    </Overlay>
  )
}

// ── New device: unlock with passkey or master key. No SAS, no bypass. ────────

function VerifyThisDevice({
  onMasterKey,
  canUnlockWithPasskey,
  onPasskey,
  onSignOut,
}: {
  onMasterKey: (key: string) => Promise<void>
  canUnlockWithPasskey: boolean
  onPasskey: () => Promise<void>
  onSignOut: () => void
}) {
  // Passkey or master key — the between-device (SAS) path is gone (issue
  // bef6b220): unlocking imports the cross-signing self-signing key, so the
  // device signs ITSELF into the trusted set; a second device isn't needed.
  // Derive the view from canUnlockWithPasskey reactively (it can flip true
  // async, like the at-rest unlock gate); `forceKey` is the explicit
  // "use my master key" opt-out.
  const [forceKey, setForceKey] = useState(false)
  const showKey = forceKey || !canUnlockWithPasskey
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
      {!showKey ? (
        <>
          <p className="verify__body">
            To keep your workspace history end-to-end encrypted, unlock this device with your
            passkey — or use your master key.
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
              disabled={busy}
              onClick={() => run(onPasskey)}
            >
              {busy ? <><Spinner />Working…</> : 'Unlock with passkey'}
            </button>
            <button
              type="button"
              className="verify__link"
              disabled={busy}
              onClick={() => {
                setError(null)
                setForceKey(true)
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
            {canUnlockWithPasskey && (
              <button
                type="button"
                className="verify__link"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setForceKey(false)
                }}
              >
                Back
              </button>
            )}
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
      <EscapeHatch onSignOut={onSignOut}>
        <ManageSubscriptionButton className="verify__link" errorClassName="verify__error" />
      </EscapeHatch>
    </Overlay>
  )
}

// ── At-rest unlock-first gate: get the master secret BEFORE restore so the
//    encrypted local store can be opened (issue c72ec5df). ────────────────────

function UnlockSession({
  custody,
  passkeyAvailable,
  onPasskey,
  onKey,
  onSignOut,
}: {
  custody?: 'passkey' | 'manual'
  passkeyAvailable: boolean
  onPasskey: () => Promise<void>
  onKey: (key: string) => Promise<void>
  onSignOut: () => void
}) {
  const canPasskey = passkeyAvailable && custody !== 'manual'
  // Derive the view from canPasskey (it flips true asynchronously once
  // passkeyAvailable settles) rather than a one-shot useState initializer — else
  // the gate sticks on the recovery-key variant. `forceKey` is the explicit
  // "use my recovery key instead" opt-out.
  const [forceKey, setForceKey] = useState(false)
  const showKey = forceKey || !canPasskey
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err: any) {
      setError(err?.message ?? 'Could not unlock. Check your passkey or recovery key.')
      setBusy(false)
    }
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Unlock TideWork
      </h2>
      {!showKey ? (
        <>
          <p className="verify__body">
            Your data is encrypted on this device. Unlock with your passkey to continue.
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
              disabled={busy}
              onClick={() => run(onPasskey)}
            >
              {busy ? <><Spinner />Unlocking…</> : 'Unlock with passkey'}
            </button>
            <button
              type="button"
              className="verify__link"
              disabled={busy}
              onClick={() => {
                setError(null)
                setForceKey(true)
              }}
            >
              Use your recovery key
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="verify__body">Enter your recovery key to unlock this device.</p>
          <input
            type="text"
            className="verify__input"
            placeholder="Recovery key"
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
            {canPasskey && (
              <button
                type="button"
                className="verify__link"
                disabled={busy}
                onClick={() => {
                  setError(null)
                  setForceKey(false)
                }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="verify__primary"
              disabled={busy || key.trim().length === 0}
              onClick={() => run(() => onKey(key.trim()))}
            >
              {busy ? <><Spinner />Unlocking…</> : 'Unlock'}
            </button>
          </div>
        </>
      )}
      <EscapeHatch onSignOut={onSignOut} />
    </Overlay>
  )
}

// ── Escape hatch: never let a gate trap the user. Signing out clears the
//    prompt and returns to sign-in, even when unlock/verify can't succeed
//    (lost or rotated key, PRF-less passkey). Always enabled — including mid
//    busy state — so a hung passkey prompt is still escapable. (issue 7495dd9a)
function EscapeHatch({ onSignOut, children }: { onSignOut: () => void; children?: ReactNode }) {
  return (
    <div className="verify__escape">
      <button type="button" className="verify__link" onClick={() => onSignOut()}>
        Sign out
      </button>
      {children}
    </div>
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
