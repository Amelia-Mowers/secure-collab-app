# Project Status

**As of:** 2026-06-11
**Supersedes:** `BUILD_STATUS.md` and `docs/SESSION_SUMMARY.md` (both deleted —
they described the 2026-03-09 scaffold and had drifted badly from reality).

This is a point-in-time snapshot. The prioritized backlog is
**[TODO.md](./TODO.md)**; design decisions are in **[docs/adr/](./docs/adr/)**;
the structural review that drove the last quarter's work is
**[ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)**.

## What works (implemented and test-verified)

**Core data layer** (`crates/tables-over-matrix`, `crates/app-core`)

- LWW cells/tables with a **hybrid logical clock** (advance-on-receive, seeded
  from replay, `origin_server_ts` tiebreak) — convergence is property-tested
  and verified across two real clients via Conduit (review §4.1).
- **Order-based bumping** wired into the write path; cold start unified on one
  order-independent engine (§4.3, §4.4).
- "Everything is tables": schema (`_schema`), views (`_views`), and table
  definitions (`_tables`) replay through the same `apply_update` path as user
  data.

**Encryption & key management** (ADR 0001)

- Rooms are encrypted at creation; sends are **fail-closed** into unencrypted
  rooms; the UI badge reflects real room state.
- Auto cross-signing + key backup, recovery-key flow, SAS device verification
  with a no-bypass new-device gate, undecryptable-history detection + banner.
- **Per-device persistent IndexedDB stores** (state + crypto), so sessions,
  Megolm keys, and verification state survive reloads.

**UI** (`ui/`)

- Matrix auth (register/sign-in/multi-account/session restore), workspaces
  page with invitations, sidebar, sharing.
- Views: TanStack-virtualized table grid (typed cell registry, commit-on-blur
  editors, header sort, global filter), entry view, kanban (drag-and-drop),
  card view; view creation/switching persisted as `_views` data.

**Test pyramid** (counts as of this date)

- Rust: ~120 unit/property tests + Conduit integration suites
  (`scripts/run-integration-tests.sh` — two-client sync, encrypted
  round-trips, cold start, backup/recovery, SAS).
- UI: 242 vitest tests (behavior-focused, no snapshots).
- E2E: two-browser Playwright harness against real WASM + live Conduit
  (`ui/e2e/` — smoke, recovery, verification, core single-device journey
  incl. reload persistence).
- CI: fmt + clippy `-D warnings` + per-feature tests + WASM build + UI
  typecheck/lint/test/build + Conduit integration + e2e + Pages deploy.

## Known gaps (the honest list)

See TODO.md for the full prioritized backlog; the load-bearing items:

- **Legacy unencrypted rooms** (P0): the fail-closed guard makes them
  read-only with no migrate path or UI explanation.
- **At-rest encryption** (P1): the session blob (access token) and IndexedDB
  stores are plaintext under same-origin protection only.
- **E2E coverage**: collaboration (two users), workflows, and multi-tab
  journeys are not yet covered by the browser harness.
- **Optimistic ↔ LWW reconciliation** (FE): a rejected write can still
  flash-then-revert.

## How to update this file

Replace the snapshot wholesale and bump the date — don't append a changelog
(git history is the changelog).
