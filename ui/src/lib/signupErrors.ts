/**
 * Turn a homeserver's registration refusal into something a person can act on.
 *
 * This exists for self-hosted servers. `infra/selfhost/` ships with
 * registration CLOSED, which is the right default — an open Matrix server is
 * found and abused within days — so the very first thing a new user of a
 * self-hosted TideWork may do is press "Create account" and be refused. What
 * Synapse says is:
 *
 *     M_FORBIDDEN: Registration has been disabled
 *
 * which reads as "you are not allowed" rather than "this server does not work
 * that way, ask your administrator". The difference decides whether they email
 * their admin or conclude the product is broken.
 */

/** Matches the refusal regardless of whether the SDK gives us the errcode, the
 *  message, or both — the wrapper text differs by transport. */
const REGISTRATION_CLOSED = [
  'registration has been disabled',
  'registration is disabled',
  'registration is not enabled',
  'm_forbidden',
]

const NEEDS_TOKEN = ['m_missing_param', 'registration token', 'm_unknown_token']

export function describeSignupError(err: unknown, homeserver: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const lower = raw.toLowerCase()
  let host = homeserver
  try {
    host = new URL(homeserver).host
  } catch {
    /* not a URL — show what they typed */
  }

  if (REGISTRATION_CLOSED.some(m => lower.includes(m))) {
    return (
      `${host} does not allow people to sign themselves up. ` +
      `That is a deliberate setting, not a fault — ask whoever runs the server ` +
      `to create an account for you, then sign in with it here.`
    )
  }

  if (NEEDS_TOKEN.some(m => lower.includes(m))) {
    return (
      `${host} requires an invitation token to register. ` +
      `Ask whoever runs the server for one.`
    )
  }

  if (lower.includes('m_user_in_use')) {
    return `That username is already taken on ${host}. Pick another.`
  }

  if (lower.includes('m_invalid_username')) {
    return `That username is not allowed on ${host}. Try letters, digits and dashes.`
  }

  // Unknown: show what the server actually said. A wrong guess is worse than
  // the raw text, because the raw text can at least be searched for.
  return raw || 'Registration failed'
}
