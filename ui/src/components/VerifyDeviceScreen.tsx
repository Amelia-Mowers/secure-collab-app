import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'
import type { VerificationState, ResettableWorkspace, ResetPlan } from '../hooks/useAuth'
import { PRF_PROVIDER_HINT, isPrfCapabilityError } from '../auth/passkeyPrf'
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
    addPasskeySpeedup,
    confirmKeySaved,
    revealLegacyKey,
    markKeySaved,
    unlockWithPasskey,
    unlockSessionWithPasskey,
    submitUnlockKey,
    signOut,
    verification,
    acceptIncomingVerification,
    confirmVerification,
    cancelVerification,
    listResettableWorkspaces,
    resetAccount,
  } = useAuth()

  // Hoisted here, not inside a gate: the reset takes over the whole screen and
  // is reachable from more than one dead end.
  const [resetting, setResetting] = useState(false)

  if (resetting) {
    return (
      <ResetAccount
        onList={listResettableWorkspaces}
        onReset={resetAccount}
        onCancel={() => setResetting(false)}
        onDone={signOut}
      />
    )
  }

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

  if (recoveryPrompt?.kind === 'speedup') {
    return (
      <OfferPasskeySpeedup
        recoveryKey={recoveryPrompt.recoveryKey}
        onEnrol={addPasskeySpeedup}
        onSkip={dismissRecoveryPrompt}
      />
    )
  }

  if (recoveryPrompt?.kind === 'save-legacy-key') {
    return (
      <SaveLegacyKey
        onReveal={revealLegacyKey}
        onDone={() => {
          markKeySaved()
          dismissRecoveryPrompt()
        }}
      />
    )
  }

  if (recoveryPrompt?.kind === 'save') {
    return (
      <SaveRecoveryKey
        recoveryKey={recoveryPrompt.recoveryKey}
        onDone={() => void confirmKeySaved(recoveryPrompt.recoveryKey)}
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
        onResetAccount={() => setResetting(true)}
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
        onResetAccount={() => setResetting(true)}
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

// ── After the key is saved: offer a passkey as a faster unlock ──────────────

function OfferPasskeySpeedup({
  recoveryKey,
  onEnrol,
  onSkip,
}: {
  recoveryKey: string
  onEnrol: (recoveryKey: string) => Promise<void>
  onSkip: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [unsupported, setUnsupported] = useState<string | null>(null)

  const handleEnrol = async () => {
    setUnsupported(null)
    setBusy(true)
    try {
      await onEnrol(recoveryKey)
      setDone(true)
    } catch (err: any) {
      // A provider that can't do PRF is NOT an error state here. The passkey
      // wraps the recovery key rather than replacing it, so a failure leaves the
      // account exactly as it was — say so plainly instead of alarming anyone.
      setUnsupported(err?.message ?? 'That passkey could not be used.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          Passkey ready
        </h2>
        <p className="verify__body">
          You can now unlock on this device with your passkey. Your recovery key
          still works too — keep it somewhere safe for a new device.
        </p>
        <div className="verify__actions">
          <button type="button" className="verify__primary" onClick={onSkip}>
            Done
          </button>
        </div>
      </Overlay>
    )
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Unlock faster with a passkey?
      </h2>
      <p className="verify__body">
        Optional. A passkey lets you unlock with your fingerprint or face instead
        of typing your recovery key. It does not replace the key — the key keeps
        working either way.
      </p>
      <p className="verify__hint">{PRF_PROVIDER_HINT}</p>
      {unsupported && (
        <p className="verify__note" role="status">
          {unsupported}
          <br />
          <strong>Nothing has changed</strong> — your recovery key still works,
          and you can add a passkey later from your account settings.
        </p>
      )}
      <div className="verify__actions verify__actions--stacked">
        <button type="button" className="verify__primary" disabled={busy} onClick={handleEnrol}>
          {busy ? (
            <>
              <Spinner />
              Setting up…
            </>
          ) : (
            'Set up a passkey'
          )}
        </button>
        <button type="button" className="verify__link" disabled={busy} onClick={onSkip}>
          {unsupported ? 'Continue without a passkey' : 'Not now'}
        </button>
      </div>
    </Overlay>
  )
}

// ── Legacy passkey account: reveal and save the key they've never seen ──────

function SaveLegacyKey({
  onReveal,
  onDone,
}: {
  onReveal: () => Promise<string>
  onDone: () => void
}) {
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleReveal = async () => {
    setError(null)
    setBusy(true)
    try {
      setKey(await onReveal())
    } catch (err: any) {
      setError(err?.message ?? 'Could not read your key from the passkey.')
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async () => {
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
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Save your recovery key
      </h2>
      <p className="verify__body">
        This account was set up with a passkey, so it has a recovery key you have
        never seen. Right now your passkey is the only way in — if you lose it,
        the account is gone. Reveal the key and save it.
      </p>
      {key ? (
        <>
          <div className="verify__key">
            <code className="verify__key-text">{key}</code>
            <button type="button" className="verify__copy" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="verify__warning" role="note">
            <strong>If you lose both this key and your passkey, your data is
            gone permanently.</strong> No one — including us — can recover it.
          </p>
          <label className="verify__ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
            />
            <span>I have saved my recovery key somewhere safe</span>
          </label>
          <div className="verify__actions">
            <button
              type="button"
              className="verify__primary"
              disabled={!acknowledged}
              onClick={onDone}
            >
              Continue
            </button>
          </div>
        </>
      ) : (
        <>
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
              onClick={handleReveal}
            >
              {busy ? (
                <>
                  <Spinner />
                  Checking your passkey…
                </>
              ) : (
                'Reveal my recovery key'
              )}
            </button>
            {/* No skip. The whole point is that these accounts are one lost
                passkey away from being unrecoverable, and the user cannot know
                that without being shown. */}
          </div>
        </>
      )}
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
  onDone,
}: {
  recoveryKey: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  // EVERY account now leaves setup having seen its key (issue 63dc1339). There
  // is no longer a passkey-first path where this is optional break-glass, so it
  // is always shown and always requires an explicit acknowledgement — this is
  // the only moment the key exists anywhere we can show it.
  const [acknowledged, setAcknowledged] = useState(false)

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
        Save your recovery key
      </h2>
      <p className="verify__body">
        This key is the only thing that can restore your encrypted data on a new
        device. Save it in your password manager, or in secure notes.
      </p>
      <div className="verify__key">
        <code className="verify__key-text">{recoveryKey}</code>
        <button type="button" className="verify__copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="verify__warning" role="note">
        <strong>If you lose this key, your data is gone permanently.</strong> No
        one — including us — can recover it for you, because we never have it.
      </p>
      {/* An explicit acknowledgement, not just a button. The cost of clicking
          past this screen is unbounded and unrecoverable, so it should take a
          deliberate act rather than a reflex. */}
      <label className="verify__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={e => setAcknowledged(e.target.checked)}
        />
        <span>I have saved my recovery key somewhere safe</span>
      </label>
      <div className="verify__actions">
        <button
          type="button"
          className="verify__primary"
          disabled={!acknowledged}
          onClick={onDone}
        >
          Continue
        </button>
      </div>
    </Overlay>
  )
}

// ── New device: unlock with passkey or master key. No SAS, no bypass. ────────

function VerifyThisDevice({
  onMasterKey,
  canUnlockWithPasskey,
  onPasskey,
  onSignOut,
  onResetAccount,
}: {
  onMasterKey: (key: string) => Promise<void>
  canUnlockWithPasskey: boolean
  onPasskey: () => Promise<void>
  onSignOut: () => void
  onResetAccount?: () => void
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
      const message = err?.message ?? 'Something went wrong. Please try again.'
      setError(message)
      // Same routing as the at-rest gate: a passkey that cannot do PRF has no
      // retry that will work, so move the user to the key rather than leaving
      // them on a dead button.
      if (isPrfCapabilityError(message)) setForceKey(true)
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
      <EscapeHatch onSignOut={onSignOut} onResetAccount={onResetAccount}>
        <ManageSubscriptionButton className="verify__link" errorClassName="verify__error" />
      </EscapeHatch>
    </Overlay>
  )
}

// ── Nuclear option: reset the account when verification is impossible ────────

/**
 * The way out of a dead end (issue 63dc1339 stage 4).
 *
 * A user who can't verify and has lost their key isn't stuck with a broken
 * account and no path forward — but the path costs them their history, so every
 * step is explicit. Three phases: warn, decide each workspace's fate, then show
 * the fresh key.
 *
 * Per workspace the rule is the one the bridge already enforces: hand it to a
 * successor if anyone else is in it, or delete it. There is no third option —
 * leaving as the sole admin would strand a workspace nobody can manage.
 */
function ResetAccount({
  onList,
  onReset,
  onCancel,
  onDone,
}: {
  onList: () => Promise<ResettableWorkspace[]>
  onReset: (plan: ResetPlan[]) => Promise<string>
  onCancel: () => void
  onDone: () => void
}) {
  const [phase, setPhase] = useState<'warn' | 'plan' | 'done'>('warn')
  const [workspaces, setWorkspaces] = useState<ResettableWorkspace[] | null>(null)
  const [choices, setChoices] = useState<Record<string, ResetPlan>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const loadPlan = async () => {
    setError(null)
    setBusy(true)
    try {
      const list = await onList()
      setWorkspaces(list)
      // Default each workspace to the SAFER option where there is one: handing
      // it to somebody keeps their data, deleting destroys it. With nobody else
      // present, delete is the only thing that can happen.
      const defaults: Record<string, ResetPlan> = {}
      for (const w of list) {
        defaults[w.id] =
          w.others.length > 0
            ? { id: w.id, action: 'handoff', successor: w.others[0].id }
            : { id: w.id, action: 'delete' }
      }
      setChoices(defaults)
      setPhase('plan')
    } catch (err: any) {
      setError(err?.message ?? 'Could not read your workspaces.')
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setError(null)
    setBusy(true)
    try {
      setNewKey(await onReset(Object.values(choices)))
      setPhase('done')
    } catch (err: any) {
      // Workspaces are processed before the key is rotated, so a failure here
      // leaves the old key working. Say so — the user has not lost anything yet.
      setError(
        `${err?.message ?? 'The reset could not be completed.'} Your existing key still works.`,
      )
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'warn') {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          Reset this account?
        </h2>
        <p className="verify__body">
          Only do this if you can&apos;t unlock and have lost your recovery key.
          You&apos;ll get a working account with a new key, and can be re-invited to
          workspaces.
        </p>
        <p className="verify__warning" role="note">
          <strong>Everything already encrypted becomes permanently unreadable.</strong>{' '}
          Existing workspace data cannot be recovered afterwards, by you or by us.
        </p>
        {error && (
          <p className="verify__error" role="alert">
            {error}
          </p>
        )}
        <div className="verify__actions verify__actions--stacked">
          <button type="button" className="verify__primary" disabled={busy} onClick={loadPlan}>
            {busy ? (
              <>
                <Spinner />
                Checking your workspaces…
              </>
            ) : (
              'Continue'
            )}
          </button>
          <button type="button" className="verify__link" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </Overlay>
    )
  }

  if (phase === 'plan') {
    return (
      <Overlay labelledBy="verify-title">
        <h2 id="verify-title" className="verify__title">
          What happens to your workspaces?
        </h2>
        {workspaces && workspaces.length === 0 ? (
          <p className="verify__body">
            You&apos;re not in any workspaces, so there&apos;s nothing to hand over.
          </p>
        ) : (
          <>
            <p className="verify__body">
              You&apos;ll be removed from each of these. Choose one at a time.
            </p>
            <ul className="verify__list">
              {workspaces?.map(w => (
                <li key={w.id} className="verify__list-item">
                  <strong>{w.name}</strong>
                  {w.others.length === 0 ? (
                    <p className="verify__hint">
                      Nobody else is in it, so it will be deleted.
                    </p>
                  ) : (
                    <div className="verify__choice">
                      <label>
                        <input
                          type="radio"
                          name={`ws-${w.id}`}
                          checked={choices[w.id]?.action === 'handoff'}
                          onChange={() =>
                            setChoices(c => ({
                              ...c,
                              [w.id]: {
                                id: w.id,
                                action: 'handoff',
                                successor: w.others[0].id,
                              },
                            }))
                          }
                        />
                        <span>Make an admin and leave</span>
                      </label>
                      {choices[w.id]?.action === 'handoff' && (
                        <select
                          aria-label={`Successor for ${w.name}`}
                          value={(choices[w.id] as { successor: string }).successor}
                          onChange={e =>
                            setChoices(c => ({
                              ...c,
                              [w.id]: { id: w.id, action: 'handoff', successor: e.target.value },
                            }))
                          }
                        >
                          {w.others.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      )}
                      <label>
                        <input
                          type="radio"
                          name={`ws-${w.id}`}
                          checked={choices[w.id]?.action === 'delete'}
                          disabled={!w.amAdmin}
                          onChange={() =>
                            setChoices(c => ({ ...c, [w.id]: { id: w.id, action: 'delete' } }))
                          }
                        />
                        <span>
                          Delete it for everyone
                          {!w.amAdmin && ' (admins only)'}
                        </span>
                      </label>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <p className="verify__error" role="alert">
            {error}
          </p>
        )}
        <div className="verify__actions verify__actions--stacked">
          <button type="button" className="verify__primary" disabled={busy} onClick={run}>
            {busy ? (
              <>
                <Spinner />
                Resetting…
              </>
            ) : (
              'Reset my account'
            )}
          </button>
          <button type="button" className="verify__link" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </Overlay>
    )
  }

  return (
    <Overlay labelledBy="verify-title">
      <h2 id="verify-title" className="verify__title">
        Save your new recovery key
      </h2>
      <p className="verify__body">
        Your account has a fresh key. Save it in your password manager or secure
        notes — you&apos;ll need it to sign in again.
      </p>
      <div className="verify__key">
        <code className="verify__key-text">{newKey}</code>
      </div>
      <p className="verify__warning" role="note">
        <strong>If you lose this key, your data is gone permanently.</strong>
      </p>
      <label className="verify__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={e => setAcknowledged(e.target.checked)}
        />
        <span>I have saved my new recovery key somewhere safe</span>
      </label>
      <div className="verify__actions">
        <button
          type="button"
          className="verify__primary"
          disabled={!acknowledged}
          onClick={onDone}
        >
          Sign in again
        </button>
      </div>
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
  onResetAccount,
}: {
  custody?: 'passkey' | 'manual'
  passkeyAvailable: boolean
  onPasskey: () => Promise<void>
  onKey: (key: string) => Promise<void>
  onSignOut: () => void
  onResetAccount?: () => void
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
      const message = err?.message ?? 'Could not unlock. Check your passkey or recovery key.'
      setError(message)
      setBusy(false)
      // A passkey that CANNOT do PRF will never succeed, however many times it is
      // tapped — so route to the recovery key rather than leaving the user on a
      // button that cannot work. Cancellations and network errors stay put,
      // because for those retrying is the right move.
      if (isPrfCapabilityError(message)) setForceKey(true)
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
          {isPrfCapabilityError(error) ? (
            <p className="verify__note" role="status">
              That passkey can&apos;t unlock TideWork — its provider doesn&apos;t
              support the security feature we need. Enter your recovery key
              instead; it always works.
            </p>
          ) : (
            <p className="verify__body">Enter your recovery key to unlock this device.</p>
          )}
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
      <EscapeHatch onSignOut={onSignOut} onResetAccount={onResetAccount} />
    </Overlay>
  )
}

// ── Escape hatch: never let a gate trap the user. Signing out clears the
//    prompt and returns to sign-in, even when unlock/verify can't succeed
//    (lost or rotated key, PRF-less passkey). Always enabled — including mid
//    busy state — so a hung passkey prompt is still escapable. (issue 7495dd9a)
function EscapeHatch({
  onSignOut,
  onResetAccount,
  children,
}: {
  onSignOut: () => void
  /** Offered only where the gate can genuinely be a dead end: a user with no
   *  key and no working passkey needs a way forward, not just a way out. */
  onResetAccount?: () => void
  children?: ReactNode
}) {
  return (
    <div className="verify__escape">
      <button type="button" className="verify__link" onClick={() => onSignOut()}>
        Sign out
      </button>
      {onResetAccount && (
        <button type="button" className="verify__link" onClick={onResetAccount}>
          Reset my account
        </button>
      )}
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
