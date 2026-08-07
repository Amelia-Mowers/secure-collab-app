# A Matrix homeserver for TideWork

Synapse, Postgres, and a reverse proxy that gets its own TLS certificate.
Three containers, one `.env`, no other moving parts.

This is **not** a copy of the hosted stack in `infra/`. That one also runs an
OIDC provider, a Stripe integration and Synapse workers — none of which a
self-hoster needs. TideWork signs in here with a username and password.

## Quick start

```sh
cp .env.example .env
$EDITOR .env          # domain + email; secrets are generated for you
./setup.sh
docker compose up -d
./register-user.sh alice
```

Then open <https://app.tidework.io>, choose **Custom server**, and enter your
homeserver URL.

## Before you start

**DNS.** Point `TIDEWORK_HOSTNAME` at this machine with an A/AAAA record, and
open ports 80 and 443. Caddy needs port 80 reachable to obtain a certificate;
it is not optional and it is the most common reason a first run fails.

**The one irreversible decision.** `TIDEWORK_SERVER_NAME` becomes the second
half of every user ID — `@alice:example.org` — and cannot be changed afterwards
without invalidating every account, room and device. If you want IDs on your
bare domain while Synapse runs on a subdomain, set them differently and publish
the delegation files `./setup.sh` prints.

**Resources.** Synapse is comfortable in about 2 GB of RAM for a small team.
Postgres wants disk more than memory. The database only ever holds ciphertext,
but ciphertext is not smaller than plaintext.

## What the settings do

| Setting | Notes |
| --- | --- |
| `TIDEWORK_SERVER_NAME` | Permanent. The `:server` half of every user ID |
| `TIDEWORK_HOSTNAME` | Where Synapse answers; what the certificate is for |
| `TIDEWORK_ACME_EMAIL` | Let's Encrypt expiry warnings |
| `SYNAPSE_OPEN_REGISTRATION` | `false` by default — see below |
| `TIDEWORK_FEDERATION` | `true` lets your users collaborate across servers |
| `*_IMAGE` | Pinned to the versions our suites test against |

**Registration is closed by default.** An open Matrix server is found and abused
within days. Create accounts with `./register-user.sh`, which uses a shared
secret and never sends it over the network. If you do open registration, turn on
email or captcha verification with it.

## Upgrading

```sh
docker compose pull
docker compose up -d
```

Synapse applies its own database migrations at startup. **Read Synapse's release
notes first** — it occasionally requires a manual step, and it is the authority
on its own upgrades, not us.

The pinned versions in `.env.example` are the ones TideWork's integration and
end-to-end suites run against. Newer versions will usually work; we do not test
them, so we do not claim they do.

## Backups

Yours to arrange. Two things matter:

```sh
docker compose exec -T postgres pg_dump -U synapse synapse | gzip > synapse-$(date +%F).sql.gz
```

and the `data/synapse` directory, which holds the signing key and the media
store. **Losing the signing key means your server can no longer prove it is
itself** to other servers in the federation.

Losing the database loses the ciphertext. Your users' recovery keys will not
bring it back — those decrypt data, they do not store it.

## Is it working?

```sh
curl https://your.homeserver/_matrix/client/versions
docker compose ps
docker compose logs -f synapse
```

The stack itself is exercised on every change to this repository by
`./smoke-test.sh`, which brings it up from nothing, registers a user, signs in
the way TideWork does, and checks the homeserver capabilities the product needs.
You can run it locally too — it uses a throwaway project name and cleans up
after itself:

```sh
./smoke-test.sh
```

## Files

| | |
| --- | --- |
| `docker-compose.yml` | The stack. Synapse has no host port — only Caddy reaches it |
| `docker-compose.smoke.yml` | Test-only override that publishes Synapse locally. Never use for a real deployment |
| `Caddyfile` | TLS, reverse proxy, and the `.well-known` delegation documents |
| `synapse/homeserver.yaml.tmpl` | The Synapse config, with the reasoning in comments |
| `setup.sh` | Generates secrets and the signing key, renders the config |
| `register-user.sh` | Creates an account |
| `smoke-test.sh` | Brings the whole thing up and proves it works |

Fuller context, including hosting the app itself, is in
[`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md).
