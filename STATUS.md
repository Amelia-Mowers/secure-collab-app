# Project Status

**As of:** 2026-07-31

A point-in-time snapshot. The prioritized backlog lives in the product itself (see
[TODO.md](./TODO.md)); design decisions are in **[docs/adr/](./docs/adr/)**; the
launch-readiness review is **[LAUNCH_AUDIT.md](./LAUNCH_AUDIT.md)**; the structural
review behind the current architecture is
**[ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)**.

## What works (implemented and test-verified)

**Core data layer** (`crates/tables-over-matrix`, `crates/app-core`)

- LWW cells/tables on a **hybrid logical clock** (advance-on-receive, seeded from
  replay, `origin_server_ts` tiebreak) — convergence is property-tested and verified
  across two real clients.
- **Order-based bumping** in the write path; cold start unified on one
  order-independent engine.
- "Everything is tables": schema (`_schema`), views (`_views`), table definitions
  (`_tables`) and history (`_history`) replay through the same `apply_update` path as
  user data.
- **CSV archive interchange** (ADR 0004): workspace export/import, shipped templates,
  and single-table CSV, shared by the app and the CLI.
- **Formula columns** parsed with the upstream Typst parser and evaluated at read
  time, so a computed value never fights LWW.

**Encryption & key management** (ADR 0001)

- Rooms encrypted at creation; sends **fail closed** into unencrypted rooms.
- Auto cross-signing + key backup, recovery-key flow, SAS device verification with a
  no-bypass new-device gate, undecryptable-history detection + banner.
- **Passkey/WebAuthn-PRF custody**: a passkey wraps the recovery key, so a biometric
  tap unlocks keys on a new device; the recovery key remains break-glass.
- **At-rest encryption of local stores**, with the data key wrapped twice — under a
  non-extractable device key (so a reload never prompts) and under the master secret
  (so a new device can recover).

**Hosted service** (ADR 0002)

- Synapse + MAS behind nginx on a managed droplet; OAuth/MAS sign-in, Google SSO.
- Stripe subscriptions: 14-day trial, lock-on-lapse, unlock-on-payment, billing
  portal for self-serve cancellation, and a sweep that locks past trial + grace.
- Healthcheck timer with Resend alerting and MAS self-heal.

**UI** (`ui/`)

- Auth (register/sign-in/multi-account/session restore), workspaces page with
  invitations, sidebar, sharing, roles.
- Views: virtualized table grid (typed cell registry, commit-on-blur editors, sort,
  filters, multi-cell selection), entry view, kanban with drag-and-drop, card view;
  views persisted as `_views` data.
- A **SharedWorker client** so multiple tabs share one Matrix client and one send
  queue.

**CLI** (`crates/cli`) — password + OAuth/MAS login, workspace/table/row/column CRUD,
saved-view reads, CSV import/export, against production.

## Test pyramid (counts as of this date)

- **Rust:** 215 unit/property tests, plus Synapse integration suites
  (`scripts/run-integration-tests.sh` — two-client sync, encrypted round-trips, cold
  start, backup/recovery, SAS).
- **UI:** 626 vitest tests, behaviour-focused, no snapshots.
- **E2E:** 26 Playwright tests against real WASM + live Synapse — smoke, recovery,
  verification, collaboration, multi-tab, at-rest, device key, workflows, reconnect,
  templates, and the core single-device journey including reload persistence. A
  second suite runs OAuth against Synapse + MAS.
- **CI:** fmt + clippy `-D warnings` + tests + WASM build + UI typecheck/lint/test/
  build + Synapse integration + both e2e suites + Pages/Worker deploy.

## Known gaps (the honest list)

[LAUNCH_AUDIT.md](./LAUNCH_AUDIT.md) has the full assessment. The load-bearing items:

- **The published terms and privacy policy have not been reviewed by a lawyer**, and
  the provider is an individual rather than an entity — so personal liability sits
  behind the cap. Live at `/terms` and `/privacy`, with acceptance enforced at
  registration by MAS.
- **Search does not exist.** The placeholder is gone; the feature is not built, and
  needs a client-side design (the server cannot index ciphertext).
- **No comments, attachments, notifications, per-action undo, or trash/restore** —
  ordinary expectations of this product class.
- **No demo route**, though ADR 0002 specifies one as the top of the funnel.
- **Self-hosting works but is not a supported path**: the `infra/` configs are written
  for our deployment, not parameterised.

## How to update this file

Replace the snapshot wholesale and bump the date — don't append a changelog (git
history is the changelog).
