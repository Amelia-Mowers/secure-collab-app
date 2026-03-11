import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import './SignInPage.css'

export function SignInPage() {
  const { signIn, loading, error } = useAuth()
  const navigate = useNavigate()
  const [homeserver, setHomeserver] = useState('http://localhost:6167')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

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

  const displayError = localError ?? error
  const canSubmit = !loading && homeserver.trim() && username.trim() && password.trim()

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__logo">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="10" width="16" height="10" rx="2" />
            <path d="M7 10V7a4 4 0 018 0v3" />
          </svg>
        </div>

        <h1 className="signin__title">Secure Collab</h1>
        <p className="signin__subtitle">End-to-end encrypted collaborative workspace</p>

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
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="signin__hint">
          Connect to any Matrix homeserver. Your data stays end-to-end encrypted.
        </p>
      </div>
    </div>
  )
}
