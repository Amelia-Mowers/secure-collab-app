# Self-hosting TideWork

TideWork is two separable things, and you can host either one without the
other:

1. **The app** — a static site. HTML, CSS, JavaScript and a WebAssembly module.
   It holds your keys, does the encryption, and talks to a homeserver. It has no
   backend of its own.
2. **The homeserver** — a Matrix server. It stores ciphertext and passes it
   between devices. It cannot read your workspaces.

Most people only need the second one. The app runs in your browser and speaks
only to the homeserver you point it at, so using ours to reach yours sends us
nothing. If you would rather not take that on trust, host the app too; it is a
directory of files.

---

## Path 1 — your own homeserver, our app

If you already run a Matrix homeserver:

1. Open <https://app.tidework.io>.
2. Choose **Custom server**.
3. Enter your homeserver URL and sign in or create an account.

**Requirements** — all standard and on by default in Synapse:

| Needs | Why |
| --- | --- |
| Synapse | See [Why Synapse](#why-synapse) — this one is not just a preference |
| End-to-end encryption | The product. Nothing to enable; keys are made by clients |
| Key backup (`/room_keys`) | Recovery on a new device |
| Cross-signing | Device verification |
| Raised `rc_message` | Synapse's chat-shaped default throttles imports badly — see [Rate limits](#rate-limits) |

## Path 2 — your own homeserver, from nothing

`infra/selfhost/` is a complete stack: Synapse, Postgres, and a reverse proxy
that obtains its own TLS certificate.

Before you start, point your hostname at the machine with an A/AAAA record and
open ports 80 and 443.

```sh
git clone https://github.com/Amelia-Mowers/tidework
cd tidework/infra/selfhost

cp .env.example .env
$EDITOR .env          # your domain and email; secrets are generated

./setup.sh            # renders the config, makes the keys
./bootstrap.sh        # starts it, creates your admin, prints your first invitation
```

Then sign in at <https://app.tidework.io> with **Custom server**.

[`infra/selfhost/README.md`](../infra/selfhost/README.md) covers what each
setting does, backups, upgrades, and what to check when something is wrong.

## Path 3 — host the app as well

The app is a static site with no server component:

```sh
cd ui
npm ci
npm run build          # -> ui/dist
```

Serve `ui/dist` from any static host or web server. Two things matter:

- **Serve it over HTTPS.** WebCrypto, which does the encryption, is unavailable
  on insecure origins. The app will not work over plain HTTP.
- **Set a Content-Security-Policy.** `ui/_headers` holds the one we serve: it
  restricts scripts to the app's own origin, plus `wasm-unsafe-eval` for the
  WebAssembly module. Keep it. If your CDN or host offers to inject analytics or
  a web-tools script, that policy will block it — and the injected script would
  have had access to your users' keys.

**Point the build at your homeserver**, or your users are offered a server with
no address:

```sh
VITE_DEFAULT_HOMESERVER=https://matrix.example.org \
VITE_HOMESERVER_LABEL="Acme Internal" \
  npm run build
```

A build that is not ours does not advertise our homeserver. The sign-in page
offers yours and **Custom server**, and nothing else.

---

## How accounts get created

**The default is invitation-only.** Registration is on, but every sign-up must
present a token you minted — so the server is not open to whoever finds it, and
you are not creating an account by hand for each person.

`./bootstrap.sh` prints your first invitation. Mint more with:

```sh
./make-token.sh --uses 10 --days 7
```

Give the token to your users. They open the app, choose **Custom server**, enter
your homeserver, and paste it into the **Invitation token** field on the Create
account tab.

For a one-off, you can also create an account directly:

```sh
./register-user.sh alice
```

### The two alternatives

**Closed** — `SYNAPSE_OPEN_REGISTRATION=false`. Nobody can sign themselves up;
you run `./register-user.sh` for every person. Safest, and it stops being
practical at about five people. If someone presses *Create account* against a
closed server, the app tells them sign-up is disabled here and to ask whoever
runs the server.

**Fully open** — `SYNAPSE_OPEN_REGISTRATION=true` with
`SYNAPSE_REGISTRATION_REQUIRES_TOKEN=false`. Anyone who finds your server can
create an account, with no email, captcha or invitation. Synapse will not stop
you. Open Matrix servers are found by automation within days, and an abused
server gets defederated by others — which breaks the cross-server collaboration
your users wanted, and is hard to undo. Choose this only if you actually want to
run a public service.

Change either in `.env`, then `./setup.sh && docker compose up -d`.

## Why Synapse

When you invite someone to a workspace, they need to read its history, and that
relies on the invite carrying complete stripped state. Conduit omits the
inviter's membership there, so shared history degrades: the collaborator joins
and cannot see what came before.

Other homeservers may work. We do not test them, so we do not claim they do.

## Rate limits

Synapse ships `rc_message: per_second 0.2, burst_count 10` — after ten messages,
one every five seconds. That is sized for chat.

TideWork is not chat. Creating a table from a template, importing a CSV, or
dragging a card that reorders its neighbours each send a **burst** of events. At
the stock limit a template import stalls part-way through and finishes minutes
later, which looks like the product being broken.

`infra/selfhost/` sets `per_second: 5, burst_count: 50`, sized for a small
trusted server. If yours is open to the public, lower them and expect imports to
be slow. On an existing homeserver, this is the single most common reason a
correctly-configured Synapse still feels wrong.

## What we do not support yet

Stated plainly, because finding out later is worse:

- **No migration path between homeservers.** Matrix has no account portability;
  moving servers means new user IDs and re-created workspaces. Export to CSV
  first — that works from the app or the CLI.
- **No managed upgrade.** Upgrading is `docker compose pull` and restart, with
  Synapse's own release notes as the authority.
- **No backup tooling.** Postgres and the media store are yours to back up. If
  you lose the database you lose the ciphertext, and your users' recovery keys
  will not bring it back.
- **No high availability.** One of everything. The stack is sized for a team,
  not a company.

## Getting help

Questions are welcome in the community room:
[`#community:tidework.io`](https://matrix.to/#/#community:tidework.io). It is a
public, unencrypted room — do not paste recovery keys or workspace invite links
into it.

Security issues go to the process in [SECURITY.md](../SECURITY.md), not to the
room.
