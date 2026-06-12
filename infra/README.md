# TideWork hosted infrastructure

The deploy configuration for the hosted homeserver (ADR 0002 phase B):
Synapse + MAS in compose on a DigitalOcean droplet, against DO **managed
Postgres**, behind host nginx with certbot TLS. The app + demo stay on
CDN/static hosting; the billing Worker (phase D) lives on Cloudflare.

```
matrix.tidework.io ─ nginx:443 ─→ synapse container :8008  (client+federation)
auth.tidework.io   ─ nginx:443 ─→ mas container     :8090  (OIDC issuer/pages)
                                  └──→ DO managed Postgres (synapse, mas DBs)
```

**Why compose and not matrix-docker-ansible-deploy** (deviation from ADR
0002's initial suggestion, recorded there): with an externally managed
Postgres and a single droplet, a ~40-line compose file plus two config
templates is fully auditable and has no opinionated machinery to fight; the
playbook earns its complexity at fleet scale, which this isn't yet.

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
