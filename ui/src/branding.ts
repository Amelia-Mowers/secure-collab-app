/**
 * Product branding + deployment configuration, in one place.
 *
 * TideWork (tidework.io) — the hosted offering's name and domain (ADR 0002).
 * The open-source core stays usable against any homeserver; these constants
 * only control what the UI calls itself and which server it suggests first.
 */

export const APP_NAME = 'TideWork'
export const TAGLINE = 'End-to-end encrypted collaborative workspace'

/** The official hosted homeserver (ADR 0002 phase B). */
export const OFFICIAL_HOMESERVER_URL = 'https://matrix.tidework.io'
export const OFFICIAL_HOMESERVER_LABEL = 'TideWork'

/**
 * The homeserver pre-selected on the sign-in page. Build-time configurable so
 * the hosted deployment can default to the official server the moment phase B
 * goes live (set VITE_DEFAULT_HOMESERVER=https://matrix.tidework.io in that
 * build) without breaking dev/self-host builds, which keep the local Conduit.
 */
export const DEFAULT_HOMESERVER_URL: string =
  (import.meta.env.VITE_DEFAULT_HOMESERVER as string | undefined) ?? 'http://localhost:6167'

/** Where new users subscribe to get a hosted account (ADR 0002 phase D). */
export const SUBSCRIBE_URL = 'https://billing.tidework.io/subscribe'

/** Billing status endpoint for the trial badge / locked gate. */
export const BILLING_STATUS_URL = 'https://billing.tidework.io/status'

/** Manage/cancel endpoint — exchanges a Matrix OpenID token for a Stripe billing
 *  portal URL (issue row_1782751521723). POST, authenticated, CORS. */
export const BILLING_PORTAL_URL = 'https://billing.tidework.io/portal'

/** Checkout for a specific account (trial-first flow — ADR 0002 amended). */
export function subscribeUrlFor(username: string): string {
  return SUBSCRIBE_URL + '?username=' + encodeURIComponent(username)
}
