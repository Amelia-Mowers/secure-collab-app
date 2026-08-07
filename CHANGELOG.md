# Changelog

What changed, in the words of someone using TideWork rather than someone
building it. The app shows the entry for a version you have not seen yet, so
these lines are read by people who do not know what a `RefCell` is.

Format: newest first, `## <version> — <date>`. Every released version has an
entry; `scripts/release.sh` refuses to cut a tag without one.

## 0.1.2 — 2026-08-07

- **Self-hosting is now a supported path, not a worked example.**
  `infra/selfhost/` brings up a complete Matrix homeserver — Synapse, Postgres,
  and a proxy that obtains its own TLS certificate — from one config file and
  `docker compose up`. It is exercised from nothing on every change by CI, which
  registers a user and signs in the way the app does, so it cannot quietly stop
  working. [Guide](https://github.com/Amelia-Mowers/tidework/blob/main/docs/SELF_HOSTING.md).
- Already have a Matrix homeserver? You never needed any of that: open the app,
  choose **Custom server**, and sign in.
- **A self-hosted copy of the app no longer offers our homeserver.** The sign-in
  page listed the official TideWork server unconditionally, so an operator
  running the app for their own team was serving a page that suggested somebody
  else's service above their own. It now offers the server that build was
  configured for, and nothing else.
- **A clearer message when a server does not allow sign-ups.** Self-hosted
  servers ship with registration closed, so pressing "Create account" against
  one used to show `M_FORBIDDEN: Registration has been disabled` — which reads
  as "you are not allowed". It now says the server does not allow self-service
  sign-up, that this is deliberate, and to ask whoever runs it.

## 0.1.1 — 2026-08-07

- **Fixed a memory leak that could make the app stop responding.** After a long
  editing session — most often on a board, where a card move does the most work
  — the tab could stop updating until it was reloaded. Nothing was ever lost;
  unsent edits are written to disk as they are made. The cause was the memory
  allocator used in the WebAssembly build, which never reused freed memory, so
  the browser tab's memory grew until it hit its limit. Reading one small table
  cost about 12 KB of memory permanently; it now costs none.

## 0.1.0 — 2026-08-03

First public release. An end-to-end encrypted workspace with linked tables,
formulas, kanban boards and documents, built on Matrix — the homeserver stores
ciphertext, and only your devices hold the keys.

- Tables, kanban boards, card and entry views, all projections of the same
  encrypted cells, so they stay consistent without a sync step.
- Recovery key, passkey unlock, device verification, and encrypted local
  storage.
- CSV export and import for a whole workspace, from the app or the CLI.
- A no-account demo that runs entirely in your tab.
- Federation: use the hosted server or point the app at any Matrix homeserver.

Known limitations, stated plainly, are in
[STATUS.md](./STATUS.md) — including that there has been no third-party
security audit.
