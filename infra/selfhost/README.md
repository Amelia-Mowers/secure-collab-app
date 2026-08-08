# A Matrix homeserver for TideWork

Synapse, Postgres, and a reverse proxy that gets its own TLS certificate.
Three containers, one `.env`, no other moving parts.

This is **not** a copy of the hosted stack in `infra/`. That one also runs an
OIDC provider, a Stripe integration and Synapse workers — none of which a
self-hoster needs. TideWork signs in here with a username and password.

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

## Quick start

```sh
cp .env.example .env
$EDITOR .env          # domain + email; secrets are generated for you
./setup.sh            # renders the config, makes the keys
./bootstrap.sh        # starts it, creates your admin, prints your first invitation
```

`bootstrap.sh` ends by printing an **invitation token**. Give it to the people
you want on the server: they open <https://app.tidework.io>, choose **Custom
server**, enter your homeserver URL, and paste the invitation into the
*Invitation token* field when creating an account.

Nobody without an invitation can sign up. Mint more with `./make-token.sh`.

## What the settings do

| Setting | Notes |
| --- | --- |
| `TIDEWORK_SERVER_NAME` | Permanent. The `:server` half of every user ID |
| `TIDEWORK_HOSTNAME` | Where Synapse answers; what the certificate is for |
| `TIDEWORK_ACME_EMAIL` | Let's Encrypt expiry warnings |
| `SYNAPSE_OPEN_REGISTRATION` | `true`, together with the line below — see *Accounts* |
| `SYNAPSE_REGISTRATION_REQUIRES_TOKEN` | `true`. Self-serve sign-up, gated by an invitation token |
| `TIDEWORK_FEDERATION` | `true` lets your users collaborate across servers |
| `*_IMAGE` | Pinned to the versions we test against |

## Accounts

**Invitation-only by default** — the two registration settings above are both
`true`, which means people sign themselves up in the app but only with a token
you minted. `./bootstrap.sh` prints your first one; `./make-token.sh --uses 10
--days 7` mints more. Nobody without a token can sign up.

To create an account yourself instead, `./register-user.sh alice`. It uses the
shared secret and never puts it on the network.

To close sign-up entirely, set `SYNAPSE_OPEN_REGISTRATION=false`. To open it to
anyone, set `SYNAPSE_REGISTRATION_REQUIRES_TOKEN=false` — but an open Matrix
server is found by automation within days, and an abused one gets defederated by
other homeservers. Either way, re-run `./setup.sh && docker compose up -d`.

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
curl https://your.homeserver/_matrix/client/versions   # should return JSON
docker compose ps
docker compose logs -f synapse
```

`./smoke-test.sh` brings the whole stack up from nothing, registers a user,
signs in the way TideWork does, and checks the capabilities the app needs. It
uses a throwaway project name and cleans up after itself, so it is safe to run
alongside a real deployment. CI runs it on every change to this repository.

### When it is not

**No certificate / Caddy retries forever.** Port 80 must be reachable from the
internet — Let's Encrypt uses it to validate, and a firewall or a router that
only forwards 443 is the most common first-run failure. Check `docker compose
logs caddy`.

**The app cannot reach the server, but `curl` can.** If `TIDEWORK_SERVER_NAME`
differs from `TIDEWORK_HOSTNAME`, the delegation documents at the server name
need `Access-Control-Allow-Origin: *`. A browser will not follow them without
it. `./setup.sh` prints the exact contents.

**Sign-up is refused with "invalid registration token".** Tokens expire and have
a use count. Mint a fresh one with `./make-token.sh`.

**Imports stall part-way through.** Rate limits — see `rc_message` in
`synapse/homeserver.yaml.tmpl`.

**Synapse will not start after an edit.** Check `data/synapse/homeserver.yaml`,
not the template. Re-running `./setup.sh` overwrites it from the template, which
is where edits should go.

## Files

| | |
| --- | --- |
| `docker-compose.yml` | The stack. Synapse has no host port — only Caddy reaches it |
| `docker-compose.smoke.yml` | Test-only override that publishes Synapse locally. Never use for a real deployment |
| `Caddyfile` | TLS, reverse proxy, and the `.well-known` delegation documents |
| `synapse/homeserver.yaml.tmpl` | The Synapse config, with the reasoning in comments |
| `setup.sh` | Generates secrets and the signing key, renders the config |
| `bootstrap.sh` | Starts the stack, creates the admin, mints the first invitation |
| `register-user.sh` | Creates an account directly, without an invitation |
| `make-token.sh` | Mints an invitation token so others can create their own |
| `smoke-test.sh` | Brings the whole thing up and proves it works |

Fuller context, including hosting the app itself, is in
[`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md).
