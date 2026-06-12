# ADR 0002 — Hosted homeserver, MAS-first auth, and subscription enforcement

- **Status:** Proposed
- **Date:** 2026-06-11
- **Context refs:** `architecture.md` (Business Model, Authentication),
  ADR 0001 (Phase C / UIA deferral; SSSS recovery), `TODO.md` P1
  (at-rest encryption — the "no password dependence in crypto" constraint)

## Context

The business model is open-source core + paid managed hosting: we run a
homeserver, the app points at it by default (with a custom-server override),
and a sign-up/subscribe workflow ties homeserver account status to
subscription status. Today the app has no default server, registration is the
classic password flow against whatever server the user types in, and the
bridge's `register()` handles only the UIAA *dummy* stage (Conduit).

Two architectures were on the table for the signup/subscription machinery:

1. **"v1": classic auth + registration tokens.** Synapse with closed
   registration; a billing service issues MSC3231 registration tokens on
   Stripe checkout; the client implements the `m.login.registration_token`
   UIA stage; lapse enforcement via the Synapse admin API.
2. **"MAS-first": next-gen auth from the start.** Synapse + **Matrix
   Authentication Service** (MSC3861): clients authenticate via a standard
   OAuth/OIDC flow against MAS's hosted, brandable pages; the billing service
   enforces entitlement via admin APIs; third-party SSO becomes a config
   change, not a rearchitecture.

The deciding observation: the genuinely throwaway work in v1 is teaching our
custom client the registration-token UIA stage — bespoke auth plumbing that
the OAuth flow obsoletes (and the very Phase C work ADR 0001 deferred). The
work that is *not* throwaway — Synapse ops, the billing service, lock/unlock
enforcement — is identical in both architectures.

### The invariant that shapes everything: authentication ≠ entitlement

- **Authentication** ("who are you") is the only thing ever delegated —
  to MAS, and optionally upstream of MAS to Google/Apple/corporate IdPs.
  Upstream IdPs only vouch for identity; MAS still owns the local account
  and the stable user ID.
- **Entitlement** ("are you paid") lives in **our** billing service, keyed to
  the Matrix user ID, fed by Stripe webhooks, enforced by suspending/locking
  the account. It never lives at a third-party IdP, which is why "subscriptions
  tied to third-party OIDC" is a non-problem: the IdP is just a login method.

### Crypto interactions (already settled elsewhere, restated as constraints)

- Subscription state gates **service, not data**: content is E2EE, so a lapsed
  account is **locked** (devices, keys, room state preserved), never
  deactivated. Unlock on renewal restores everything — including the crypto
  identity, which survives via the per-device persistent stores.
- New-device verification must never depend on the login credential (see the
  SSSS security-phrase TODO item): under OAuth there *is* no client-side
  password, and under password auth the server sees it. The existing recovery
  key / SAS / future security-phrase paths are unaffected by the auth choice.

## Decision drivers

- Don't build auth plumbing twice; don't ship the deferred UIA work just to
  delete it.
- Keep the **custom-server override** first-class: data sovereignty and
  federation are product promises, so the app must keep working against plain
  Synapse/Conduit servers we don't run.
- Keep the Conduit-based test pyramid (Rust integration + Playwright e2e)
  working unchanged.
- Solo-operator ops budget: prefer deploy-once configuration (the
  matrix-docker-ansible-deploy playbook supports Synapse + MAS) over bespoke
  services; the billing service should stay small.
- Enterprise tier needs corporate SSO eventually — that's "IdP upstream of
  MAS," so MAS-first makes the enterprise story config, not code.

## Considered options

1. **v1 registration tokens, MAS later.** Rejected: builds the
   registration-token UIA stage in the client only to throw it away; two
   migrations (none → tokens → MAS) instead of one.
2. **MAS-first.** ← chosen.
3. **Fully custom identity backend** (own accounts DB + bridge to Matrix).
   Rejected: large, security-critical, duplicates MAS, and breaks the
   "auditable, standard Matrix" premise.
4. **Stay BYO-homeserver only (no hosted offering).** Rejected: abandons the
   business model; nothing stops a future hosted offering but nothing funds
   the product either.

