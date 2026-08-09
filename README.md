# TideWork

[![CI](https://github.com/Amelia-Mowers/tidework/actions/workflows/ci.yml/badge.svg)](https://github.com/Amelia-Mowers/tidework/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**An end-to-end encrypted collaborative workspace.** Tables, kanban boards, and
documents that sync in real time — built on [Matrix](https://matrix.org), so the
homeserver stores ciphertext and only your devices hold the keys.

Think Notion or Airtable, with encryption the operator cannot bypass, federation, and
no lock-in. Hosted at **[tidework.io](https://tidework.io)**; the whole thing,
cryptography included, is Apache-2.0 and self-hostable.

## What it does

- **Tables of typed cells** — text, number, date, checkbox, select and multi-select,
  Markdown documents, JSON, workspace members, references to rows of another table,
  and formula columns computed from the row (real Typst syntax).
- **Views** — table grid, kanban, and card layouts, each saved with its own filters,
  sort, and layout. Filters are type-aware and support per-viewer values (`is today`,
  `@me`).
- **Real-time, offline-tolerant sync** — last-write-wins cells on a hybrid logical
  clock. Unsent edits persist in an encrypted outbox and replay on reconnect.
- **Change history** — every edit is in the timeline; revert a table to any point.
- **Roles enforced by the server** — admin/editor/viewer as Matrix power levels, so a
  modified client cannot write past them.
- **Import/export** — CSV archives (ADR 0004) readable by the app and the CLI, so
  your data leaves as easily as it arrives.
- **A native CLI** sharing the same Rust engine as the browser.

## Status

Deployed, in daily use, and holding real data — including this project's own backlog.
The core is stable; the surface is narrower than the products it resembles.

**There has been no third-party security audit.** CI proves the cryptographic
guarantees still hold as the code changes; it cannot tell you the design was right
to begin with. Those are different claims and we don't conflate them.

Current state, including the honest list of what is missing, is in
**[STATUS.md](./STATUS.md)**; design decisions are in **[docs/adr/](./docs/adr/)**;
security scope and reporting are in **[SECURITY.md](./SECURITY.md)**.

Schema and event formats may still change in ways that need migration.

## How it works

Three layers, one data model:

| Layer | Crate/dir | Role |
| --- | --- | --- |
| `tables-over-matrix` | `crates/tables-over-matrix` | LWW cells over Matrix — the protocol layer |
| `app-core` | `crates/app-core` | Workspaces, schema, views, archives; compiled to WASM |
| `ui` | `ui/` | React view layer over the WASM bridge |

`crates/cli` is a fourth consumer: a native binary linking `app-core` directly rather
than through WASM, so the CLI and the browser share one engine.

**Everything is a table.** A cell is `(table_id, row_id, column_id)`. Schema is a
table; views are a table; table definitions are a table. One merge rule, one code
path — kanban and documents are projections of the same encrypted cells.

**One room per workspace**, so the homeserver sees room metadata and nothing about
structure. **Order-based bumping** on every write bounds the cold-start lookback to
roughly the number of cells in a table.

Full detail in [architecture.md](./architecture.md), with the reasoning behind each
decision in [docs/adr/](./docs/adr/).

## Quick start

The Nix dev shell provides everything — Rust with the WASM target, wasm-pack, Node 20,
and a Synapse homeserver for the tests:

```sh
nix develop
make all      # build Rust + WASM + UI, run tests
make dev      # dev server on http://localhost:5173
```

Without Nix, see [QUICKSTART.md](./QUICKSTART.md) for the manual toolchain.

## The CLI

`tidework` drives the same encrypted workspaces from a terminal. A saved view selects
the same rows there as in the browser — including dynamic filter values, which
resolve against whoever runs the command.

```sh
cargo build -p tidework-cli    # excluded from default-members; build explicitly

tidework login --sso --homeserver https://matrix.tidework.io
tidework table show "My Workspace" Tasks --view "Open Issues"
tidework row add "My Workspace" Tasks name="Fix the thing" status=open
```

Builds natively on Windows, macOS, and Linux (SQLite bundled). See
[`crates/cli/README.md`](./crates/cli/README.md).

## Development

```sh
cargo test                     # Rust unit + property tests
cargo fmt && cargo clippy -- -D warnings

cd ui && npm test              # UI tests
cd ui && npm run type-check

nix develop --command bash scripts/run-integration-tests.sh   # against real Synapse
nix develop --command bash -c "cd ui && npm run e2e"          # two-browser Playwright
```

The test pyramid is the project's main quality control, and CI runs all of it on every
change:

| Suite | Count | What it proves |
| --- | --- | --- |
| Rust unit + property | 234 | LWW convergence, schema, archives, formulas |
| UI (vitest) | 705 | Behaviour of hooks, cells, views — no snapshots |
| Synapse integration | 57 | Two-client sync, encrypted round-trips, cold start, backup/recovery, SAS |
| Browser e2e (Playwright) | 38 | Real WASM against a live homeserver: registration, recovery, verification, collaboration, multi-tab, reload persistence, templates, CSV import/export, formula editing, and a guard that the wasm heap does not grow |

Counts as of 2026-08-08, from a real run — `cargo test`, `npm test -- --run`,
`npx playwright test --list`, and the integration job. If you change them, take
the new numbers the same way rather than estimating.

Contribution workflow and coding standards are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Self-hosting

The app is a static site with no backend of its own — it holds your keys and talks
only to the homeserver you point it at. So there are two things you might host,
and most people only need the second.

**Already have a Matrix homeserver?** Open [app.tidework.io](https://app.tidework.io),
choose *Custom server*, and sign in. That is the whole procedure.

**Starting from nothing?** [`infra/selfhost/`](./infra/selfhost/) is a
parameterised stack — Synapse, Postgres, and a proxy that gets its own TLS
certificate:

```sh
cd infra/selfhost && cp .env.example .env && $EDITOR .env
./setup.sh       # renders the config, makes the keys
./bootstrap.sh   # starts it, creates your admin, prints your first invitation
```

Servers start **invitation-only**: people sign themselves up in the app, but
only with a token you minted.

**It is tested, not asserted.** `infra/selfhost/smoke-test.sh` brings that stack
up from nothing on every CI run — renders the config, starts Postgres and
Synapse, registers a user, signs in the way TideWork signs in, and checks the
homeserver capabilities the product depends on. A release is blocked if it fails.

Full detail, including hosting the app itself and what we *don't* support yet:
**[docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md)**.

Use **Synapse**, not Conduit: Conduit omits invite-time fields the shared-history path
depends on, so collaborator history degrades. The test harnesses run Synapse for the
same reason.

`infra/` (as opposed to `infra/selfhost/`) is our *production* deployment —
Synapse + MAS + Stripe + workers — kept in the open for transparency rather than
for reuse. [docs/OPERATING.md](./docs/OPERATING.md) is its runbook.

## Project layout

```
crates/
  tables-over-matrix/   LWW tables over Matrix (+ Synapse integration tests)
  app-core/             Workspaces, schema, views, archives, WASM bridge
  cli/                  `tidework` — native client over the same core
ui/                     React frontend (+ e2e/ Playwright harness)
billing/                Stripe subscription Worker (hosted service)
infra/                  Homeserver deployment, healthchecks, secrets
site/                   Marketing site (tidework.io)
docs/adr/               Architecture decision records
```

## Backlog

Task management lives **inside the product** — the `Issues` table of the *TideWork PM*
workspace on the production homeserver, TideWork dogfooding TideWork:

```sh
tidework table show "TideWork PM" Issues --where status=open --sort priority
```

[TODO.md](./TODO.md) is a pointer to it.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

Built on the Matrix protocol, the [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk),
and the Rust/WebAssembly toolchain.
