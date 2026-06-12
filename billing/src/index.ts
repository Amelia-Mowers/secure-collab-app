/**
 * TideWork billing Worker — Stripe ↔ MAS (ADR 0002 phase D).
 *
 * Flow (checkout-first; registration is token-gated on MAS):
 *   GET  /subscribe  → Stripe Checkout (collects the desired username)
 *   GET  /success    → verifies payment, mints a single-use MAS registration
 *                      token (idempotent — stored on the subscription's
 *                      metadata), shows it with next steps
 *   POST /webhook    → subscription lifecycle → MAS lock/unlock by username
 *
 * Invariants (ADR 0002):
 *  - Lock, never deactivate: a lapse suspends service; E2EE data + identity
 *    survive untouched, unlock on renewal restores everything.
 *  - Stripe is the database: token + username live in subscription metadata.
 *  - This worker holds deploy-pushed secrets only; it can issue registration
 *    tokens and lock/unlock — it cannot read anyone's data (E2EE).
 */
import Stripe from 'stripe'

export interface Env {
  MAS_URL: string
  MAS_BILLING_CLIENT_ID: string
  PRICE_CENTS: string
  PRICE_CURRENCY: string
  SITE_URL: string
  APP_URL: string
  STRIPE_API_KEY: string
  STRIPE_WEBHOOK_SIGNING_SECRET: string
  MAS_BILLING_CLIENT_SECRET: string
}

const stripeClient = (env: Env) =>
  new Stripe(env.STRIPE_API_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  })

// ── MAS admin API ────────────────────────────────────────────────────────────

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
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

async function masCreateRegistrationToken(env: Env): Promise<string> {
  const tok = await masAdminToken(env)
  const res = await fetch(`${env.MAS_URL}/api/admin/v1/user-registration-tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usage_limit: 1 }),
  })
  if (!res.ok) throw new Error(`MAS registration-token create failed: ${res.status}`)
  const data = (await res.json()) as { data: { attributes: { token: string } } }
  return data.data.attributes.token
}

/** Lock or unlock a MAS user by username. Unknown user is a no-op (they may
 *  have paid but never registered) — logged, never thrown. */
async function masSetLock(env: Env, username: string, lock: boolean): Promise<void> {
  const tok = await masAdminToken(env)
  const lookup = await fetch(
    `${env.MAS_URL}/api/admin/v1/users/by-username/${encodeURIComponent(username)}`,
    { headers: { Authorization: `Bearer ${tok}` } },
  )
  if (lookup.status === 404) {
    console.warn(`lock(${lock}) skipped: no MAS user '${username}' (paid but never registered?)`)
    return
  }
  if (!lookup.ok) throw new Error(`MAS user lookup failed: ${lookup.status}`)
  const user = (await lookup.json()) as { data: { id: string } }
  const res = await fetch(
    `${env.MAS_URL}/api/admin/v1/users/${user.data.id}/${lock ? 'lock' : 'unlock'}`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok}` } },
  )
  if (!res.ok) throw new Error(`MAS ${lock ? 'lock' : 'unlock'} failed: ${res.status}`)
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function subscribe(env: Env): Promise<Response> {
  const stripe = stripeClient(env)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: env.PRICE_CURRENCY,
          unit_amount: parseInt(env.PRICE_CENTS, 10),
          recurring: { interval: 'month' },
          product_data: {
            name: 'TideWork Hosted',
            description: 'Account on tidework.io — managed, backed up, end-to-end encrypted.',
          },
        },
      },
    ],
    custom_fields: [
      {
        key: 'username',
        label: { type: 'custom', custom: 'Desired TideWork username' },
        type: 'text',
      },
    ],
    success_url: 'https://billing.tidework.io/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: `${env.SITE_URL}/#fares`,
  })
  return Response.redirect(session.url!, 303)
}

