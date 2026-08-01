# TideWork hosted infrastructure

The deploy configuration for the hosted homeserver (ADR 0002 phase B):
Synapse + MAS in compose on a DigitalOcean droplet, against DO **managed
Postgres**, behind host nginx with certbot TLS. The app + demo stay on
CDN/static hosting; the billing Worker (phase D) lives on Cloudflare.

```
                   ┌─ /sync,/events,/messages,… ─→ synapse-sync1/2  (reads / collab)
matrix.tidework.io ─ nginx:443 ┤
                   └─ everything else ──────────→ synapse  (main: client + federation)
auth.tidework.io   ─ nginx:443 ─────────────────→ mas      (OIDC issuer / pages)
                        main ── events stream ──→ synapse-persister1  (write persistence)
                        all processes ↔ replicate via redis (compose-internal)
                                  └──→ DO managed Postgres (synapse, mas DBs)
```

**Why compose and not matrix-docker-ansible-deploy** (deviation from ADR
0002's initial suggestion, recorded there): with an externally managed
Postgres and a single droplet, a ~40-line compose file plus two config
templates is fully auditable and has no opinionated machinery to fight; the
playbook earns its complexity at fleet scale, which this isn't yet.

## Scaling: Synapse workers

The load test (`ui/e2e/LOADTEST.md`) found the monolith is single-process and
single-threaded — capped at ~1.2 of 2 cores, leaving the rest idle. Synapse
workers shard work off `main` along two axes:

- **Reads / collab fan-out** → **`synapse-sync1` / `synapse-sync2`**
  (`generic_worker`s). nginx routes `/sync`, `/events`, `/messages`, … to them
  (sticky per access token); everything else goes to `main`. *Measured:* routing
  `/sync` to the workers cut 25-editor collab p95 propagation 6.0s → 1.6s on the
  2-vCPU box (combined Synapse CPU 120% → 164–188%) — they use the idle core.
- **Writes** → **`synapse-persister1`**, an event-persister stream writer that
  owns the `events` stream (`stream_writers.events`). Lifts event persistence
  off `main`. One *room* is still single-writer (event ordering), but *aggregate*
  writes shard across persisters by room.

Redis is the replication backbone (compose-internal). Config: `synapse/workers/`
`*.yaml` (+ `log.config`), the `redis`/`instance_map`/`stream_writers` block in
`synapse/homeserver.yaml.tmpl`, and the `upstream`/`location` routing in
`nginx/matrix.conf`.

**Scaling ≈ a bigger machine + a config nudge.** All the roles are wired now, so
growth is: resize the droplet to more vCPU, then add `synapse-syncN` /
`synapse-persisterN` copies — each is a `workers/*.yaml`, a compose service, and
one `instance_map`/`stream_writers` or nginx `upstream` line — to put the new
cores to work. On 2 vCPU the extra processes just contend; the win needs cores.

**Postgres scales separately.** Each Synapse process opens its own pool, all
sharing the managed cluster's `max_connections` (smallest tier = **25**).
`homeserver.yaml.tmpl` keeps `cp_max` small so main + 2 sync + 1 persister + MAS
fit; more workers or real load needs a bigger PG plan or a PgBouncer pooler — a
hard limit to check first (`SHOW max_connections;`, `pg_stat_activity`).

### Scale-up runbook

When the homeserver needs more capacity, do these **in order**. The worker
*roles* are already wired (above), so scaling is resize + config nudge, not
surgery.

1. **Resize the droplet** (DO console / `doctl`): power off → resize **CPU/RAM
   only** (reversible) → power on (~1–2 min downtime). The prerequisite — on
   2 vCPU the worker processes just contend; they need cores. Rule of thumb:
   ~1 core per active Synapse process (main + each sync/persister worker).

2. **Bump the Postgres plan _before_ adding workers.** The managed cluster's
   `max_connections` (smallest tier = **25**) is the binding limit on worker
   count, *not* cores — every Synapse process opens a `cp_max` pool, all sharing
   it with MAS. Larger DO PG tiers raise the cap. Check head-room:
   `SHOW max_connections;` and
   `SELECT datname,count(*) FROM pg_stat_activity GROUP BY 1;`.

3. **Raise the pool sizes** once PG has room: `cp_min`/`cp_max` in
   `synapse/homeserver.yaml.tmpl` (now 1/2 — a validation-tier floor) and
   `max_connections` in `mas/config.yaml.tmpl` (now 5). Keep
   `Σ(Synapse cp_max) + MAS max_connections + ~5 admin/overhead ≤ max_connections`.

4. **Add workers to use the new cores:**
   - More **reads/collab** → copy `synapse-sync2` → `sync3`: a
     `workers/syncN.yaml` (fresh port), a compose service publishing it, and a
     `server 127.0.0.1:<port>;` line in nginx's `synapse_sync` upstream.
   - More **write** throughput → copy `persister1` → `persister2`: a
     `workers/persisterN.yaml` (fresh replication port), a compose service, an
     `instance_map` entry, and add it to `stream_writers.events` (events shard
     across the list by room).
   - Other hot streams (typing, receipts, to_device, account_data, presence) →
     move each to its own stream-writer worker the same way.

5. **Deploy + verify:** `infra/deploy.ps1`, then *eyeball* `docker compose ps`
   — every container healthy, new workers connected to redis + replicating,
   connections fit (`pg_stat_activity`). Re-run `ui/e2e/loadtest-collab-nginx.sh`
   for the before/after.

> Deploy gotcha: `deploy.ps1` prints "DEPLOYED" even if `remote-setup.sh` aborts
> (e.g. PG out of connection slots) — always check `docker compose ps` after.

## Deploying

```sh
bash infra/deploy.sh root@142.93.86.143
```

Pushes the bundle + **encrypted** secrets and runs `remote-setup.sh` on the
droplet. Idempotent: one-time work (signing key, MAS secrets, databases,
certs) is guarded; re-runs just re-render configs and restart.

## Secrets (the two-tier model — ADR 0002)

- `infra/secrets/postgres.env` — plaintext, **gitignored**, exists only on
  the workstation that authored it.
- `infra/secrets/postgres.sops.env` — committed ciphertext. Recipients (see
  `.sops.yaml`): Amelia's personal age key + the droplet's SSH host key
  (`ssh-to-age`). **Decryption happens on the droplet**; CI and the repo
  never hold plaintext.
- MAS↔Synapse shared secrets and MAS's signing/encryption keys are
  *generated on the droplet at first deploy* (`/srv/tidework/secrets/`,
  `/srv/tidework/mas/secrets.yaml`) and never leave it. Persistence story:
  droplet backups. Re-encrypting them into the repo (so a rebuilt droplet
  keeps its identity) is a tracked follow-up.

### Email keys: transactional vs alerting

`infra/secrets/email.sops.env` carries two Resend keys, deliberately separate:

| var | used by | blast radius if leaked |
|---|---|---|
| `SMTP_PASSWORD` | MAS transactional email — verification codes, password resets | account email |
| `ALERT_RESEND_KEY` | `healthcheck.sh` outage alerts | monitoring only |

They were one key, on the reasoning that there was then no second secret to
manage. The cost of that showed up on 2026-07-21: a single leak took out both
account email *and* the channel that would have told you about the outage, and
rotating it meant touching password-reset delivery to fix monitoring.

`remote-setup.sh` prefers `ALERT_RESEND_KEY` and **falls back to
`SMTP_PASSWORD` with a warning** if it is absent — silently disabling alerts
would be the worst possible outcome of a monitoring change. To provision it:

```sh
# 1. Resend dashboard → API Keys → Create, "tidework-alerts", permission:
#    Sending access only. Do NOT reuse the transactional key.
# 2. Add it to the encrypted env (opens $EDITOR on the decrypted file):
sops infra/secrets/email.sops.env      # add: ALERT_RESEND_KEY=re_...
# 3. Deploy; the warning above disappears when it takes effect.
pwsh infra/deploy.ps1
```

Until step 2 is done, alerting keeps working on the shared key.

## Operating notes

- Synapse config: `/srv/tidework/synapse/homeserver.yaml` (rendered — edit
  the template here in the repo, then redeploy).
- `server_name` is `tidework.io` (user IDs are permanent); clients connect to
  `matrix.tidework.io` — apex `.well-known` delegation is part of the
  Cloudflare setup, not this box.
- Registration is closed (`password_registration_enabled: false`); create
  operator/test accounts on the droplet with:
  `docker compose -f /srv/tidework/docker-compose.yml exec mas mas-cli manage register-user ...`
- Logs: `docker compose -f /srv/tidework/docker-compose.yml logs -f synapse mas`
- TLS renewal is certbot's systemd timer (already installed by the apt
  package); no Cloudflare credential exists on this machine by design.
