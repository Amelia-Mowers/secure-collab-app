import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { PRIVACY_URL, SUPPORT_EMAIL, SUPPORT_MAILTO, TERMS_URL } from '@/branding'
import { ManageSubscriptionButton } from './ManageSubscriptionButton'
import { RecoveryKeyModal } from './RecoveryKeyModal'
import './AccountSettingsModal.css'

/**
 * One place for everything about *this account*, rather than three entries
 * buried in the account-switcher dropdown.
 *
 * The switcher's job is switching between accounts; profile, keys, billing and
 * deletion are settings, and they were sharing a menu with it — including a
 * display-name edit that went through `window.prompt`. This separates the two.
 *
 * Deletion lives at the bottom, behind a typed confirmation, because it is the
 * one action here that cannot be undone.
 */
/** Baked in at build time (vite.config.ts). Shown in Help & legal so a support
 *  email can say which build it came from — the first thing you need and the
 *  last thing a user thinks to include. */
declare const __BUILD_ID__: string
const buildId = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

export function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const { username, userId, matrixSession, deleteAccount } = useAuth()

  const [displayName, setDisplayName] = useState('')
  const [nameLoaded, setNameLoaded] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  const [showRecoveryKey, setShowRecoveryKey] = useState(false)

  const [confirmDelete, setConfirmDelete] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Prefill from the server so the field shows what is actually set, not the
  // localpart we happen to have locally.
  useEffect(() => {
    let cancelled = false
    if (!matrixSession?.getDisplayName) {
      setNameLoaded(true)
      return
    }
    void matrixSession
      .getDisplayName()
      .then((n: string) => {
        if (!cancelled) setDisplayName(n || username || '')
      })
      .catch(() => {
        if (!cancelled) setDisplayName(username || '')
      })
      .finally(() => {
        if (!cancelled) setNameLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [matrixSession, username])

  const saveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!matrixSession || nameSaving) return
    setNameError(null)
    setNameSaved(false)
    setNameSaving(true)
    try {
      await matrixSession.setDisplayName(displayName.trim())
      setNameSaved(true)
    } catch (err: unknown) {
      setNameError(err instanceof Error ? err.message : 'Could not update display name')
    } finally {
      setNameSaving(false)
    }
  }

  // Typing the username is deliberate friction: this cancels billing and erases
  // the account, and no amount of red styling makes a single click reversible.
  const canDelete = confirmDelete.trim() === username && !deleting

  const handleDelete = async () => {
    if (!canDelete) return
    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteAccount() // navigates away on success
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the account')
      setDeleting(false)
    }
  }

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal acm asm"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
      >
        <div className="acm__header">
          <h2 className="acm__title">Account settings</h2>
          <button className="acm__close ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="asm__body">
          {/* ── Profile ─────────────────────────────────────────── */}
          <section className="asm__section">
            <h3 className="asm__heading">Profile</h3>
            <p className="asm__meta">{userId}</p>
            <form className="asm__row" onSubmit={saveDisplayName}>
              <label className="acm__label" htmlFor="asm-display-name">
                Display name{' '}
                <span className="acm__label-hint">(what collaborators see)</span>
              </label>
              <div className="asm__inline">
                <input
                  id="asm-display-name"
                  className="acm__input"
                  value={displayName}
                  onChange={e => {
                    setDisplayName(e.target.value)
                    setNameSaved(false)
                  }}
                  disabled={!nameLoaded || !matrixSession}
                  autoComplete="off"
                />
                <button type="submit" className="primary" disabled={nameSaving || !matrixSession}>
                  {nameSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
              {nameSaved && <p className="asm__ok">Saved.</p>}
              {nameError && (
                <p className="asm__error" role="alert">
                  {nameError}
                </p>
              )}
            </form>
          </section>

          {/* ── Security ────────────────────────────────────────── */}
          <section className="asm__section">
            <h3 className="asm__heading">Security</h3>
            <p className="asm__meta">
              Your recovery key is the only way back into your history on a new device.
              We cannot recover it for you.
            </p>
            <button className="asm__action" onClick={() => setShowRecoveryKey(true)}>
              Recovery key
            </button>
          </section>

          {/* ── Subscription ────────────────────────────────────── */}
          <section className="asm__section">
            <h3 className="asm__heading">Subscription</h3>
            <p className="asm__meta">
              Manage payment methods and invoices, or cancel. Cancelling keeps your data —
              the account locks, and paying again unlocks it.
            </p>
            <ManageSubscriptionButton className="asm__action" errorClassName="asm__error" />
          </section>

          {/* ── Help & legal ────────────────────────────────────── */}
          <section className="asm__section">
            <h3 className="asm__heading">Help &amp; legal</h3>
            <p className="asm__meta">
              Stuck, locked out, or something looks wrong? Email{' '}
              <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a> — include the build below, it
              tells us exactly which version you are on.
            </p>
            <p className="asm__meta">
              <a href={TERMS_URL} target="_blank" rel="noreferrer">
                Terms of Service
              </a>
              {' · '}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
            </p>
            <p className="asm__meta asm__build">Build {buildId}</p>
          </section>

          {/* ── Danger zone ─────────────────────────────────────── */}
          <section className="asm__section asm__section--danger">
            <h3 className="asm__heading">Delete account</h3>
            <p className="asm__meta">
              This cancels any subscription and permanently erases{' '}
              <strong>{username}</strong> and its data. It cannot be undone, and support
              cannot reverse it.
            </p>
            <p className="asm__meta">
              Export anything you want to keep first — encrypted content already synced to
              a collaborator&rsquo;s device stays on their device.
            </p>
            <label className="acm__label" htmlFor="asm-confirm">
              Type <code>{username}</code> to confirm
            </label>
            <div className="asm__inline">
              <input
                id="asm-confirm"
                className="acm__input"
                value={confirmDelete}
                onChange={e => setConfirmDelete(e.target.value)}
                placeholder={username ?? ''}
                autoComplete="off"
                disabled={deleting}
              />
              <button className="asm__danger" onClick={handleDelete} disabled={!canDelete}>
                {deleting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
            {deleteError && (
              <p className="asm__error" role="alert">
                {deleteError}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>

    {/* A SIBLING, not a child: RecoveryKeyModal stops `mousedown` but not
        `click`, so nested inside the overlay above, clicking anything in it
        would bubble out and dismiss these settings underneath it. */}
    {showRecoveryKey && <RecoveryKeyModal onClose={() => setShowRecoveryKey(false)} />}
    </>
  )
}
