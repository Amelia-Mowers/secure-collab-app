/**
 * TideWork billing Worker — Stripe ↔ MAS (ADR 0002 phase D, trial-first).
 *
 * Registration is OPEN with a TRIAL_DAYS trial; this worker enforces the
 * commercial boundary:
 *   GET  /subscribe?username=  → Stripe Checkout, keyed to the account
 *   GET  /success              → confirmation page (no tokens — the account
 *                                already exists; payment just unlocks/keeps it)
 *   GET  /status?username=     → coarse {status, days_left} for the app badge
 *   POST /portal               → Stripe billing portal (manage / CANCEL)
 *   POST /delete-account       → cancel billing, then deactivate + erase
 *   POST /webhook              → lock on lapse/unpaid, unlock on active
 *   cron (and guarded /__sweep)→ lock unpaid accounts past the trial + grace
 *
 * Invariants (ADR 0002):
 *  - Lock, never deactivate — except never-paid accounts long past trial,
 *    where there is nothing of value to preserve. That exception turns on
 *    only with DELETE_AFTER_DAYS > 0 and DELETE_MODE=apply, and it keys on
 *    "never had a subscription", so a lapsed customer stays locked forever.
 *  - Stripe is the database: the username lives on subscription metadata,
 *    set programmatically at checkout (client_reference_id + metadata) — no
 *    hand-typed coupling.
 */
import Stripe from 'stripe'

export interface Env {
  MAS_URL: string
  MAS_BILLING_CLIENT_ID: string
  PRICE_CENTS: string
  PRICE_CURRENCY: string
  TRIAL_DAYS: string
  /** Extra days after the trial ends before the sweep locks. "0" = lock on the dot. */
  GRACE_DAYS: string
  /**
   * Days past the lock deadline after which a NEVER-PAID locked account is
   * deactivated + erased. "0" (or absent) disables deletion entirely.
   */
  DELETE_AFTER_DAYS: string
  /**
   * "apply" actually deletes. Anything else (default) only logs what it would
   * have deleted — deletion is irreversible, so it stays opt-in.
   */
  DELETE_MODE: string
  EXEMPT_USERNAMES: string
  SITE_URL: string
  APP_URL: string
  STRIPE_API_KEY: string
  STRIPE_WEBHOOK_SIGNING_SECRET: string
  MAS_BILLING_CLIENT_SECRET: string
  // Matrix homeserver, for verifying OpenID tokens on /portal (manage/cancel).
  HOMESERVER_URL: string // e.g. https://matrix.tidework.io
  MATRIX_SERVER_NAME: string // e.g. tidework.io — pins the token's server (anti-SSRF)
}

const stripeClient = (env: Env) =>
  new Stripe(env.STRIPE_API_KEY, { httpClient: Stripe.createFetchHttpClient() })

// ── MAS admin API ────────────────────────────────────────────────────────────

interface MasUser {
  id: string
  attributes: {
    username: string
    created_at: string
    locked_at: string | null
    /** Null unless already deactivated — the deletion sweep skips those. */
    deactivated_at?: string | null
    admin: boolean
  }
}

