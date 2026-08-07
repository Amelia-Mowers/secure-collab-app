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

To point a self-hosted app at a default homeserver, set `VITE_DEFAULT_HOMESERVER`
at build time. Users can still choose another.

---

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