## Decision

**Run Synapse + MAS as the hosted homeserver; make the app
OAuth-first against it while keeping password auth as the permanent fallback
for custom servers; enforce subscriptions via a small Stripe-webhook billing
service that locks/unlocks accounts.**

Concretely:

- **Hosted stack:** Synapse + Postgres + MAS + reverse proxy.
  *(Amended 2026-06-12: deployed via a small in-repo compose stack —
  `infra/` — rather than matrix-docker-ansible-deploy. With DO-managed
  Postgres and a single droplet, ~40 lines of compose + two config templates
  are fully auditable; the playbook earns its complexity at fleet scale.
  MAS lives at `auth.tidework.io` — its issuer URL is baked into every OAuth
  session, so it gets a dedicated stable hostname.)* Registration closed except through the
  subscribe flow. Federation **on** (subscription gating applies only to
  accounts on our server; federated collaborators and self-hosters are
  unaffected).
- **Name + domain (decided 2026-06-11): the hosted offering is "TideWork"
  at `tidework.io`** — homeserver `matrix.tidework.io` (so user IDs are
  `@user:tidework.io`, permanent), app at `app.tidework.io`. Wire identifiers
  renamed to `io.tidework.*` (`io.tidework.workspace`,
  `io.tidework.cell.update`) while only throwaway dev servers exist — the
  last free moment to do so. The sign-in default flips to the official
  server via `VITE_DEFAULT_HOMESERVER` once phase B is live (see
  `ui/src/branding.ts`).
- **Hosting (decided 2026-06-11): DigitalOcean + Cloudflare, split by
  statefulness.**
  - *Cloudflare* serves the edge/static half: the app + demo mode on
    Cloudflare Pages (upgrade over GitHub Pages — real **CSP headers** via
    `_headers`, which Pages-on-GitHub cannot set), DNS, the
    `.well-known/matrix/*` discovery documents, and the **billing service as
    a Worker** (Stripe webhook → MAS admin API; keeps the one non-open-core
    component serverless and tiny).
  - *DigitalOcean* runs the stateful half: a droplet for Synapse + MAS behind
    our own reverse proxy (~4GB to start), with **managed Postgres** so the
    component holding MAS accounts and Synapse state has backups/failover we
    don't operate. Region choice doubles as the jurisdiction statement
    (AMS/FRA for an EU posture).
  - **The homeserver stays DNS-only (grey-cloud) — deliberately.** Proxying
    `matrix.*` through Cloudflare would terminate TLS at a third party that
    then sees every bearer token (impersonation-capable) and all the traffic
    metadata the single-room design exists to minimize. E2EE content would
    stay ciphertext, but "we minimized who can see what" doesn't survive an
    interposed TLS terminator. The orange cloud is for the static app, where
    there is nothing sensitive to see; MAS's hosted pages live on the droplet
    side so the auth flow's sensitive leg also stays off the proxy. Revisit
    only under real DDoS pressure, eyes open.
- **Secrets, two tiers (recorded 2026-06-11): GitHub holds the keys to
  *deploy*; the repo + server hold the keys to *run*.**
  - *Tier 1 — deploy credentials → GitHub Actions secrets:* the scoped
    DigitalOcean API token, zone-scoped Cloudflare token, wrangler token for
    Pages/Worker deploys, and the droplet's SSH deploy key. Least-privilege
    scoping is the point — zone-/project-limited tokens, never account-wide.
  - *Tier 2 — runtime/application secrets → never plaintext in GitHub:* the
    MAS↔Synapse shared secrets (`admin_token`, the Synapse OAuth client
    secret), MAS's encryption secret + signing keys, the Postgres password,
    and the Stripe API/webhook signing secrets. These live **encrypted in the
    repo** (sops/age — sops-nix if the droplet runs NixOS), decryptable only
    by the server's host key and a personal key. CI pushes config but never
    sees plaintext; rotation history comes free as ciphertext in git.
  - *Why the split:* a compromised GitHub account must yield deploy ability
    (bad, recoverable, auditable) — not the homeserver's crypto-adjacent
    material. For a security-positioned product, "GitHub compromise = full
    production compromise" is the wrong blast radius.
  - *Pragmatic exception:* the billing Worker's Stripe webhook signing secret
    flows as `wrangler secret put` from a GitHub secret — Cloudflare is that
    component's runtime anyway.