async function masAdminToken(env: Env): Promise<string> {
  const res = await fetch(`${env.MAS_URL}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.MAS_BILLING_CLIENT_ID}:${env.MAS_BILLING_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=urn:mas:admin',
  })
  if (!res.ok) throw new Error(`MAS token mint failed: ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function masGetUser(env: Env, tok: string, username: string): Promise<MasUser | null> {
  const res = await fetch(
    `${env.MAS_URL}/api/admin/v1/users/by-username/${encodeURIComponent(username)}`,
    { headers: { Authorization: `Bearer ${tok}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`MAS user lookup failed: ${res.status}`)
  return ((await res.json()) as { data: MasUser }).data
}

async function masListUsers(env: Env, tok: string): Promise<MasUser[]> {
  const users: MasUser[] = []
  let after = ''
  for (let page = 0; page < 100; page++) {
    const url = `${env.MAS_URL}/api/admin/v1/users?page[size]=100${after ? `&page[after]=${after}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
    if (!res.ok) throw new Error(`MAS user list failed: ${res.status}`)
    const batch = ((await res.json()) as { data: MasUser[] }).data
    if (batch.length === 0) break
    users.push(...batch)
    after = batch[batch.length - 1].id
  }
  return users
}

async function masSetLockById(env: Env, tok: string, id: string, lock: boolean): Promise<void> {
  const res = await fetch(`${env.MAS_URL}/api/admin/v1/users/${id}/${lock ? 'lock' : 'unlock'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` },
  })
  if (!res.ok) throw new Error(`MAS ${lock ? 'lock' : 'unlock'} failed: ${res.status}`)
}

/**
 * Unlink every upstream identity (Google, etc.) from a user.
 *
 * Deactivating does NOT do this, and the consequence is severe: MAS keeps the
 * `provider + subject -> user` mapping, so the next sign-in with that Google
 * account resolves to the deactivated user and dead-ends on "This account has
 * been deleted. Contact your server administrator." Permanently, for an
 * identity the person still owns — and only an operator with admin API access
 * can undo it.
 *
 * So a deletion has to free the identity, or deleting an account silently burns
 * the Google login the user signed up with. Best-effort per link: freeing three
 * of four identities is better than aborting the deletion the user asked for.
 */
async function masUnlinkUpstream(env: Env, tok: string, userId: string): Promise<number> {
  const res = await fetch(
    `${env.MAS_URL}/api/admin/v1/upstream-oauth-links?filter[user]=${encodeURIComponent(userId)}&page[first]=100`,
    { headers: { Authorization: `Bearer ${tok}` } },
  )
  if (!res.ok) throw new Error(`MAS upstream-link list failed: ${res.status}`)
  const links = ((await res.json()) as { data: Array<{ id: string }> }).data ?? []

  let removed = 0
  for (const link of links) {
    const del = await fetch(`${env.MAS_URL}/api/admin/v1/upstream-oauth-links/${link.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    })
    if (del.ok) removed++
    else console.error(`delete-account: unlink ${link.id} failed: ${del.status}`)
  }
  return removed
}

/**
 * Deactivate a user and ask the homeserver to GDPR-erase them.
 *
 * The ONE exception to lock-never-deactivate (ADR 0002): an account that never
 * paid and sat locked long past the trial has nothing worth preserving. MAS
 * invalidates every session, makes the user leave all rooms, and — with
 * `skip_erase: false` — asks Synapse to erase. Treat as irreversible: MAS has a
 * `reactivate` endpoint, but it cannot un-erase, and it cannot bring back E2E
 * history whose keys are gone.
 */
async function masDeactivateById(env: Env, tok: string, id: string): Promise<void> {
  const res = await fetch(`${env.MAS_URL}/api/admin/v1/users/${id}/deactivate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_erase: false }),
  })
  if (!res.ok) throw new Error(`MAS deactivate failed: ${res.status}`)
}

// ── Stripe helpers ───────────────────────────────────────────────────────────

async function activeSubscriptionFor(env: Env, username: string): Promise<boolean> {
  const stripe = stripeClient(env)
  const found = await stripe.subscriptions.search({
    query: `metadata['tidework_username']:'${username.replace(/'/g, '')}' AND status:'active'`,
    limit: 1,
  })
  return found.data.length > 0
}

interface SubscriptionIndex {
  /** In good standing right now — `active` or `trialing`. Drives locking. */
  paying: Set<string>
  /** Has EVER had a subscription, any status. Drives deletion eligibility. */
  everPaid: Set<string>
  /**
   * False if pagination hit its cap with more to fetch, i.e. `everPaid` is
   * missing entries. Deletion MUST NOT run on a partial index — an absent
   * username would read as "never paid" and erase a real customer.
   */
  complete: boolean
}

/**
 * Both views of who has a subscription, from one paginated pass over Stripe's
 * `list` endpoint.
 *
 * `subscriptions.search` (above) runs against Stripe's search index, which is
 * eventually consistent — it can lag a write by up to a minute. That is fine
 * for the /status badge, but not for the sweep: a user who paid moments before
 * the cron fired would be invisible to search and get locked out. `list` is
 * strongly consistent, so the sweep reads that instead. It is cheaper too — one
 * paginated pass replaces a per-user search.
 *
 * The two sets differ in the case that matters most: someone who paid and then
 * lapsed is absent from `paying` (so they get locked) but present in
 * `everPaid` (so they are never deleted — they have data they paid for).
 */
async function subscriptionIndex(env: Env): Promise<SubscriptionIndex> {
  const stripe = stripeClient(env)
  const paying = new Set<string>()
  const everPaid = new Set<string>()
  let startingAfter: string | undefined
  let complete = false
  for (let page = 0; page < 100; page++) {
    const batch = await stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    for (const sub of batch.data) {
      const username = sub.metadata?.tidework_username
      if (!username) continue
      everPaid.add(username)
      if (sub.status === 'active' || sub.status === 'trialing') paying.add(username)
    }
    if (!batch.has_more || batch.data.length === 0) {
      complete = true
      break
    }
    startingAfter = batch.data[batch.data.length - 1].id
  }
  return { paying, everPaid, complete }
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function subscribe(env: Env, url: URL): Promise<Response> {
  const username = url.searchParams.get('username')?.trim()
  // No account context → the journey starts with a free account in the app.
  if (!username) return Response.redirect(env.APP_URL, 302)

  const stripe = stripeClient(env)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: username,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: env.PRICE_CURRENCY,
          unit_amount: parseInt(env.PRICE_CENTS, 10),
          recurring: { interval: 'month' },
          product_data: {
            name: 'TideWork Hosted',
            description: `Keeps @${username}:tidework.io active — managed, backed up, end-to-end encrypted.`,
          },
        },
      },
    ],
    // Surface the promo-code field at checkout so coupon/promotion codes work
    // (e.g. a 100%-off founder code, or comping a live-flow test without a
    // real charge). Codes are created in the Stripe dashboard, per-mode.
    allow_promotion_codes: true,
    // The username rides on the SUBSCRIPTION itself, programmatically — this
    // is what the webhook + sweep key on. No hand-typed coupling.
    subscription_data: { metadata: { tidework_username: username } },
    success_url: 'https://billing.tidework.io/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: env.APP_URL,
  })
  return Response.redirect(session.url!, 303)
}

