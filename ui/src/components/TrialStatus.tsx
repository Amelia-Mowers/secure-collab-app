/**
 * Trial-first billing surfaces (ADR 0002, amended):
 *  - <TrialBadge/>: compact pill — days left + subscribe link. Sidebar/topbar.
 *  - <TrialGate/>: full-page prompt when the account is LOCKED (trial over or
 *    subscription lapsed). No bypass except subscribing or signing out — the
 *    server already refuses sync for locked accounts; this screen just makes
 *    the way forward obvious.
 *
 * Status comes from the billing Worker (coarse: active|trial|locked|unknown),
 * and only for accounts on the official homeserver — self-hosted users never
 * see any of this.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  BILLING_STATUS_URL,
  OFFICIAL_HOMESERVER_URL,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
  subscribeUrlFor,
} from '@/branding'
import { ManageSubscriptionButton } from './ManageSubscriptionButton'
import './TrialStatus.css'

interface Billing {
  status: 'active' | 'trial' | 'locked' | 'unknown'
  days_left?: number
}

function useBillingStatus(): { billing: Billing | null; username: string | null } {
  const { userId, homeserverUrl } = useAuth()
  const [billing, setBilling] = useState<Billing | null>(null)

  const onOfficial = homeserverUrl?.replace(/\/$/, '') === OFFICIAL_HOMESERVER_URL
  const username = userId?.startsWith('@') ? userId.slice(1).split(':')[0] : null

  useEffect(() => {
    if (!onOfficial || !username) {
      setBilling(null)
      return
    }
    let cancelled = false
    fetch(`${BILLING_STATUS_URL}?username=${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then((b: Billing) => {
        if (!cancelled) setBilling(b)
      })
      .catch(() => {
        /* billing unreachable — show nothing rather than nag */
      })
    return () => {
      cancelled = true
    }
  }, [onOfficial, username])

  return { billing, username }
}

/** Compact pill for the sidebar/topbar. Renders nothing unless on trial. */
export function TrialBadge() {
  const { billing, username } = useBillingStatus()
  if (!billing || billing.status !== 'trial' || !username) return null
  const days = billing.days_left ?? 0
  return (
    <a
      className={`trial-badge ${days <= 3 ? 'trial-badge--urgent' : ''}`}
      href={subscribeUrlFor(username)}
      target="_blank"
      rel="noreferrer"
      title="Subscribe to keep your account after the trial"
    >
      <span className="trial-badge__dot" aria-hidden="true" />
      Trial · {days} day{days === 1 ? '' : 's'} left
      <span className="trial-badge__cta">Subscribe</span>
    </a>
  )
}

/** Full-page gate when the account is locked. Mounted globally in App. */
export function TrialGate() {
  const { billing, username } = useBillingStatus()
  const { signOut } = useAuth()
  if (!billing || billing.status !== 'locked' || !username) return null
  return (
    <div className="trial-gate" role="dialog" aria-modal="true" aria-labelledby="trial-gate-title">
      <div className="trial-gate__card">
        <h2 id="trial-gate-title">Your trial has ended</h2>
        <p>
          <strong>@{username}:tidework.io</strong> is paused — your encrypted workspaces are
          safe and untouched (we couldn&apos;t read them if we tried), but sync is off until
          you subscribe. Pick up exactly where you left off:
        </p>
        <a className="trial-gate__subscribe" href={subscribeUrlFor(username)}>
          Subscribe — $12/month
        </a>
        <ManageSubscriptionButton className="trial-gate__manage" errorClassName="trial-gate__error" />
        <button type="button" className="trial-gate__signout" onClick={signOut}>
          Sign out
        </button>
        {/* A paused account is one of the likeliest moments someone needs a
            human, and this screen has no other way out. */}
        <p className="trial-gate__help">
          Something not right? <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>
        </p>
      </div>
    </div>
  )
}
