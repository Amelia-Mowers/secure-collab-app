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