async function success(env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get('session_id')
  if (!sessionId) return new Response('Missing session', { status: 400 })

  const stripe = stripeClient(env)
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
  // A 100%-off promotion code yields `no_payment_required` (no money moves but
  // the subscription is live) — accept it alongside `paid`; only a genuinely
  // unpaid session is a failure.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return new Response('Payment not completed', { status: 402 })
  }

  const username = session.client_reference_id ?? 'your account'

  // If the trial already lapsed and locked the account, unlock right now —
  // don't make a paying user wait for the webhook race.
  try {
    const tok = await masAdminToken(env)
    const user = await masGetUser(env, tok, username)
    if (user?.attributes.locked_at) await masSetLockById(env, tok, user.id, false)
  } catch (err) {
    console.error('post-payment unlock failed (webhook will retry):', err)
  }

  return new Response(successPage(env, username), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** Coarse account standing for the app's trial badge / locked screen. */
async function status(env: Env, url: URL): Promise<Response> {
  const username = url.searchParams.get('username')?.trim()
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': env.APP_URL,
    'Cache-Control': 'private, max-age=300',
  }
  if (!username) return new Response(JSON.stringify({ status: 'unknown' }), { headers })

  try {
    const tok = await masAdminToken(env)
    const user = await masGetUser(env, tok, username)
    if (!user) return new Response(JSON.stringify({ status: 'unknown' }), { headers })
    if (user.attributes.locked_at)
      return new Response(JSON.stringify({ status: 'locked' }), { headers })
    if (await activeSubscriptionFor(env, username))
      return new Response(JSON.stringify({ status: 'active' }), { headers })
    const ageDays = (Date.now() - Date.parse(user.attributes.created_at)) / 86_400_000
    const daysLeft = Math.max(0, Math.ceil(parseInt(env.TRIAL_DAYS, 10) - ageDays))
    return new Response(JSON.stringify({ status: 'trial', days_left: daysLeft }), { headers })
  } catch (err) {
    console.error('status error:', err)
    return new Response(JSON.stringify({ status: 'unknown' }), { headers })
  }
}

