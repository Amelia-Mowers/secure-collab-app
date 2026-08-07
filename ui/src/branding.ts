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
 * The homeserver this BUILD offers, set at build time with
 * `VITE_DEFAULT_HOMESERVER`. Our deploy sets it to the official server; a
 * self-hosted build sets it to theirs; a dev build gets the local Synapse.
 *
 * The fallback used to be `http://localhost:6167`, which was Conduit's port
 * from before the harnesses moved to Synapse — dead for everybody, including us.
 */
// `?? ` is not enough: `VITE_DEFAULT_HOMESERVER=` with nothing after it is a
// realistic thing to leave in a .env, and an empty string is not nullish — the
// sign-in page would offer a server with no address.
const configuredHomeserver = (
  import.meta.env.VITE_DEFAULT_HOMESERVER as string | undefined
)?.trim()

export const DEFAULT_HOMESERVER_URL: string = configuredHomeserver || 'http://localhost:8008'

/**
 * Is this the build we host? Everything user-facing that names TideWork as a
 * SERVICE keys off this, rather than being hardcoded.
 *
 * A self-hosted build must not advertise our homeserver. Their users would see
 * "TideWork — the official hosted server" offered above the operator's own, and
 * some of them would pick it: signing up on a stranger's service, on a page the
 * operator is hosting. The sign-in page listed it unconditionally.
 */
export const IS_OFFICIAL_BUILD: boolean = DEFAULT_HOMESERVER_URL === OFFICIAL_HOMESERVER_URL

/**
 * What to call this build's homeserver. `VITE_HOMESERVER_LABEL` overrides;
 * otherwise the hostname, which is honest and needs no configuration.
 */
export const DEFAULT_HOMESERVER_LABEL: string =
  (import.meta.env.VITE_HOMESERVER_LABEL as string | undefined)?.trim() ||
  (IS_OFFICIAL_BUILD
    ? OFFICIAL_HOMESERVER_LABEL
    : (() => {
        try {
          return new URL(DEFAULT_HOMESERVER_URL).host
        } catch {
          return DEFAULT_HOMESERVER_URL
        }
      })())

/** Where new users subscribe to get a hosted account (ADR 0002 phase D). */
/**
 * How a user reaches a human, and the documents they agreed to.
 *
 * These live in the app rather than only on the marketing site because every
 * user who needs support is *inside the app* when they find that out — a locked
 * account, a failed payment, a device that will not verify. Nobody in that
 * position is browsing a footer on tidework.io.
 */
export const SUPPORT_EMAIL = 'tideworksupport@proton.me'
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`
export const TERMS_URL = 'https://tidework.io/terms'
export const PRIVACY_URL = 'https://tidework.io/privacy'
/** Public page for restarting a lapsed subscription without signing in. */
export const REACTIVATE_URL = 'https://tidework.io/reactivate'
/**
 * MAS's self-service account portal: sessions, devices, sign-out-everywhere,
 * and deactivation.
 *
 * Linked rather than reimplemented. MAS owns the session records, so an in-app
 * device manager would be a second view of somebody else's state — able to
 * drift, and able to show a device as revoked that is not. The portal is the
 * authority, and it is already deployed.
 *
 * Only meaningful for accounts on OUR homeserver; a self-hosted user's sessions
 * live on their own MAS.
 */
export const ACCOUNT_PORTAL_URL = 'https://auth.tidework.io/account/'

/** Operational status. Served from Cloudflare Pages while the homeserver runs
 *  elsewhere, so it survives the outage it most often has to describe. */
export const STATUS_URL = 'https://tidework.io/status'


/** Billing status endpoint for the trial badge / locked gate. */
export const BILLING_STATUS_URL = 'https://billing.tidework.io/status'

/** Manage/cancel endpoint — exchanges a Matrix OpenID token for a Stripe billing
 *  portal URL (issue row_1782751521723). POST, authenticated, CORS. */
export const BILLING_PORTAL_URL = 'https://billing.tidework.io/portal'

/** Authenticated Stripe Checkout. POST an OpenID token, get a URL back —
 *  so the account name never appears in a navigation the browser records. */
export const BILLING_CHECKOUT_URL = 'https://billing.tidework.io/checkout'

/** Account deletion — same OpenID-token proof as the portal. The Worker cancels
 *  billing and then deactivates + erases, because doing only the second half in
 *  the app would leave a live subscription billing a deleted account. */
export const BILLING_DELETE_ACCOUNT_URL = 'https://billing.tidework.io/delete-account'