async function success(env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get('session_id')
  if (!sessionId) return new Response('Missing session', { status: 400 })

  const stripe = stripeClient(env)
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription'],
  })
  if (session.payment_status !== 'paid') {
    return new Response('Payment not completed', { status: 402 })
  }

  const sub = session.subscription as Stripe.Subscription
  const username =
    session.custom_fields?.find((f) => f.key === 'username')?.text?.value ?? 'your-username'

  // Idempotent: refresh-safe. The token is minted once and parked on the
  // subscription, which is also where the lapse webhooks will find the
  // username to lock.
  let regToken = sub.metadata?.tidework_reg_token
  if (!regToken) {
    regToken = await masCreateRegistrationToken(env)
    await stripe.subscriptions.update(sub.id, {
      metadata: { tidework_reg_token: regToken, tidework_username: username },
    })
  }

  return new Response(successPage(env, regToken, username), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
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
    event.type === 'customer.subscription.updated'
  ) {
    const sub = event.data.object as Stripe.Subscription
    const username = sub.metadata?.tidework_username
    if (username) {
      const inGoodStanding = sub.status === 'active' || sub.status === 'trialing'
      const deleted = event.type === 'customer.subscription.deleted'
      // Lock, never deactivate (ADR 0002) — unlock on return to good standing.
      await masSetLock(env, username, deleted || !inGoodStanding)
    }
  }
  return new Response('ok')
}

// ── The welcome-aboard page (matches the deep-water landing) ────────────────

function successPage(env: Env, regToken: string, username: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Welcome aboard — TideWork</title>
<style>
  :root { --abyss:#03101c; --foam:#eaf6f6; --mist:#9fc3cd; --faint:#5c8292;
    --spray:#67e2d4; --buoy:#ff9e57; --line:rgba(154,203,212,0.16); }
  * { margin:0; box-sizing:border-box; }
  body { font-family:'IBM Plex Sans', system-ui, sans-serif; color:var(--mist);
    background: radial-gradient(120% 80% at 70% -20%, #11597d 0%, transparent 55%), #03101c;
    min-height:100vh; display:grid; place-items:center; padding:24px; line-height:1.6; }
  .card { max-width:560px; border:1px solid var(--line); border-radius:16px; padding:40px 36px;
    background:rgba(4,22,35,0.7); }
  h1 { font-family: Georgia, serif; font-size:30px; color:var(--foam); letter-spacing:-0.01em; }
  p { margin-top:12px; font-size:15px; }
  b { color:var(--foam); }
  .token { margin:22px 0; padding:16px 18px; border:1px dashed var(--spray); border-radius:10px;
    font-family:ui-monospace, monospace; font-size:15px; color:var(--spray); word-break:break-all;
    user-select:all; background:rgba(103,226,212,0.06); }
  ol { margin:16px 0 0 18px; font-size:15px; }
  li { margin:8px 0; }
  a.btn { display:inline-block; margin-top:24px; background:var(--buoy); color:var(--abyss);
    text-decoration:none; font-weight:600; padding:12px 24px; border-radius:9px; }
  .fine { margin-top:18px; font-size:12.5px; color:var(--faint); }
</style></head><body>
<div class="card">
  <h1>Welcome aboard. &#127754;</h1>
  <p>Your subscription is active. One last step — your <b>registration token</b>
  (single-use; treat it like a ticket, not a secret to keep):</p>
  <div class="token">${esc(regToken)}</div>
  <ol>
    <li>Open <b>TideWork</b> and choose <b>Create account</b> — or register directly at auth.tidework.io.</li>
    <li>Use the username you chose at checkout: <b>${esc(username)}</b>.</li>
    <li>Enter the token above when asked, pick a strong password, and you're in.</li>
  </ol>
  <a class="btn" href="${env.APP_URL}">Open TideWork</a>
  <p class="fine">Lose this page? Re-open it from your Stripe receipt link — the token is
  remembered. Once you register, save your recovery key: we can't read or recover
  your data, by design.</p>
</div>
</body></html>`
}

// ── Entry ────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (req.method === 'GET' && url.pathname === '/subscribe') return await subscribe(env)
      if (req.method === 'GET' && url.pathname === '/success') return await success(env, url)
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(env, req)
      if (url.pathname === '/') return Response.redirect(`${env.SITE_URL}/#fares`, 302)
      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error('billing error:', err)
      return new Response('Something went wrong — please contact support.', { status: 500 })
    }
  },
}
