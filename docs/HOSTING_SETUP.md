# Hosting setup — what *you* have to do

The human-action checklist for ADR 0002 phase B (and the phase D
prerequisites). Everything here needs accounts, payment details, or domain
ownership — i.e. things only you can create. Once these exist, the rest
(ansible deploy, MAS config, `.well-known` wiring, the default-homeserver
flip, the billing Worker) is engineering work that picks up from here.

Architecture being provisioned (see ADR 0002 for the full rationale):

```
app.tidework.io       → Cloudflare Pages (app + demo, real CSP headers)  [proxied]
tidework.io/.well-known → Cloudflare (Matrix discovery docs)             [proxied]
billing            → Cloudflare Worker (Stripe ↔ MAS admin API)
matrix.tidework.io    → DO droplet: proxy → Synapse + MAS  ← managed PG  [DNS-only]
```

---

## 1. Domain

- [x] ~~Pick and register the brand domain~~ — **done: `tidework.io`**
  (product name **TideWork**). User IDs will be `@alice:tidework.io` —
  permanent from the first real account onward. Subdomains in use:
  `matrix.tidework.io` (homeserver), `app.tidework.io` (the app), apex for
  `.well-known` discovery.

## 2. Cloudflare (free plan is fine to start)

- [x] Create a Cloudflare account (with a strong password + hardware-key/TOTP
      2FA — this account will control your DNS).
- [x] ~~Add the domain as a zone; switch nameservers~~ — **done
      automatically**: `tidework.io` was bought via **Cloudflare Registrar**,
      so the zone exists and is active (dash.cloudflare.com → tidework.io).
      Bonus: at-cost renewals, automatic WHOIS redaction; note the 60-day
      ICANN transfer-out lock from purchase.
- [x] Create the **API tokens** (My Profile → API Tokens → Custom token;
      never the Global API Key). Two, because the scopes differ — both go to
      **GitHub Actions secrets** later (tier 1 — see "Secrets" below):
      - **`tidework-dns`** (create now): Zone→DNS→Edit + Zone→Zone→Read,
        zone resources = *specific zone: tidework.io* (Zone:Read is needed by
        tooling to resolve the zone ID).
      - **`tidework-deploy`** (when the Pages/Worker deploys are built):
        Account→Cloudflare Pages→Edit; add Account→Workers Scripts→Edit at
        phase D, and Zone→Workers Routes→Edit (tidework.io) only if the
        billing Worker gets a zone route. Pages/Workers permissions are
        account-scoped by Cloudflare's model — which is exactly why they
        don't share a token with DNS edit.
      - Leave off: anything "All zones", Zone Settings, billing/membership.
        Skip IP filtering (GitHub runners rotate IPs); note both tokens in
        the password manager for an annual rotation pass.
      - TLS on the droplet needs **no Cloudflare token**: matrix.tidework.io
        is grey-cloud, so plain certbot HTTP-01 works — no DNS credential
        ever lives on the server.
- [x] Nothing else yet — Pages project, Worker, and DNS records get created
      during the deploy work.

## 3. DigitalOcean

- [x] Create a DigitalOcean account (same 2FA standard).
- [x] Pick the **region** — this is your jurisdiction statement as much as a
      latency choice (AMS3/FRA1 for an EU posture).