// ── Manage / cancel subscription (issue row_1782751521723) ───────────────────

const corsHeaders = (env: Env) => ({
  'Access-Control-Allow-Origin': env.APP_URL,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
})

/**
 * Return a Stripe billing-portal URL (manage payment methods, invoices, and
 * CANCEL) for the authenticated user. Identity is proven by a Matrix OpenID
 * token — `{ access_token, matrix_server_name }`, verified against the
 * homeserver's federation openid userinfo — NOT by a guessable username, since
 * this exposes PII and cancellation. Account-level, so it works while the app's
 * E2E is locked (the whole point: a locked-out user must still be able to cancel).
 */
/** JSON responder bound to this Worker's CORS headers. */
const jsonWith = (env: Env) => (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
  })

/**
 * Establish WHO is calling, from a Matrix OpenID token.
 *
 * The token is minted by the user's own client and verified against the
 * homeserver's federation userinfo endpoint, so it proves identity without the
 * caller ever handing us an access token — and it keeps working while the app's
 * E2E is locked, which is the point: a locked-out user must still be able to
 * cancel or delete.
 *
 * Returns the localpart, or a Response to return as-is.
 */
async function authenticate(env: Env, req: Request): Promise<string | Response> {
  const json = jsonWith(env)
  let body: { access_token?: string; matrix_server_name?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json(400, { error: 'bad_request' })
  }
  // Pin the server name — never verify against an attacker-supplied host (SSRF).
  if (!body.access_token || body.matrix_server_name !== env.MATRIX_SERVER_NAME) {
    return json(401, { error: 'invalid_token' })
  }

  const info = await fetch(
    `${env.HOMESERVER_URL}/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(body.access_token)}`,
  )
  if (!info.ok) return json(401, { error: 'verification_failed' })
  const sub = ((await info.json()) as { sub?: string }).sub
  const username = sub?.replace(/^@/, '').split(':')[0]
  if (!username) return json(401, { error: 'verification_failed' })
  return username
}

async function portal(env: Env, req: Request): Promise<Response> {
  const json = jsonWith(env)
  const who = await authenticate(env, req)
  if (typeof who !== 'string') return who
  const username = who

  // Find the Stripe customer behind this user's subscription (any status, so a
  // lapsed/cancelled one can still be managed).
  const stripe = stripeClient(env)
  const found = await stripe.subscriptions.search({
    query: `metadata['tidework_username']:'${username.replace(/'/g, '')}'`,
    limit: 1,
  })
  const customer = found.data[0]?.customer
  if (!customer) return json(404, { error: 'no_subscription' })
  const customerId = typeof customer === 'string' ? customer : customer.id

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: env.APP_URL,
  })
  return json(200, { url: session.url })
}

/**
 * Delete the caller's own account: cancel billing, then deactivate + erase.
 *
 * This lives in the Worker rather than the app because **both halves have to
 * happen together**. Deactivating the MAS account from the client would leave a
 * live Stripe subscription billing a user who no longer has an account — the
 * app has no Stripe credentials to cancel with, and the sweep would never
 * notice, because the sweep only ever locks.
 *
 * Order matters: cancel first. A failed cancel aborts before anything
 * irreversible happens; a failed deactivate after a successful cancel leaves
 * the user with an account and no subscription, which is recoverable and which
 * the error tells them about.
 *
 * Irreversible, by request of the person making it. Identity comes from a
 * Matrix OpenID token (see `authenticate`), so it works while E2E is locked and
 * cannot be triggered by knowing a username.
 */
