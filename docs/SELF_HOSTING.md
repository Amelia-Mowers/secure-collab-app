# Self-hosting TideWork

TideWork is two separable things, and self-hosting either one is a different
job with a different amount of work:

1. **The app** — a static site. HTML, CSS, JavaScript and a WebAssembly module.
   It holds your keys, does the encryption, and talks to a homeserver. It has no
   backend of its own.
2. **The homeserver** — a Matrix server. It stores ciphertext and passes it
   between devices. It cannot read your workspaces.

Most people only need to host the second one. The app runs in your browser and
speaks only to the homeserver you point it at, so using ours to reach yours
sends us nothing — no account, no telemetry, no requests. If you would rather
not take that on trust, host the app too; it is a directory of files.

---

## Path 1 — your own homeserver, our app (easiest)

If you already run a Matrix homeserver, you are nearly done:

1. Open <https://app.tidework.io>.
2. Choose **Custom server**.
3. Enter your homeserver URL and create an account or sign in.

That is the whole procedure. It works with password accounts on a standard
Synapse — which is exactly how our browser end-to-end suite runs, against a
throwaway Synapse with password auth, on every change.

**Requirements**, all standard and on by default in Synapse:

| Needs | Why |
| --- | --- |
| Synapse | See *Why Synapse* below — this one is not just a preference |
| End-to-end encryption | The product. Nothing to enable; keys are made by clients |
| Key backup (`/room_keys`) | Recovery on a new device |
| Cross-signing | Device verification |
| Sensible `rc_message` | Synapse's chat-shaped default throttles imports badly — see below |

## Path 2 — your own homeserver, from nothing

`infra/selfhost/` is a complete, parameterised stack: Synapse, Postgres, and a
reverse proxy that obtains its own TLS certificate. It is not our production
deployment — that one also runs an OIDC provider, Stripe billing and Synapse
workers, none of which you need.

```sh
git clone https://github.com/Amelia-Mowers/tidework
cd tidework/infra/selfhost

cp .env.example .env
$EDITOR .env          # set your domain and email; secrets are generated

./setup.sh
docker compose up -d
./register-user.sh alice
```

Then sign in at <https://app.tidework.io> with **Custom server**.

Read [`infra/selfhost/README.md`](../infra/selfhost/README.md) for what each
setting does, the DNS you need, and how to upgrade.

**This path is tested.** `infra/selfhost/smoke-test.sh` brings the stack up from
nothing on every CI run — renders the config, starts Postgres and Synapse,
registers a user, signs in the way TideWork signs in, and checks the homeserver
capabilities the product depends on. A release is blocked if it fails. That is
what "supported" means here; it is not a promise, it is a job you can go and
read.

## Path 3 — host the app as well

The app is a static site with no server component:

```sh
cd ui
npm ci
npm run build          # -> ui/dist
```

Serve `ui/dist` from any static host or web server. Two things matter:

- **Set a Content-Security-Policy.** `ui/_headers` holds the one we serve; it
  restricts scripts to the app's own origin plus `wasm-unsafe-eval`, which the
  WebAssembly module needs. A CDN or host that injects its own script into the
  page breaks the product's central claim — ours did once, at the edge, which is
  why a post-deploy check now audits the live pages for scripts we did not ship.
- **Serve it over HTTPS.** WebCrypto, which does the encryption, is unavailable
  on insecure origins. The app will not work over plain HTTP.

**Point it at your homeserver at build time**, or your users are offered a
server with no address:

```sh
VITE_DEFAULT_HOMESERVER=https://matrix.example.org \
VITE_HOMESERVER_LABEL="Acme Internal" \
  npm run build
```

A build that is not ours does **not** advertise our homeserver — the sign-in
page offers yours and "Custom server", and nothing else. That is asserted by a
test, because it used to list `matrix.tidework.io` unconditionally: an operator
hosting the app for their own team was serving a page that offered a stranger's
service above their own.

---

## How accounts get created

**Registration is closed by default**, and that is deliberate: an open Matrix
server is found and abused within days, and you would be the one paying for it.

