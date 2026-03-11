import { useState, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import type { AccountSession } from '@/hooks/useAuth'
import './SignInPage.css'

export function SignInPage() {
  const { signIn, switchAccount, loading, error, accounts } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isAddAccount = searchParams.get('addAccount') === '1'
  const [homeserver, setHomeserver] = useState('http://localhost:6167')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(isAddAccount || accounts.length === 0)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!homeserver.trim() || !username.trim() || !password.trim()) return
    setLocalError(null)

    try {
      await signIn(homeserver.trim(), username.trim(), password)
      navigate('/workspaces')
    } catch (err: any) {
      setLocalError(err?.message ?? 'Sign-in failed')
    }
  }

  const handleContinueAs = async (account: AccountSession) => {
    setLocalError(null)
    try {
      await switchAccount(account.userId)
      navigate('/workspaces')
    } catch (err: any) {
      setLocalError(err?.message ?? 'Failed to restore session')
    }
  }

  const handleBack = () => {
    navigate('/workspaces')
  }

  const displayError = localError ?? error
  const canSubmit = !loading && homeserver.trim() && username.trim() && password.trim()

  // When there are existing accounts and we're not in add-account mode,
  // show account picker first instead of the full sign-in form.
  if (!showForm && accounts.length > 0) {
    return (
      <div className="signin">
        <div className="signin__card">
          <div className="signin__logo">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="10" width="16" height="10" rx="2" />
              <path d="M7 10V7a4 4 0 018 0v3" />
            </svg>
          </div>

          <h1 className="signin__title">Welcome back</h1>
          <p className="signin__subtitle">Choose an account to continue</p>

          <div className="signin__accounts">
            {accounts.map(account => (
              <button
                key={account.userId}
                className="signin__account-item"
                onClick={() => handleContinueAs(account)}
                disabled={loading}
              >
                <div className="signin__account-avatar">
                  {account.username[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="signin__account-info">
                  <span className="signin__account-name">{account.username}</span>
                  <span className="signin__account-server">
                    {account.homeserverUrl.replace(/^https?:\/\//, '')}
                  </span>
                </div>
                <svg className="signin__account-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 2l4 4-4 4" />
                </svg>
              </button>
            ))}
          </div>

          {displayError && (
            <div className="signin__error" role="alert">
              {displayError}
            </div>
          )}

          <button
            className="signin__alt-action"
            onClick={() => setShowForm(true)}
            type="button"
          >
            Sign in with a different account
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="signin">
      <div className="signin__card">
        {(isAddAccount || accounts.length > 0) && (
          <button
            className="signin__back"
            onClick={accounts.length > 0 && !isAddAccount ? () => setShowForm(false) : handleBack}
            type="button"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 1L3 6l5 5" />
            </svg>
            {isAddAccount ? 'Back to workspaces' : 'Back to accounts'}
          </button>
        )}

        <div className="signin__logo">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="10" width="16" height="10" rx="2" />
            <path d="M7 10V7a4 4 0 018 0v3" />
          </svg>
        </div>

        <h1 className="signin__title">
          {isAddAccount ? 'Add Account' : 'Secure Collab'}
        </h1>
        <p className="signin__subtitle">
          {isAddAccount
            ? 'Sign in to another Matrix account'
            : 'End-to-end encrypted collaborative workspace'}
        </p>

        <form className="signin__form" onSubmit={handleSubmit}>
          <div>
            <label className="signin__label" htmlFor="homeserver">Homeserver</label>
            <input
              id="homeserver"
              className="signin__input"
              type="url"
              placeholder="https://matrix.example.com"
              value={homeserver}
              onChange={e => setHomeserver(e.target.value)}
              autoComplete="url"
            />
          </div>
          <div>
            <label className="signin__label" htmlFor="username">Username</label>
            <input
              id="username"
              className="signin__input"
              type="text"
              placeholder="e.g. alice"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div>
            <label className="signin__label" htmlFor="password">Password</label>
            <input
              id="password"
              className="signin__input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {displayError && (
            <div className="signin__error" role="alert">
              {displayError}
            </div>
          )}

          <button
            className="primary signin__btn"
            type="submit"
            disabled={!canSubmit}
          >
            {loading ? 'Signing in...' : isAddAccount ? 'Add account' : 'Sign in'}
          </button>
        </form>

        <p className="signin__hint">
          Connect to any Matrix homeserver. Your data stays end-to-end encrypted.
        </p>
      </div>
    </div>
  )
}
