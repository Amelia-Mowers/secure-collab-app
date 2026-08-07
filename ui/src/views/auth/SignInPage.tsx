import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import type { AccountSession } from '@/hooks/useAuth'
import { openOauthPopup } from '@/auth/oauthPopup'
import {
  APP_NAME,
  TAGLINE,
  DEFAULT_HOMESERVER_URL,
  DEFAULT_HOMESERVER_LABEL,
  IS_OFFICIAL_BUILD,
  OFFICIAL_HOMESERVER_URL,
  OFFICIAL_HOMESERVER_LABEL,
} from '@/branding'
import { describeSignupError } from '@/lib/signupErrors'
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
/**
 * The one server this build offers, plus "Custom server" for anything else.
 *
 * Derived from the build rather than hardcoded, because a self-hosted TideWork
 * must not advertise OUR homeserver: their users would be offered "TideWork —
 * the official hosted server" above the operator's own, on a page the operator
 * is hosting, and some would sign up on a stranger's service by accident.
 */
const SUGGESTED_SERVERS: HomeserverOption[] = [
  IS_OFFICIAL_BUILD
    ? {
        label: OFFICIAL_HOMESERVER_LABEL,
        url: OFFICIAL_HOMESERVER_URL,
        description: 'The official hosted server — secure sign-in, managed & backed up',
      }
    : {
        label: DEFAULT_HOMESERVER_LABEL,
        url: DEFAULT_HOMESERVER_URL,
        description: 'This server',
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
  const [registrationToken, setRegistrationToken] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(isAddAccount || accounts.length === 0)
  /** What kind of auth the selected homeserver offers (MSC3861 next-gen auth
   *  vs. password). `probing` is a real state, not a synonym for "password" —
   *  treating "not yet known" as "password" is what made the page render the
   *  credentials form and then swap it for the SSO button a moment later. */
  const [authKind, setAuthKind] = useState<'probing' | 'oauth' | 'password'>('probing')

  /** A suggested (hosted) server, as opposed to a URL the user typed. We KNOW
   *  the hosted server delegates to MAS, so it never shows a password form:
   *  password login does not exist there, and offering it during a MAS outage
   *  would just fail confusingly. It gets a warning instead. */
  const isSuggestedServer =
    !showCustomServer && SUGGESTED_SERVERS.some(srv => srv.url === homeserver.trim())

  // Probe the selected homeserver, debounced so typing a custom URL doesn't
  // spam requests.
  useEffect(() => {
    const hs = homeserver.trim()
    setAuthKind('probing')
    if (!hs || !/^https?:\/\//.test(hs)) {
      setAuthKind('password')
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const supported = await checkOauthSupport(hs)
      if (!cancelled) setAuthKind(supported ? 'oauth' : 'password')
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [homeserver, checkOauthSupport])

  // Show the SSO flow whenever the server does next-gen auth — and, for OUR
  // hosted server, while we are still asking and even if the probe failed.
  //
  // That optimism is specific to the server we run, which is MAS-backed and
  // therefore known to do SSO. It must NOT extend to whatever server a
  // self-hosted build suggests: `infra/selfhost/` is a plain Synapse with
  // password accounts, and offering its users an SSO button that cannot work —
  // while hiding the username and password fields that can — would make a
  // correctly configured self-hosted deployment look broken on its first screen.
  const optimisticSso = isSuggestedServer && IS_OFFICIAL_BUILD
  const showOauth = authKind === 'oauth' || optimisticSso
  /** The hosted server should do SSO but the probe says otherwise: MAS is
   *  unreachable. Say so rather than silently offering a button that fails. */
  const ssoUnavailable = optimisticSso && authKind === 'password'

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
        await signUp(homeserver.trim(), username.trim(), password, registrationToken.trim())
      } else {
        await signIn(homeserver.trim(), username.trim(), password)
      }
      navigate('/workspaces')
    } catch (err: any) {
      setLocalError(
        mode === 'signup'
          ? describeSignupError(err, homeserver.trim())
          : (err?.message ?? 'Sign-in failed'),
      )
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
        {!showOauth && (
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

        {showOauth ? (
          /* ── Next-gen auth: the server owns sign-in/registration ────── */
          <div className="signin__form" data-testid="oauth-signin">
            <p className="signin__hint">
              This server uses secure single sign-on. You&apos;ll sign in in a popup on
              your server&apos;s own page.
            </p>
            {ssoUnavailable && (
              <div className="signin__warning" role="alert">
                Can&apos;t reach the sign-in service right now. It may be briefly
                unavailable — try again in a moment.
              </div>
            )}
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

          {/* Optional, because most servers do not ask for one — but a
              self-hosted server that gates sign-up behind an invitation token
              has no other way to accept it, and without this field its users
              could only be created by the operator running a shell command per
              person. Always shown rather than revealed after a failure: a
              server cannot be asked whether it wants a token without first
              attempting a registration. */}
          {mode === 'signup' && (
            <div>
              <label className="signin__label" htmlFor="registration-token">
                Invitation token <span className="signin__optional">optional</span>
              </label>
              <input
                id="registration-token"
                className="signin__input"
                type="text"
                placeholder="Only if your server requires one"
                value={registrationToken}
                onChange={e => setRegistrationToken(e.target.value)}
                autoComplete="off"
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

        {/* A locked account cannot sign in at all — the homeserver refuses
            before the app is ever reached — so the way back has to be offered
            HERE, where that user is stuck, rather than behind a session. */}
        {mode !== 'signup' && (
          <p className="signin__hint">
            Account locked after a trial or lapsed subscription?{' '}
            <a href="https://tidework.io/reactivate" target="_blank" rel="noreferrer">
              Reactivate it
            </a>{' '}
            — no sign-in needed.
          </p>
        )}
      </div>
    </div>
  )
}