So the default flow is:

```sh
./register-user.sh alice          # you create the account
```

and the user then signs in normally. The app's **Sign in** tab works against
your server exactly as it does against ours — password login is what the whole
browser end-to-end suite exercises.

**What the app does when someone presses "Create account" anyway:** it tells
them your server does not allow self-service sign-up, that this is a deliberate
setting rather than a fault, and to ask whoever runs the server. It used to
surface Synapse's raw `M_FORBIDDEN: Registration has been disabled`, which reads
as "you are not allowed" and sends people to the wrong conclusion.

### Invitation tokens — the option worth reaching for

Creating every account by hand does not scale past a few people, and an open
server is found and abused within days. Tokens are the middle: people sign
themselves up, but only with an invitation you minted.

```sh
# in .env
SYNAPSE_OPEN_REGISTRATION=true
SYNAPSE_REGISTRATION_REQUIRES_TOKEN=true
```

then `./setup.sh && docker compose up -d`, and:

```sh
./register-user.sh admin --admin     # once, an admin to mint with
./make-token.sh --uses 10 --days 7   # an invitation for ten people, good for a week
```

Share the token. Your users open the app, choose **Custom server**, enter your
homeserver, and paste it into the **Invitation token** field on the Create
account tab. Nobody without a token can sign up.

The whole handshake is covered by `smoke-test.sh`, both halves: a sign-up
without a token is challenged for one, and the same sign-up with a valid token
completes. So this cannot quietly stop working.

### Fully open

`SYNAPSE_OPEN_REGISTRATION=true` on its own means anyone who finds your server
can create an account, with no email, no captcha and no invitation. Synapse does
**not** stop you — there is no config error for it, checked against 1.148. The
cost is not hypothetical: open Matrix servers are found by automation within
days, and an abused server gets defederated by others, which breaks the
cross-server collaboration your users wanted and is hard to undo.

Reach for tokens instead unless you actually want a public service.

## Why Synapse

TideWork specifies Synapse rather than a lighter homeserver, and it is not
brand loyalty.

When you invite someone to a workspace, they need to be able to read its
history. That relies on the invite carrying complete stripped state. **Conduit
omits the inviter's membership there**, and shared history degrades as a result
— the collaborator joins and cannot see what came before. We found this by
running the same suite against both: our integration harness and our browser
end-to-end harness were both moved from Conduit to Synapse for this reason.

Other homeservers may work. We do not test them, so we do not claim they do.

## Rate limits, and why the defaults are wrong for this

Synapse ships `rc_message: per_second 0.2, burst_count 10` — after ten messages,
one every five seconds. That is sized for chat.

TideWork is not chat. Creating a table from a template, importing a CSV, or
dragging a card that reorders its neighbours each send a **burst** of events. At
the stock limit a template import visibly stalls part-way through and completes
minutes later, which reads as the product being broken.

`infra/selfhost/` sets `per_second: 5, burst_count: 50`, sized for a small
trusted server. If yours is open to the public, lower them and expect imports to
be slow. This is the single most common way a technically-correct self-hosted
Synapse still feels wrong.

## What we do not support yet

Stated plainly, because finding out later is worse:

- **No migration path between homeservers.** Matrix has no account portability;
  moving servers means new user IDs and re-created workspaces. Export to CSV
  first — that part works from the app or the CLI.
- **No managed upgrade.** Upgrading is `docker compose pull` and restart, with
  Synapse's own release notes as the authority. We pin the versions our suites
  test against; anything newer is untested by us.
- **No backup tooling.** Postgres and the media store are yours to back up. If
  you lose the database you lose the ciphertext, and your users' keys will not
  bring it back.
- **No high availability.** One of everything. The stack is sized for a team,
  not a company.

## Getting help

Questions are welcome in the community room:
[`#community:tidework.io`](https://matrix.to/#/#community:tidework.io). It is a
public, unencrypted room — do not paste recovery keys or private workspace
invite links into it.

Security issues go to the process in [SECURITY.md](../SECURITY.md), not to the
room.
