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
import type { ReactNode } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  BILLING_STATUS_URL,
  OFFICIAL_HOMESERVER_URL,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,

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

/**
 * "Subscribe", as a button rather than a link.
 *
 * It used to be an <a> to /subscribe?username=…, which put the account name in
 * a navigation the browser records — history, the referrer handed to Stripe,
 * any screenshot of the URL bar. Getting the Checkout URL by an authenticated
 * POST first costs one round-trip and keeps the name out of all of them.
 *
 * Rendered as a link where it needs to look like one; the accessible role is
 * still a button, because it performs an action before navigating.
 */
function SubscribeAction({
  className,
  children,
  title,
}: {
  className: string
  children: ReactNode
  title?: string
}) {
  const { openCheckout } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onClick = async () => {
    setError(null)
    setBusy(true)
    try {
      await openCheckout() // navigates to Stripe on success
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not start checkout. Please try again.')
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={onClick} disabled={busy} title={title}>
        {busy ? 'Opening…' : children}
      </button>
      {error && <span className="trial-error">{error}</span>}
    </>
  )
}

/** Compact pill for the sidebar/topbar. Renders nothing unless on trial. */
export function TrialBadge() {
  const { billing, username } = useBillingStatus()
  if (!billing || billing.status !== 'trial' || !username) return null
  const days = billing.days_left ?? 0
  return (
    <SubscribeAction
      className={`trial-badge ${days <= 3 ? 'trial-badge--urgent' : ''}`}
      title="Subscribe to keep your account after the trial"
    >
      <span className="trial-badge__dot" aria-hidden="true" />
      Trial · {days} day{days === 1 ? '' : 's'} left
      <span className="trial-badge__cta">Subscribe</span>
    </SubscribeAction>
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
        <SubscribeAction className="trial-gate__subscribe">
          Subscribe — $12/month
        </SubscribeAction>
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