- [x] Create a **droplet**: Ubuntu LTS, 4GB RAM / 2 vCPU to start
      (~$24/mo), with your SSH public key (create a dedicated keypair for
      this; don't reuse your personal one).
- [x] Create a **managed Postgres cluster** (smallest tier, ~$15/mo), same
      region/VPC as the droplet. Restrict its firewall to the droplet.
- [x] Create a **scoped API token** (project-limited if you use DO projects)
      → GitHub Actions secrets later (tier 1).
- [ ] Enable droplet backups or plan snapshot cadence (the droplet holds
      Synapse media + MAS state between Postgres backups).

## 4. DNS records (in Cloudflare, once droplet exists)

- [x] `matrix.tidework.io` → A/AAAA to the droplet — **grey cloud (DNS only)**.
      This is deliberate, not an oversight: proxying the homeserver would
      hand Cloudflare every bearer token. See ADR 0002 before changing it.
- [ ] `app.tidework.io` → Pages (created at deploy time) — proxied is fine.
- [ ] Apex: only needs to serve `/.well-known/matrix/*` — handled by
      Pages/redirect rules at deploy time.

## 5. Secrets — the two-tier model (ADR 0002)

**GitHub holds the keys to *deploy*; the repo + server hold the keys to *run*.**

- [ ] **Tier 1 → GitHub Actions secrets.** A GitHub compromise then yields
      deploy ability — bad, recoverable, auditable — not production secrets.
      Add each at **github.com/Amelia-Mowers/tidework → Settings →
      Secrets and variables → Actions → New repository secret**, using these
      exact IDs (CI workflows will reference them by name):

      | Secret ID | Value | Where to get it | When |
      |---|---|---|---|
      | `CLOUDFLARE_DNS_TOKEN` | the `tidework-dns` API token | dash.cloudflare.com → profile (top-right) → My Profile → **API Tokens**. Shown **once** at creation — if you didn't save it, use "Roll" to regenerate. | now |
      | `CLOUDFLARE_ACCOUNT_ID` | account id (hex) | dash.cloudflare.com → tidework.io → **Overview**, right-hand sidebar ("Account ID"). | now |
      | `CLOUDFLARE_ZONE_ID` | zone id (hex) | same Overview sidebar ("Zone ID"). | now |
      | `CLOUDFLARE_DEPLOY_TOKEN` | the `tidework-deploy` API token | My Profile → API Tokens (create per the policy above when Pages/Worker deploys are built). | Pages deploy |
      | `DIGITALOCEAN_ACCESS_TOKEN` | DO API token | cloud.digitalocean.com → **API** (left nav) → Tokens → Generate New Token. Use **custom scopes** (droplet + database read/write), not full access. Shown once. | now |
      | `DEPLOY_SSH_KEY` | the **CI deploy** private key (full file contents incl. header/footer) | generate a *second* keypair, separate from your admin key: `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\tidework_deploy -C "tidework-ci"` (no passphrase — CI can't type one); its `.pub` gets added to the droplet's authorized_keys during deploy setup. | droplet deploy |
      | `DEPLOY_KNOWN_HOSTS` | the droplet's pinned host key | `ssh-keyscan matrix.tidework.io` (or the IP) once the droplet exists — pinning beats accept-on-first-use in CI. | droplet deploy |
      | `STRIPE_API_KEY` | Stripe secret key (`sk_live_…`) | dashboard.stripe.com → **Developers → API keys**. The billing Worker's runtime secrets flow via `wrangler secret put` from these (the recorded exception — Cloudflare is that component's runtime). | phase D |
      | `STRIPE_WEBHOOK_SIGNING_SECRET` | `whsec_…` | dashboard.stripe.com → Developers → **Webhooks** → the endpoint created for the billing Worker. | phase D |

      The "now" rows are the only ones you can add today; the rest become
      addable as their sources come into existence.
- [ ] **Tier 2 → encrypted in the repo, never plaintext in GitHub**: the
      MAS↔Synapse shared secrets, MAS encryption/signing keys, Postgres
      password, Stripe secrets. Setup task for you:
      - [ ] Generate a personal **age** key (`age-keygen`) and store it in
            your password manager. The server's SSH host key becomes the
            second recipient; sops/age encrypt to both. (If the droplet ends
            up on NixOS, this is sops-nix; on Ubuntu, plain sops + a decrypt
            step in the deploy.)
- [ ] Exception by design: the billing Worker's Stripe webhook signing secret
      flows via `wrangler secret put` from a GitHub secret — Cloudflare is
      that component's runtime anyway.

## 6. Stripe (phase D — can wait until B is deployed)

- [ ] Create a Stripe account; complete the business/identity verification
      early (it can take days and blocks live mode).
- [ ] Decide the initial pricing shape (monthly/yearly, trial length, grace
      period before locking) — these become the policy knobs from ADR 0002's
      open questions.
- [ ] **Extend `CLOUDFLARE_DEPLOY_TOKEN`** (edit the existing token — the
      value stays the same): add **Account → Workers Scripts → Edit** and
      **Zone → Workers Routes → Edit (tidework.io)** — required for the
      billing Worker deploy + its custom domain.
- [x] **Webhook endpoint** _(done; live as of 2026-06-13)_: Stripe dashboard →
      Developers → Webhooks → endpoint `https://billing.tidework.io/webhook`,
      events `customer.subscription.created/updated/deleted` → `whsec_…` →
      `gh secret set STRIPE_WEBHOOK_SIGNING_SECRET`. **Per-mode:** the live
      endpoint is separate from (and replaces) the test one — they don't
      migrate, only the URL + event list carry over.
- [x] **Live mode** _(done 2026-06-13; validated in test mode first with card
      `4242 4242 4242 4242`)_: `STRIPE_API_KEY` is the `sk_live_…` key and the
      live webhook secret is set; the test-mode endpoint is disabled. The API
      key and webhook secret must flip together or the signature modes mismatch.
      No product/price setup needed — the Worker uses inline price_data
      ($12/mo, configurable in `billing/wrangler.toml`).

## 7. Things to write down in your password manager

- Registrar login, Cloudflare login + zone token, DO login + API token,
  droplet SSH private key, your age secret key, Stripe login.
- Later, from the deploy: the MAS admin credentials and the recovery key of
  any operational/test Matrix account.

## Cost picture (steady-state, before users)

| Item | ~Monthly |
|---|---|
| DO droplet (4GB) | $24 |
| DO managed Postgres | $15 |
| Cloudflare (Pages/DNS/Worker) | $0 |
| Domain | ~$1–2 amortized |
| Stripe | per-transaction only |
| **Total** | **~$40/mo** |

## What happens after you've done this

Engineering picks up (in order): ansible/NixOS deploy of Synapse+MAS against
the managed Postgres → `.well-known` discovery on the apex → registration
gated off → app's default homeserver flipped to `matrix.tidework.io` (ADR 0002
phase C remainder) → Pages deploy of the app with CSP headers → billing
Worker + MAS lock/unlock wiring (phase D) → lifecycle e2e (phase E
remainder).
