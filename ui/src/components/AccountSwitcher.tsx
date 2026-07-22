import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import type { AccountSession } from '@/hooks/useAuth'
import { RecoveryKeyModal } from './RecoveryKeyModal'
import { ManageSubscriptionButton } from './ManageSubscriptionButton'
import './AccountSwitcher.css'

interface AccountSwitcherProps {
  /** Direction the dropdown opens. Default: 'up' (for sidebar footer). */
  direction?: 'up' | 'down'
}

/**
 * Dropdown that shows all logged-in accounts and lets users:
 * - Switch between accounts (per-window)
 * - Sign out the current account
 * - Remove other accounts
 * - Add a new account (navigates to /signin?addAccount=1)
 */
export function AccountSwitcher({ direction = 'up' }: AccountSwitcherProps) {
  const {
    accounts,
    activeAccountId,
    username,
    matrixSession,
    switchAccount,
    removeAccount,
    signOut,
  } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [showRecoveryKey, setShowRecoveryKey] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleSwitch = async (account: AccountSession) => {
    if (account.userId === activeAccountId) {
      setOpen(false)
      return
    }
    setSwitching(true)
    try {
      await switchAccount(account.userId)
      setOpen(false)
      navigate('/workspaces')
    } catch (err) {
      console.error('Failed to switch account:', err)
    } finally {
      setSwitching(false)
    }
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleRemove = (e: React.MouseEvent, userId: string) => {
    e.stopPropagation()
    if (userId === activeAccountId) {
      signOut()
      navigate('/signin')
    } else {
      removeAccount(userId)
    }
  }

  const handleCopyId = (e: React.MouseEvent, userId: string) => {
    e.stopPropagation()
    navigator.clipboard.writeText(userId).then(() => {
      setCopiedId(userId)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }

  const handleAddAccount = () => {
    setOpen(false)
    navigate('/signin?addAccount=1')
  }

  // Edit the account's global Matrix display name (issue 1c8b3855). Only
  // offered where a Matrix client exists — the at-rest unlock gate has none,
  // but this menu only renders signed-in, so checking matrixSession suffices.
  const [nameError, setNameError] = useState<string | null>(null)
  const handleEditDisplayName = async () => {
    if (!matrixSession) return
    setNameError(null)
    let current = ''
    try {
      current = await matrixSession.getDisplayName()
    } catch {
      /* prefill is best-effort */
    }
    const next = window.prompt('Display name', current || username || '')
    if (next === null) return // cancelled
    try {
      await matrixSession.setDisplayName(next)
      setOpen(false)
    } catch (err: any) {
      setNameError(typeof err === 'string' ? err : err?.message ?? 'Could not update display name')
    }
  }

  if (accounts.length === 0) return null

  return (
    <div className="account-switcher" ref={containerRef}>
      <button
        className="account-switcher__trigger"
        onClick={() => setOpen(o => !o)}
        title="Switch account"
        disabled={switching}
      >
        <div className="account-switcher__avatar">
          {username?.[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="account-switcher__name">{switching ? 'Switching...' : username}</span>
        {accounts.length > 1 && (
          <span className="account-switcher__badge">{accounts.length}</span>
        )}
        <svg className="account-switcher__chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 4l2 2 2-2" />
        </svg>
      </button>

      {open && (
        <div className={`account-switcher__dropdown account-switcher__dropdown--${direction}`}>
          <div className="account-switcher__header">Accounts</div>
          {accounts.map(account => (
            <div
              key={account.userId}
              className={`account-switcher__item ${account.userId === activeAccountId ? 'account-switcher__item--active' : ''}`}
              onClick={() => handleSwitch(account)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && handleSwitch(account)}
            >
              <div className="account-switcher__item-avatar">
                {account.username[0]?.toUpperCase() ?? '?'}
              </div>
              <div className="account-switcher__item-info">
                <span className="account-switcher__item-name">{account.username}</span>
                <span className="account-switcher__item-server">
                  {account.userId}
                </span>
              </div>
              {account.userId === activeAccountId && (
                <svg className="account-switcher__check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M2.5 6.5L5 9l4.5-6" />
                </svg>
              )}
              <button
                className="account-switcher__item-copy"
                title={copiedId === account.userId ? 'Copied!' : 'Copy user ID'}
                onClick={e => handleCopyId(e, account.userId)}
              >
                {copiedId === account.userId ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 5.5L4 7.5 8 3" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
                    <path d="M7 3V2a1 1 0 00-1-1H2a1 1 0 00-1 1v4a1 1 0 001 1h1" />
                  </svg>
                )}
              </button>
              <button
                className="account-switcher__item-remove"
                title={account.userId === activeAccountId ? 'Sign out' : 'Remove account'}
                onClick={e => handleRemove(e, account.userId)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                </svg>
              </button>
            </div>
          ))}
          <div className="account-switcher__divider" />
          {matrixSession && (
            <button className="account-switcher__add" onClick={handleEditDisplayName}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M8.5 1.5l2 2L4 10l-2.6.6L2 8z" />
              </svg>
              Edit display name
            </button>
          )}
          {nameError && <div className="account-switcher__billing-error" role="alert">{nameError}</div>}
          <button
            className="account-switcher__add"
            onClick={() => {
              setOpen(false)
              setShowRecoveryKey(true)
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="4.5" cy="4.5" r="2.5" />
              <path d="M6.3 6.3 L10.5 10.5 M9 9 L10 8" />
            </svg>
            Recovery key
          </button>
          <ManageSubscriptionButton
            className="account-switcher__add"
            errorClassName="account-switcher__billing-error"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="3" width="9" height="6.5" rx="1" />
              <path d="M1.5 5.2h9" />
            </svg>
            Manage subscription
          </ManageSubscriptionButton>
          <button
            className="account-switcher__add"
            onClick={handleAddAccount}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="6" y1="2" x2="6" y2="10" />
              <line x1="2" y1="6" x2="10" y2="6" />
            </svg>
            Add account
          </button>
        </div>
      )}

      {showRecoveryKey && <RecoveryKeyModal onClose={() => setShowRecoveryKey(false)} />}
    </div>
  )
}
