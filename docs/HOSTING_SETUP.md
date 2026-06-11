# Hosting setup — what *you* have to do

The human-action checklist for ADR 0002 phase B (and the phase D
prerequisites). Everything here needs accounts, payment details, or domain
ownership — i.e. things only you can create. Once these exist, the rest
(ansible deploy, MAS config, `.well-known` wiring, the default-homeserver
flip, the billing Worker) is engineering work that picks up from here.

Architecture being provisioned (see ADR 0002 for the full rationale):

```
app.<domain>       → Cloudflare Pages (app + demo, real CSP headers)  [proxied]
<domain>/.well-known → Cloudflare (Matrix discovery docs)             [proxied]
billing            → Cloudflare Worker (Stripe ↔ MAS admin API)
matrix.<domain>    → DO droplet: proxy → Synapse + MAS  ← managed PG  [DNS-only]
```

---

## 1. Domain

- [ ] Pick and register the brand domain at a registrar you trust.
  - You'll use `matrix.<domain>` (homeserver), `app.<domain>` (the app), and
    the apex for `.well-known` discovery. No need to decide more subdomains
    now.
  - The **server name baked into every user ID is permanent**
    (`@alice:<domain>`) — pick the domain you're willing to keep forever.
    This is the one truly irreversible choice on this list.

## 2. Cloudflare (free plan is fine to start)

- [ ] Create a Cloudflare account (with a strong password + hardware-key/TOTP
      2FA — this account will control your DNS).
- [ ] Add the domain as a zone; switch the registrar's nameservers to the
      ones Cloudflare assigns.
- [ ] Create an **API token** scoped to *this zone only* (DNS edit + Pages
      deploy). Don't use the global API key. → goes to **GitHub Actions
      secrets** later (tier 1 — see "Secrets" below).
- [ ] Nothing else yet — Pages project, Worker, and DNS records get created
      during the deploy work.

## 3. DigitalOcean

- [ ] Create a DigitalOcean account (same 2FA standard).
- [ ] Pick the **region** — this is your jurisdiction statement as much as a
      latency choice (AMS3/FRA1 for an EU posture).
- [ ] Create a **droplet**: Ubuntu LTS, 4GB RAM / 2 vCPU to start
      (~$24/mo), with your SSH public key (create a dedicated keypair for
      this; don't reuse your personal one).
- [ ] Create a **managed Postgres cluster** (smallest tier, ~$15/mo), same
      region/VPC as the droplet. Restrict its firewall to the droplet.
- [ ] Create a **scoped API token** (project-limited if you use DO projects)
      → GitHub Actions secrets later (tier 1).
- [ ] Enable droplet backups or plan snapshot cadence (the droplet holds
      Synapse media + MAS state between Postgres backups).

## 4. DNS records (in Cloudflare, once droplet exists)

- [ ] `matrix.<domain>` → A/AAAA to the droplet — **grey cloud (DNS only)**.
      This is deliberate, not an oversight: proxying the homeserver would
      hand Cloudflare every bearer token. See ADR 0002 before changing it.
- [ ] `app.<domain>` → Pages (created at deploy time) — proxied is fine.
- [ ] Apex: only needs to serve `/.well-known/matrix/*` — handled by
      Pages/redirect rules at deploy time.

## 5. Secrets — the two-tier model (ADR 0002)

**GitHub holds the keys to *deploy*; the repo + server hold the keys to *run*.**

- [ ] **Tier 1 → GitHub Actions secrets** (Settings → Secrets → Actions):
      the DO API token, the zone-scoped Cloudflare token, a wrangler token,
      and the droplet SSH deploy key. A GitHub compromise then yields deploy
      ability — bad, recoverable, auditable — not production secrets.
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
- [ ] Don't create webhooks/products yet — they need the Worker URL from the
      deploy work.

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
gated off → app's default homeserver flipped to `matrix.<domain>` (ADR 0002
phase C remainder) → Pages deploy of the app with CSP headers → billing
Worker + MAS lock/unlock wiring (phase D) → lifecycle e2e (phase E
remainder).