async function deleteAccount(env: Env, req: Request): Promise<Response> {
  const json = jsonWith(env)
  const who = await authenticate(env, req)
  if (typeof who !== 'string') return who
  const username = who

  const stripe = stripeClient(env)
  // Cancel EVERY subscription, not just the first: a resubscribe can leave more
  // than one on the account, and leaving one live would keep charging.
  let cancelled = 0
  try {
    const found = await stripe.subscriptions.search({
      query: `metadata['tidework_username']:'${username.replace(/'/g, '')}'`,
      limit: 100,
    })
    for (const sub of found.data) {
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') continue
      await stripe.subscriptions.cancel(sub.id)
      cancelled++
    }
  } catch (err) {
    console.error(`delete-account: cancel failed for '${username}':`, err)
    return json(502, { error: 'cancel_failed' })
  }

  let unlinked = 0
  try {
    const tok = await masAdminToken(env)
    const user = await masGetUser(env, tok, username)
    if (!user) return json(404, { error: 'no_account' })
    // Free the upstream identities BEFORE deactivating. Afterwards is also
    // fine mechanically, but doing it first means a failure here aborts while
    // the account still works, rather than leaving a deleted account whose
    // Google login is burned — the worse of the two half-finished states.
    unlinked = await masUnlinkUpstream(env, tok, user.id)
    if (!user.attributes.deactivated_at) {
      await masDeactivateById(env, tok, user.id)
    }
  } catch (err) {
    console.error(`delete-account: deactivate failed for '${username}':`, err)
    // The subscription IS cancelled at this point — say so, so the user knows
    // they are not still being billed while they retry.
    return json(502, { error: 'deactivate_failed', subscriptions_cancelled: cancelled })
  }

  console.log(
    `delete-account: deleted '${username}' ` +
      `(${cancelled} subscription(s) cancelled, ${unlinked} identity link(s) freed)`,
  )
  return json(200, { deleted: true, subscriptions_cancelled: cancelled, identities_unlinked: unlinked })
}

async function webhook(env: Env, req: Request): Promise<Response> {
  const stripe = stripeClient(env)
  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('No signature', { status: 400 })

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      sig,
      env.STRIPE_WEBHOOK_SIGNING_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  } catch {
    return new Response('Bad signature', { status: 400 })
  }

  if (
    event.type === 'customer.subscription.deleted' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.created'
  ) {
    const sub = event.data.object as Stripe.Subscription
    const username = sub.metadata?.tidework_username
    if (username) {
      const inGoodStanding = sub.status === 'active' || sub.status === 'trialing'
      const deleted = event.type === 'customer.subscription.deleted'
      const tok = await masAdminToken(env)
      const user = await masGetUser(env, tok, username)
      if (user) {
        const shouldLock = deleted || !inGoodStanding
        if (shouldLock !== !!user.attributes.locked_at) {
          await masSetLockById(env, tok, user.id, shouldLock)
          console.log(`webhook: ${username} → ${shouldLock ? 'locked' : 'unlocked'}`)
        }
      } else {
        console.warn(`webhook: no MAS user '${username}'`)
      }
    }
  }
  return new Response('ok')
}

// ── The sweep: lock unpaid accounts, then delete never-paid ones ─────────────

