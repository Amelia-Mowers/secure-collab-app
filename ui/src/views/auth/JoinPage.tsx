import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import './JoinPage.css'

/**
 * Following a workspace invite link (issue 5e362d42).
 *
 * Sharing a workspace used to require the colleague's Matrix ID, which means
 * they had to already have an account — the invite flow demanded protocol
 * literacy from the one person who has not yet agreed to try the product.
 *
 * A link cannot be an ordinary Matrix invite, because an invite names a user
 * and a link-holder has no user id until they sign up. So this page knocks on
 * the room presenting the link's token, and an admin's client verifies it and
 * admits them.
 *
 * The token is in the URL FRAGMENT, never the query string: a fragment is not
 * sent to any server, so the secret does not land in access logs on the way.
 */

/** Survives the sign-in round trip. Session, not local: an invite half-followed
 *  in one tab must not resume in another, and must not outlive the browser. */
const PENDING_KEY = 'tw.pendingInvite'

interface PendingInvite {
  roomId: string
  token: string
}

/** `#<url-encoded room id>&<token>` — the shape `invite_url` produces. */
export function parseInviteFragment(fragment: string): PendingInvite | null {
  const frag = fragment.replace(/^#/, '')
  const sep = frag.indexOf('&')
  if (sep <= 0) return null
  const roomId = decodeURIComponent(frag.slice(0, sep))
  const token = frag.slice(sep + 1)
  if (!roomId || !token) return null
  return { roomId, token }
}

export function readPendingInvite(): PendingInvite | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingInvite
    return parsed.roomId && parsed.token ? parsed : null
  } catch {
    return null
  }
}

function storePendingInvite(invite: PendingInvite) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(invite))
  } catch {
    // Private mode with storage disabled: the flow still works as long as the
    // user does not need to sign in first, so this is not fatal.
  }
}

export function clearPendingInvite() {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to clear */
  }
}

type Phase = 'reading' | 'needs-account' | 'knocking' | 'waiting' | 'joined' | 'error'

/** How often to look for the invite that admitting produces. */
const POLL_MS = 3000

export function JoinPage() {
  const navigate = useNavigate()
  // `username` is derived synchronously from localStorage; `matrixSession`
  // restores asynchronously after it. Both matter: no account means we ask for
  // one, but an account whose session has not finished restoring must WAIT
  // rather than be told to sign in — that would send a signed-in user back to
  // the sign-in page for a second or two on every follow.
  const { username, accounts, matrixSession, knockWithToken, listInvitedRooms, acceptInvite } =
    useAuth()

  const [phase, setPhase] = useState<Phase>('reading')
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<PendingInvite | null>(null)
  const knockedRef = useRef(false)

  // Read the link once, and stash it immediately — signing in navigates away,
  // and the fragment does not survive that round trip.
  useEffect(() => {
    const fromUrl = parseInviteFragment(window.location.hash)
    const pending = fromUrl ?? readPendingInvite()
    if (!pending) {
      setError('That invite link is incomplete. Ask whoever sent it for a fresh one.')
      setPhase('error')
      return
    }
    if (fromUrl) storePendingInvite(fromUrl)
    setInvite(pending)
  }, [])

  useEffect(() => {
    if (!invite) return
    if (!username && accounts.length === 0) {
      setPhase('needs-account')
      return
    }
    if (!matrixSession) {
      // Session still restoring. Stay on the spinner; this effect re-runs when
      // it lands.
      setPhase('reading')
      return
    }
    if (knockedRef.current) return
    knockedRef.current = true

    setPhase('knocking')
    knockWithToken(invite.roomId, invite.token)
      .then(() => setPhase('waiting'))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        // Already knocking, or already a member: both mean "carry on waiting"
        // rather than "this failed". Re-following a link is a normal thing to
        // do when nothing appears to happen the first time.
        if (/already/i.test(message)) {
          setPhase('waiting')
          return
        }
        setError(message)
        setPhase('error')
      })
  }, [invite, username, accounts.length, matrixSession, knockWithToken])

  const tryAccept = useCallback(async () => {
    if (!invite) return
    const invitations = await listInvitedRooms()
    if (!invitations.some(i => i.id === invite.roomId)) return
    await acceptInvite(invite.roomId)
    clearPendingInvite()
    setPhase('joined')
    navigate(`/workspace/${encodeURIComponent(invite.roomId)}`, { replace: true })
  }, [invite, listInvitedRooms, acceptInvite, navigate])

  // Poll for the invite an admin's client produces when it admits us.
  useEffect(() => {
    if (phase !== 'waiting') return
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      tryAccept().catch(() => {
        // Transient: the next tick tries again. A failure here is usually the
        // invite not having synced yet, which is not worth showing anyone.
      })
    }
    tick()
    const handle = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [phase, tryAccept])

  const goSignIn = (createAccount: boolean) => {
    navigate(createAccount ? '/signin?create=1' : '/signin')
  }

  if (phase === 'error') {
    return (
      <div className="join-page">
        <div className="join-card">
          <h1 className="join-card__title">This link did not work</h1>
          <p className="join-card__body">{error}</p>
          <button className="primary" onClick={() => navigate('/workspaces')}>
            Go to my workspaces
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'needs-account') {
    return (
      <div className="join-page">
        <div className="join-card">
          <h1 className="join-card__title">You have been invited to a workspace</h1>
          <p className="join-card__body">
            Sign in to accept, or create an account — it takes a minute and comes
            with the same free trial as any other account.
          </p>
          <div className="join-card__actions">
            <button className="primary" onClick={() => goSignIn(true)}>
              Create an account
            </button>
            <button onClick={() => goSignIn(false)}>I already have one</button>
          </div>
          <p className="join-card__note">
            Your workspace data is end-to-end encrypted. Whoever invited you can
            see it; we cannot.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="join-page">
      <div className="join-card">
        <LoadingSpinner
          message={
            phase === 'reading'
              ? 'Opening your invitation…'
              : phase === 'knocking'
                ? 'Checking your invitation…'
                : 'Waiting to be let in…'
          }
        />
        {phase === 'waiting' && (
          // Said plainly rather than hidden behind a spinner: admitting happens
          // in the inviter's browser, so a link followed while nobody has the
          // app open genuinely waits. Someone staring at a spinner with no
          // explanation concludes the product is broken.
          <p className="join-card__note">
            Your request has been sent. You will be let in automatically once
            someone who administers this workspace has TideWork open — usually
            straight away, but it can wait until they are back at their desk.
            You can close this tab; the invitation will be on your Workspaces
            page.
          </p>
        )}
      </div>
    </div>
  )
}
