/**
 * Was a session restore rejected by the server, or did it merely fail to reach
 * it?
 *
 * This distinction decides whether the app DELETES the local account. Getting
 * it wrong is expensive in both directions, and it was wrong: the boot path
 * treated everything except a timeout as an auth failure, so a brief outage of
 * the auth service signed the user out and cleared their cached workspaces
 * (observed in prod 2026-07-26, when MAS was unreachable for a few minutes and
 * then recovered on its own).
 *
 * So this fails OPEN: only a definitive rejection — the server telling us the
 * credentials are no longer valid — removes the account. Anything else keeps
 * it and lets the user retry, because an unreachable server says nothing about
 * whether the session is still good.
 */

/** Markers that mean "the server considered these credentials and refused". */
const REJECTION_MARKERS = [
  'M_UNKNOWN_TOKEN', // Matrix: access token no longer valid
  'M_MISSING_TOKEN',
  'M_FORBIDDEN',
  'invalid_grant', // OAuth/MAS: refresh token rejected
  'invalid_token',
  'unauthorized_client',
]

/** Substrings that mean "we never got a verdict" — network, DNS, TLS, proxy. */
const UNREACHABLE_MARKERS = [
  'timed out',
  'timeout',
  'failed to fetch',
  'networkerror',
  'error sending request',
  'connection',
  'dns',
  'econnrefused',
  'certificate',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
]

export function isSessionRejected(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '')
  if (!text) return false

  // An explicit rejection wins even if the text also mentions a connection —
  // error strings often carry both the request and the response.
  if (REJECTION_MARKERS.some(m => text.includes(m))) return true

  const lower = text.toLowerCase()
  if (UNREACHABLE_MARKERS.some(m => lower.includes(m))) return false

  // HTTP status shapes, checked after the unreachable list so a 504 reads as
  // unreachable rather than as a rejection.
  if (/\b401\b|\b403\b/.test(text)) return true

  // Unknown. Keep the account: a wrong "keep" costs one failed retry, a wrong
  // "delete" costs the user their session and cached workspaces.
  return false
}