- **Client auth = capability-detected, two branches:**
  - Homeserver advertises next-gen auth (`.well-known` / auth metadata) →
    OAuth flow via matrix-sdk's OAuth API against MAS's hosted pages
    (signup with email verification, login, password reset, session
    management — none of it hand-rolled).
  - Otherwise → the existing `m.login.password` path, unchanged. This branch
    is **permanent** (custom-server override + the Conduit test harness), not
    legacy debt.
- **Default homeserver** baked into the sign-in page (ours), with the existing
  "Custom server" override kept; `.well-known` discovery so the brand domain
  resolves to the homeserver.
- **Signup/subscribe flow:** checkout-first — Stripe Checkout → success
  webhook → billing service authorizes account creation (MAS's policy engine
  gates registration on a checkout-issued credential) → user lands in the
  normal first-device crypto onboarding (recovery key bootstrap), which is
  unchanged.
- **Demo mode feeds the funnel, fully client-side.** The codebase already
  ships a local-only WASM bridge (`WasmWorkspace` in `bridge.rs`) alongside
  the Matrix-backed one, and the UI views tolerate non-Matrix workspaces. A
  `/demo` route instantiates it with seeded example data — no registration,
  no crypto onboarding, no homeserver round-trips — so the try-before-you-buy
  surface is static CDN assets that survive any traffic spike; the homeserver
  only ever sees paying converts, with checkout as the inherent rate limiter.
  **Conversion falls out of "everything is tables":** workspace state is just
  a stream of `CellUpdate`s, so "keep this workspace" on subscribe = create
  the real encrypted room and replay the demo workspace's updates through
  `ConnectedWorkspace`. Users keep what they just built — the strongest
  moment in the funnel.
- **Entitlement enforcement:** billing service consumes Stripe webhooks and
  drives MAS/Synapse admin APIs — **lock on lapse, unlock on renewal, never
  deactivate**. Grace period and an export affordance for lapsed accounts are
  policy knobs to set before launch (see open questions).
- **Third-party SSO (consumer) and corporate IdPs (enterprise)** are upstream
  MAS providers added by configuration later; no client or billing changes.
- **The billing service is the one non-open-core component** (small: webhook
  handler + admin-API client + a table keyed by MXID).

## Consequences

**Positive**

- One auth migration instead of two; the deferred UIA work stays deferred
  forever.
- Email verification, password reset, and session management come from MAS
  instead of bespoke client code.
- Enterprise SSO and consumer social login become configuration.
- Entitlement model is uniform across all auth methods (lock/unlock by MXID).
- The locked-not-deactivated policy turns E2EE into a sales asset: "lapse and
  we still can't read your data; renew and everything is exactly as you left
  it."

**Negative / costs**

- Ops surface day one: Synapse + Postgres + MAS + proxy + billing service
  (vs. Synapse alone). Mitigated by the ansible playbook; still real.
- The client gains a second auth flow (OAuth redirect + token lifecycle)
  threading through `useAuth` — already the most complex file in the UI.
- Auth-flow e2e coverage needs a Synapse+MAS throwaway stack eventually;
  heavier than the single-binary Conduit harness (which stays for everything
  else).

**Risks / open questions**

- **WASM OAuth spike is the gating step:** matrix-sdk 0.14 has the OAuth API,
  but redirect handling + session restore from our WASM bridge in a browser
  must be proven before sequencing the rest. Escape hatch if it's rough: MAS's
  legacy-compatibility layer serves password `/login`, so the hosted stack and
  billing machinery can ship while the client temporarily keeps password auth.
- MAS registration-policy mechanics (gating signup on a checkout credential)
  need a concrete design pass — policy engine vs. provisioning via admin API.
- Policy knobs to decide before launch: trial/free tier, grace-period length,
  lapsed-account export window, hosting jurisdiction/provider.
