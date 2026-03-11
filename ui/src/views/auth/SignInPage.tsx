import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import './SignInPage.css'

export function SignInPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    signIn(name.trim())
    navigate('/workspaces')
  }

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
            <label className="signin__label" htmlFor="username">Your name</label>
            <input
              id="username"
              className="signin__input"
              type="text"
              placeholder="e.g. Alice"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
          <button className="primary signin__btn" type="submit" disabled={!name.trim()}>
            Continue
          </button>
        </form>

        <p className="signin__stub-note">
          <strong>Matrix authentication coming soon.</strong><br />
          For now, enter any name to get started locally.
        </p>
      </div>
    </div>
  )
}
