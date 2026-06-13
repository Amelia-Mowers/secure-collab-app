/**
 * TideWork billing Worker — Stripe ↔ MAS (ADR 0002 phase D, trial-first).
 *
 * Registration is OPEN with a TRIAL_DAYS trial; this worker enforces the
 * commercial boundary:
 *   GET  /subscribe?username=  → Stripe Checkout, keyed to the account
 *   GET  /success              → confirmation page (no tokens — the account
 *                                already exists; payment just unlocks/keeps it)
 *   GET  /status?username=     → coarse {status, days_left} for the app badge
 *   POST /webhook              → lock on lapse/unpaid, unlock on active
 *   cron (and guarded /__sweep)→ lock unpaid accounts past the trial
 *
 * Invariants (ADR 0002):
 *  - Lock, never deactivate — except never-paid accounts long past trial,
 *    where there is nothing of value to preserve (deletion: tracked TODO).
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
  EXEMPT_USERNAMES: string
  SITE_URL: string
  APP_URL: string
  STRIPE_API_KEY: string
  STRIPE_WEBHOOK_SIGNING_SECRET: string
  MAS_BILLING_CLIENT_SECRET: string
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

// ── Stripe helpers ───────────────────────────────────────────────────────────

async function activeSubscriptionFor(env: Env, username: string): Promise<boolean> {
  const stripe = stripeClient(env)
  const found = await stripe.subscriptions.search({
    query: `metadata['tidework_username']:'${username.replace(/'/g, '')}' AND status:'active'`,
    limit: 1,
  })
  return found.data.length > 0
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

// ── The sweep: lock unpaid accounts past the trial ───────────────────────────

async function sweep(env: Env, overrideTrialDays?: number): Promise<string> {
  const exempt = new Set(
    env.EXEMPT_USERNAMES.split(',').map((u) => u.trim()).filter(Boolean),
  )
  const trialDays = overrideTrialDays ?? parseInt(env.TRIAL_DAYS, 10)
  const trialMs = trialDays * 86_400_000
  const tok = await masAdminToken(env)
  const users = await masListUsers(env, tok)
  let locked = 0
  for (const u of users) {
    const a = u.attributes
    if (a.admin || a.locked_at || exempt.has(a.username)) continue
    if (Date.now() - Date.parse(a.created_at) < trialMs) continue
    if (await activeSubscriptionFor(env, a.username)) continue
    await masSetLockById(env, tok, u.id, true)
    console.log(`sweep: locked '${a.username}' (trial expired, no subscription)`)
    locked++
  }
  return `sweep complete: ${users.length} users, ${locked} locked`
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
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(env, req)
      // Manually triggerable sweep for operations/validation — guarded by the
      // billing client secret.
      if (req.method === 'POST' && url.pathname === '/__sweep') {
        const auth = req.headers.get('authorization') ?? ''
        if (auth !== `Bearer ${env.MAS_BILLING_CLIENT_SECRET}`)
          return new Response('Forbidden', { status: 403 })
        // ?trial_days= lets operations/validation simulate the deadline.
        const override = url.searchParams.get('trial_days')
        return new Response(await sweep(env, override ? parseInt(override, 10) : undefined))
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