- **Demo-mode scope:** a local-only demo shows the product surface (tables,
  views, kanban) but not the differentiators (real-time collaboration,
  multi-device sync, real E2EE). Decide whether that's acceptable or whether
  a client-side *simulated* collaborator making edits is worth the flavor.
- **Scale-out is workers, not federation.** If onboarding spikes ever strain
  the homeserver, the answer is Synapse **workers** (sync workers, event
  persisters, federation senders over a tuned Postgres) scaling one logical
  homeserver — *not* sharding users across homeserver names. Server names are
  baked into MXIDs forever, so shard assignment would become irreversible
  identity. Federation is for cross-server collaboration, not load balancing.
  Elasticity is asymmetric: **generic workers** (client API, `/sync`,
  federation reads — i.e. spike-shaped onboarding load) scale up gracefully
  behind the proxy with no homeserver restart, while **sharded writer roles**
  (event persisters, federation senders) have their shard map in the shared
  config every process reads — re-sharding means a config change + process
  restarts, so write throughput is provisioned ahead, not autoscaled. The hard
  ceiling is Postgres (single writer; scales vertically + pooling). Re-verify
  against current Synapse worker docs at phase B — role elasticity has shifted
  across versions.
- matrix-sdk OAuth API stability across SDK upgrades (next-gen auth is still
  stabilizing ecosystem-wide).

## Implementation plan (phased)

- **A. Spike — OAuth login from the WASM client** against a throwaway
  Synapse+MAS. Proves the gating risk; output is either "proceed" or "ship
  hosted stack on the MAS compat layer first." *(Do this before any infra
  spend.)*
  **Done 2026-06-11 — verdict: proceed.** The full flow runs from the real
  compiled WASM against Synapse 1.148 + MAS 1.12 (`ui/e2e/oauth.spec.ts`,
  driven by `scripts/spike-synapse-mas.sh --e2e`): dynamic client
  registration → MAS hosted login → consent → code exchange →
  `kind:"oauth"` session blob → restore. Findings that bind later phases:
  - matrix-sdk 0.14's OAuth API works on wasm32 **unmodified** — no SDK
    patching needed.
  - The **popup architecture is load-bearing**, not a preference: the PKCE
    verifier lives in the in-memory client, so `finishOauthLogin` must run in
    the page that called `startOauthLogin` — a full-page redirect destroys
    the WASM instance mid-flow. (Bridge: `MatrixSession.startOauthLogin` /
    `finishOauthLogin`; pending client parked in a thread-local.)
  - The session blob now carries a `kind` discriminator ("password"/"oauth");
    `restore()` rebuilds either variant. OAuth blobs add `refreshToken` +
    `clientId` (needed to restore the dynamically-registered client).
  - MAS's registration policy requires **https** client/redirect URIs:
    dev/test stacks need `policy.data.client_registration.allow_insecure_uris`
    (the spike script sets it); production just needs the real https origin.
  - The throwaway stack is Conduit-idiom (no docker): nix-provided Synapse
    (with the `oidc` extra via the flake's `synapse-oidc` package), MAS, and
    a unix-socket Postgres — reusable as the phase E CI harness.
- **B. Hosted stack** — Synapse + Postgres + MAS via ansible; closed
  registration; `.well-known` on the brand domain; backups/monitoring.
  *Hosting vendors decided 2026-06-11 (see Decision): DigitalOcean droplet +
  managed Postgres for the homeserver (grey-cloud DNS), Cloudflare
  Pages/DNS/Worker for app, discovery, and billing.*
- **C. Client: default server + discovery + auth branching** — default
  homeserver with the existing custom override; detect next-gen auth and route
  to OAuth or password accordingly. Password path and Conduit harness stay
  green throughout.
- **D. Billing service + enforcement** — Stripe Checkout + webhooks; account
  provisioning/gating on checkout; lock on lapse / unlock on renewal; grace +
  export policy implemented as configuration.
- **E. Auth-flow e2e** — throwaway Synapse+MAS stack in CI (separate job from
  the Conduit harness) covering subscribe → register → onboard → lapse → lock
  → renew → unlock.
- **F. Later, by config:** consumer social login; enterprise corporate IdPs.
