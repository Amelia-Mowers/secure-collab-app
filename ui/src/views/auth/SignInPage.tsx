import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import type { AccountSession } from '@/hooks/useAuth'
import { openOauthPopup } from '@/auth/oauthPopup'
import {
  APP_NAME,
  TAGLINE,
  DEFAULT_HOMESERVER_URL,
  OFFICIAL_HOMESERVER_URL,
  OFFICIAL_HOMESERVER_LABEL,
} from '@/branding'
import './SignInPage.css'

// ── Suggested homeservers ────────────────────────────────────────────────────

interface HomeserverOption {
  label: string
  url: string
  description: string
}

// Two ways in, both first-class: the hosted server, or any server you run.
// (General public servers were removed — they aren't a supported path; the
// custom entry covers every self-host/BYO case, including local dev.)
const SUGGESTED_SERVERS: HomeserverOption[] = [
  {
    label: OFFICIAL_HOMESERVER_LABEL,
    url: OFFICIAL_HOMESERVER_URL,
    description: 'The official hosted server — secure sign-in, managed & backed up',
  },
]

type AuthMode = 'signin' | 'signup'

export function SignInPage() {
  const { signIn, signUp, signInWithOauth, checkOauthSupport, switchAccount, loading, error, accounts } =
    useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isAddAccount = searchParams.get('addAccount') === '1'
  const [mode, setMode] = useState<AuthMode>('signin')
  const [homeserver, setHomeserver] = useState(DEFAULT_HOMESERVER_URL)
  const [showCustomServer, setShowCustomServer] = useState(
    !SUGGESTED_SERVERS.some(s => s.url === DEFAULT_HOMESERVER_URL),
  )
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(isAddAccount || accounts.length === 0)
  /** True when the selected homeserver delegates auth to OAuth/MAS (MSC3861):
   *  password login doesn't exist there, so the credentials form is replaced
   *  by the secure sign-in (popup) flow. */
  const [oauthServer, setOauthServer] = useState(false)

  // Probe the selected homeserver for next-gen auth, debounced so typing a
  // custom URL doesn't spam requests. Unknown/unreachable ⇒ password form.
  useEffect(() => {
    const hs = homeserver.trim()
    setOauthServer(false)
    if (!hs || !/^https?:\/\//.test(hs)) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const supported = await checkOauthSupport(hs)
      if (!cancelled) setOauthServer(supported)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [homeserver, checkOauthSupport])

  const handleOauthSignIn = async () => {
    setLocalError(null)
    // Must open synchronously inside the click handler — popup blockers only
    // allow window.open during user activation.
    const popup = openOauthPopup()
    if (!popup) {
      setLocalError(
        'Your browser blocked the sign-in window — allow popups for this site and try again.',
      )
      return
    }
    try {
      await signInWithOauth(homeserver.trim(), popup)
      navigate('/workspaces')
    } catch (err: any) {
      setLocalError(err?.message ?? 'Sign-in failed')
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!homeserver.trim() || !username.trim() || !password.trim()) return

    if (mode === 'signup' && password !== confirmPassword) {
      setLocalError('Passwords do not match')
      return
    }

    setLocalError(null)

    try {
      if (mode === 'signup') {
        await signUp(homeserver.trim(), username.trim(), password)
      } else {
        await signIn(homeserver.trim(), username.trim(), password)
      }
      navigate('/workspaces')
    } catch (err: any) {
      setLocalError(err?.message ?? `${mode === 'signup' ? 'Registration' : 'Sign-in'} failed`)
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

  const handleSelectServer = (url: string) => {
    setHomeserver(url)
    setShowCustomServer(false)
  }

  const handleCustomServer = () => {
    setShowCustomServer(true)
    setHomeserver('')
  }

  const displayError = localError ?? error
  const canSubmit =
    !loading &&
    homeserver.trim() &&
    username.trim() &&
    password.trim() &&
    (mode === 'signin' || confirmPassword.trim())

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
                    {account.userId}
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
          {isAddAccount ? 'Add Account' : APP_NAME}
        </h1>
        <p className="signin__subtitle">
          {isAddAccount
            ? 'Sign in or create a Matrix account'
            : TAGLINE}
        </p>

        {/* ── Sign in / Sign up tabs ─────────────────────────────
            Only meaningful for password (custom) servers. Next-gen-auth
            servers like the hosted TideWork one own their own combined
            sign-in/registration flow on their page, so the toggle is hidden
            there to avoid implying a separate local choice. */}
        {!oauthServer && (
          <div className="signin__tabs">
            <button
              className={`signin__tab ${mode === 'signin' ? 'signin__tab--active' : ''}`}
              onClick={() => { setMode('signin'); setLocalError(null) }}
              type="button"
            >
              Sign in
            </button>
            <button
              className={`signin__tab ${mode === 'signup' ? 'signin__tab--active' : ''}`}
              onClick={() => { setMode('signup'); setLocalError(null) }}
              type="button"
            >
              Create account
            </button>
          </div>
        )}

        {/* ── Homeserver picker ───────────────────────────────── */}
        <fieldset className="signin__server-picker">
          <legend className="signin__label">Homeserver</legend>
          <div className="signin__server-list">
            {SUGGESTED_SERVERS.map(server => (
              <button
                key={server.url}
                type="button"
                className={`signin__server-option ${homeserver === server.url && !showCustomServer ? 'signin__server-option--active' : ''}`}
                onClick={() => handleSelectServer(server.url)}
              >
                <span className="signin__server-name">{server.label}</span>
                <span className="signin__server-desc">{server.description}</span>
              </button>
            ))}
            <button
              type="button"
              className={`signin__server-option ${showCustomServer ? 'signin__server-option--active' : ''}`}
              onClick={handleCustomServer}
            >
              <span className="signin__server-name">Custom server</span>
              <span className="signin__server-desc">Enter a homeserver URL manually</span>
            </button>
          </div>
          {showCustomServer && (
            <input
              className="signin__input signin__server-input"
              type="url"
              placeholder="https://matrix.example.com"
              value={homeserver}
              onChange={e => setHomeserver(e.target.value)}
              autoFocus
            />
          )}
        </fieldset>

        {oauthServer ? (
          /* ── Next-gen auth: the server owns sign-in/registration ────── */
          <div className="signin__form" data-testid="oauth-signin">
            <p className="signin__hint">
              This server uses secure single sign-on. You&apos;ll sign in in a popup on
              your server&apos;s own page.
            </p>
            {displayError && (
              <div className="signin__error" role="alert">
                {displayError}
              </div>
            )}
            <button
              className="primary signin__btn"
              type="button"
              onClick={handleOauthSignIn}
              disabled={loading || !homeserver.trim()}
            >
              {loading ? 'Waiting for sign-in…' : 'Continue with secure sign-in'}
            </button>
          </div>
        ) : (
        <form className="signin__form" onSubmit={handleSubmit}>
          <div>
            <label className="signin__label" htmlFor="username">Username</label>
            <input
              id="username"
              className="signin__input"
              type="text"
              placeholder={mode === 'signup' ? 'Choose a username' : 'e.g. alice'}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus={!showCustomServer}
              autoComplete="username"
            />
          </div>
          <div>
            <label className="signin__label" htmlFor="password">Password</label>
            <input
              id="password"
              className="signin__input"
              type="password"
              placeholder={mode === 'signup' ? 'Choose a password' : 'Password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="signin__label" htmlFor="confirm-password">Confirm password</label>
              <input
                id="confirm-password"
                className="signin__input"
                type="password"
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          )}

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
            {loading
              ? (mode === 'signup' ? 'Creating account...' : 'Signing in...')
              : (mode === 'signup' ? 'Create account' : (isAddAccount ? 'Add account' : 'Sign in'))
            }
          </button>
        </form>
        )}

        <p className="signin__hint">
          {mode === 'signup'
            ? 'Your account will be created on the selected homeserver. You can use it across any Matrix-compatible app.'
            : 'Connect to any Matrix homeserver. Your data stays end-to-end encrypted.'}
        </p>
      </div>
    </div>
  )
}