/** A knob that must survive a missing/garbled var without locking everyone early. */
function days(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

interface SweepOverrides {
  trialDays?: number
  graceDays?: number
  deleteAfterDays?: number
  deleteMode?: string
}

async function sweep(env: Env, o: SweepOverrides = {}): Promise<string> {
  const exempt = new Set(
    env.EXEMPT_USERNAMES.split(',').map((u) => u.trim()).filter(Boolean),
  )
  const trialDays = o.trialDays ?? days(env.TRIAL_DAYS, 14)
  const graceDays = o.graceDays ?? days(env.GRACE_DAYS, 0)
  // Grace buys back the ambiguity at the boundary: a card that failed once and
  // retries, a renewal in flight, a timezone's worth of drift on `created_at`.
  const lockAfterMs = (trialDays + graceDays) * 86_400_000
  // 0 = deletion disabled. Deliberately NOT defaulted to something non-zero:
  // an unset or garbled var must never start deleting accounts.
  const deleteAfterDays = o.deleteAfterDays ?? days(env.DELETE_AFTER_DAYS, 0)
  const applyDeletes = (o.deleteMode ?? env.DELETE_MODE) === 'apply'
  const deleteAfterMs = (trialDays + graceDays + deleteAfterDays) * 86_400_000

  const tok = await masAdminToken(env)
  const users = await masListUsers(env, tok)

  const summary = (locked: number, deleted: number, wouldDelete: number) => {
    const del = !deleteAfterDays
      ? 'deletion off'
      : applyDeletes
        ? `${deleted} deleted after ${deleteAfterDays}d`
        : `${wouldDelete} deletable after ${deleteAfterDays}d (report only)`
    return (
      `sweep complete: ${users.length} users, ${locked} locked ` +
      `(trial ${trialDays}d + grace ${graceDays}d), ${del}`
    )
  }

  const overdue = users.filter((u) => {
    const a = u.attributes
    if (a.admin || a.locked_at || exempt.has(a.username)) return false
    return Date.now() - Date.parse(a.created_at) >= lockAfterMs
  })

  // Candidates for deletion: locked, long past the deadline, still around.
  // `everPaid` is checked below — that needs Stripe.
  const deletable =
    deleteAfterDays > 0
      ? users.filter((u) => {
          const a = u.attributes
          if (a.admin || exempt.has(a.username)) return false
          if (!a.locked_at || a.deactivated_at) return false
          return Date.now() - Date.parse(a.created_at) >= deleteAfterMs
        })
      : []

  if (overdue.length === 0 && deletable.length === 0) return summary(0, 0, 0)

  // Read Stripe LAST — after the MAS token mint and the (paginated) user
  // listing, immediately before any lock or delete. Those round-trips are the
  // window in which a payment can land, and locking a paying customer is the
  // expensive mistake here. Anything that still slips through self-heals: the
  // subscription webhook and /success both unlock within seconds.
  const { paying, everPaid, complete } = await subscriptionIndex(env)

  let locked = 0
  for (const u of overdue) {
    if (paying.has(u.attributes.username)) continue
    await masSetLockById(env, tok, u.id, true)
    console.log(`sweep: locked '${u.attributes.username}' (trial expired, no subscription)`)
    locked++
  }

  // Deletion is the ONE exception to lock-never-deactivate (ADR 0002), and it
  // only applies to accounts that NEVER paid — `everPaid`, not `paying`. A
  // lapsed customer stays locked forever: they have data they paid for, and
  // paying again must bring it all back.
  let deleted = 0
  let wouldDelete = 0
  if (deletable.length > 0 && !complete) {
    // Fail closed. A truncated index makes a real customer look like they never
    // paid, and the erase that follows cannot be undone. Locking already
    // happened above and is safe — it self-heals via the webhook.
    console.error('sweep: subscription index incomplete — skipping deletion this run')
    return summary(locked, 0, 0)
  }
  for (const u of deletable) {
    const name = u.attributes.username
    if (everPaid.has(name)) continue
    if (!applyDeletes) {
      console.log(`sweep: WOULD DELETE '${name}' (never paid, locked, past ${deleteAfterDays}d)`)
      wouldDelete++
      continue
    }
    await masDeactivateById(env, tok, u.id)
    console.log(`sweep: DELETED '${name}' (never paid, locked, past ${deleteAfterDays}d)`)
    deleted++
  }

  return summary(locked, deleted, wouldDelete)
}

// ── The post-payment page ────────────────────────────────────────────────────

function successPage(env: Env, username: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Welcome aboard — TideWork</title>
<style>
  :root { --abyss:#03101c; --foam:#eaf6f6; --mist:#9fc3cd; --spray:#67e2d4; --buoy:#ff9e57; --line:rgba(154,203,212,0.16); }
  * { margin:0; box-sizing:border-box; }
  body { font-family:'IBM Plex Sans', system-ui, sans-serif; color:var(--mist);
    background: radial-gradient(120% 80% at 70% -20%, #11597d 0%, transparent 55%), var(--abyss);
    min-height:100vh; display:grid; place-items:center; padding:24px; line-height:1.6; }
  .card { max-width:520px; border:1px solid var(--line); border-radius:16px; padding:40px 36px; background:rgba(4,22,35,0.7); }
  h1 { font-family: Georgia, serif; font-size:30px; color:var(--foam); }
  p { margin-top:14px; font-size:15px; }
  b { color:var(--foam); }
  a.btn { display:inline-block; margin-top:26px; background:var(--buoy); color:var(--abyss);
    text-decoration:none; font-weight:600; padding:12px 24px; border-radius:9px; }
  .fine { margin-top:18px; font-size:12.5px; color:#5c8292; }
</style></head><body>
<div class="card">
  <h1>Welcome aboard. &#127754;</h1>
  <p>Your subscription is active — <b>${esc(username)}</b> is yours for as long
  as the tide keeps coming in. Nothing else to do: just keep working.</p>
  <a class="btn" href="${env.APP_URL}">Open TideWork</a>
  <p class="fine">Remember: your data is end-to-end encrypted and your recovery key is
  the only way back into history on a new device. We can't read or recover it — by design.</p>
</div>
</body></html>`
}

// ── Entry ────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (req.method === 'GET' && url.pathname === '/subscribe') return await subscribe(env, url)
      if (req.method === 'GET' && url.pathname === '/success') return await success(env, url)
      if (req.method === 'GET' && url.pathname === '/status') return await status(env, url)
      if (req.method === 'OPTIONS' && (url.pathname === '/portal' || url.pathname === '/delete-account'))
        return new Response(null, { status: 204, headers: corsHeaders(env) })
      if (req.method === 'POST' && url.pathname === '/portal') return await portal(env, req)
      if (req.method === 'POST' && url.pathname === '/delete-account')
        return await deleteAccount(env, req)
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(env, req)
      // Manually triggerable sweep for operations/validation — guarded by the
      // billing client secret.
      if (req.method === 'POST' && url.pathname === '/__sweep') {
        const auth = req.headers.get('authorization') ?? ''
        if (auth !== `Bearer ${env.MAS_BILLING_CLIENT_SECRET}`)
          return new Response('Forbidden', { status: 403 })
        // ?trial_days= / ?grace_days= / ?delete_after_days= let operations and
        // validation simulate the deadlines without waiting out a real trial.
        // ?delete_mode=apply is required to actually delete from here, even if
        // the deployed DELETE_MODE already says apply — a manual sweep defaults
        // to reporting.
        const num = (k: string) => {
          const raw = url.searchParams.get(k)
          return raw === null ? undefined : parseInt(raw, 10)
        }
        return new Response(
          await sweep(env, {
            trialDays: num('trial_days'),
            graceDays: num('grace_days'),
            deleteAfterDays: num('delete_after_days'),
            deleteMode: url.searchParams.get('delete_mode') ?? 'report',
          }),
        )
      }
      if (url.pathname === '/') return Response.redirect(`${env.SITE_URL}/#fares`, 302)
      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error('billing error:', err)
      return new Response('Something went wrong — please contact support.', { status: 500 })
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    console.log(await sweep(env))
  },
}
