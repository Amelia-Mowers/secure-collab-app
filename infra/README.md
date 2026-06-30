# TideWork hosted infrastructure

The deploy configuration for the hosted homeserver (ADR 0002 phase B):
Synapse + MAS in compose on a DigitalOcean droplet, against DO **managed
Postgres**, behind host nginx with certbot TLS. The app + demo stay on
CDN/static hosting; the billing Worker (phase D) lives on Cloudflare.

```
                   ┌─ /sync,/events,/messages,… ─→ synapse-sync1/2 :8081/2 (reads)
matrix.tidework.io ─ nginx:443 ┤
                   └─ everything else ──────────→ synapse :8008  (client+fed, writes)
auth.tidework.io   ─ nginx:443 ─────────────────→ mas     :8090  (OIDC issuer/pages)
                          synapse ↔ workers replicate via redis (compose-internal)
                                  └──→ DO managed Postgres (synapse, mas DBs)
```

**Why compose and not matrix-docker-ansible-deploy** (deviation from ADR
0002's initial suggestion, recorded there): with an externally managed
Postgres and a single droplet, a ~40-line compose file plus two config
templates is fully auditable and has no opinionated machinery to fight; the
playbook earns its complexity at fleet scale, which this isn't yet.

## Scaling: Synapse workers

The load test (`ui/e2e/LOADTEST.md`) found the homeserver is single-process
CPU-bound — the sync **fan-out** (every write delivered to all room members'
`/sync`) dominates collaborative-editing latency. The fix is Synapse workers:

- **Redis** is the replication backbone (compose-internal, no host port).
- **`synapse-sync1` / `synapse-sync2`** are `generic_worker`s that serve the
  read/sync endpoints; nginx routes those to them (sticky per access token),
  everything else to the main process. Event persistence + stream writers stay
  on `main` (single-writer) — only reads are sharded.
- Config: `synapse/workers/*.yaml` (+ `log.config`), the `redis`/`instance_map`
  /replication-listener block in `synapse/homeserver.yaml.tmpl`, and the
  `upstream`/`location` routing in `nginx/matrix.conf`.

**Workers need spare cores.** On a 2-vCPU box (Synapse already ~1.2 cores) the
processes just contend — resize to ≥4 vCPU to get the benefit. Add more
`synapse-syncN` workers (config + compose service + an nginx `upstream` entry)
as cores allow; lifting the *write* ceiling additionally needs a dedicated
event-persister stream-writer worker.

**Workers also need Postgres connections.** Each Synapse process opens its own
pool, all sharing the managed cluster's `max_connections` (the smallest tier is
**25**). `homeserver.yaml.tmpl` keeps `cp_max` small so main + 2 workers + MAS
fit; running more workers (or real load) needs a larger PG plan or a PgBouncer
pooler in front of Postgres. This is a hard limit — check it before adding
workers (`SHOW max_connections;` and `pg_stat_activity`).

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
