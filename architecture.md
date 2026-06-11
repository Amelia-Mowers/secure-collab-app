# Collaborative Workspace over Matrix — Architecture Writeup

## Vision

An open-source, end-to-end encrypted, real-time collaborative workspace built on top of the Matrix protocol. Think Notion or Airtable, but with genuine E2E encryption, federation, and full data sovereignty — powered by an open, decentralized protocol rather than a proprietary cloud.

The app serves two core use cases:

- **Single user, multiple devices:** A private, encrypted workspace that syncs seamlessly across devices — solving the problem that tools like Obsidian and Standard Notes have failed to solve cleanly. The homeserver acts as a zero-knowledge sync relay.
- **Teams:** Real-time collaborative project management, task tracking, and structured data — with the encryption and federation guarantees that Notion, Asana, and similar tools don't offer.

Both cases use the exact same architecture. A solo user is simply a team of one.

## Business Model

Open-source core with enterprise contracts. The open-source codebase builds trust that the E2E encryption is real (auditable, not marketing), while enterprise contracts cover support SLAs, managed hosting, compliance features, admin tooling, and SSO integrations with corporate identity providers.

## Core Concept: Everything Is Tables

The fundamental data model is **tables of LWW (Last-Write-Wins) cells**. Every piece of data in the system — user content, schema definitions, view configurations — is a cell in a table.

- A **cell** is identified by `(table_id, row_id, column_id)` and holds a value and a timestamp.
- **Schema** is a table: column definitions are rows in a system metadata table.
- **View configurations** are a table: each view (kanban, calendar, task list) is a row describing which table it projects, which columns map to which view properties, sort/filter rules, etc.
- **Table definitions** are a table: a system table whose rows define the other tables in the workspace.

This means there is **one event type, one merge strategy, and one code path** for all data in the system. No special cases for schema vs. data vs. configuration.

### Views

Views are pure client-side projections over the underlying table data. The same table can be rendered as:

- **Kanban board** — grouped by a status column; dragging a card between columns writes to that cell.
- **Calendar** — indexed by a date column; dragging an event writes to the date cell.
- **Task list** — sorted/filtered by priority, assignee, due date, etc.
- **Derived/filtered tables** — arbitrary queries over the underlying data.

All views support **bidirectional editing**: interactions in the view (dragging, inline editing, checking a box) translate directly to `cell.update` writes on the underlying table.

## Matrix as the Data Layer

### Why Matrix?

Instead of building a custom backend, the app piggybacks on the Matrix protocol, using it as an encrypted collaborative data store. This provides:

- **E2E encryption for free** — Megolm handles group encryption per room. Every CRDT operation is encrypted without building any crypto primitives.
- **Federation for free** — Users on different homeservers can collaborate. A user on `matrix.org` can work with someone on `company.selfhosted.com`.
- **Auth and identity for free** — Matrix handles user accounts, device management, and key verification.
- **Persistence for free** — The homeserver stores event history. No separate database needed.
- **Device sync for free** — Matrix's sync API keeps all of a user's devices up to date.

### Single Room per Workspace

All workspace data lives in a **single Matrix room**. This is a deliberate privacy decision.

The homeserver can see room-level metadata: room IDs, membership lists, event counts, timing patterns. If each table were a separate room, the server could infer the workspace's structure — how many tables exist, which users are active in which, and access patterns over time. That's meaningful metadata leakage.

With a single room, the server sees only "this room has N members and X encrypted events." It cannot distinguish a schema change from a cell update from a view configuration change. All encrypted blobs in one stream.

The tradeoff is coarser permissions (Matrix permissions are per-room) and every client syncs the full workspace. For the target use case — small-to-medium teams doing project management — this is acceptable.

### Event Format

Every write is a single event type:

```
cell.update {
  table_id: string,
  row_id: string,
  column_id: string,
  value: any,
  timestamp: <logical or server timestamp>
}
```

This event is sent as an encrypted Matrix timeline event within the workspace room. The LWW merge rule is trivial: for any given `(table_id, row_id, column_id)`, the value with the highest timestamp wins.

## Cold Start and Compaction

### The Problem

To materialize a table from cold start, the client needs to walk backward through the room's event timeline, collecting the most recent value for each cell. Naively, this could require traversing the entire room history.

### The Solution: Order-Based Bumping

Every time a client writes a new `cell.update`, it also **bumps the stalest cell** — re-emitting the current value of the oldest un-bumped cell as a new event.

This bounds the lookback window to approximately the number of cells in the table, regardless of how long the room has existed or how many historical events it contains.

The mechanism is self-regulating:

- **Active tables** receive frequent writes, so cells get bumped frequently, keeping the lookback window tight.
- **Inactive tables** don't receive writes, but they also don't need bumping — nothing has changed, so the existing values in the timeline are still current.
- **No coordination required** — whichever client happens to write next bumps one cell as a side effect.
- **No special event types** — a bump is just a regular `cell.update` with the same value. The single code path stays single.

### Deletion as Natural Decay

Deleting a row or column requires no tombstone event. The client simply **stops bumping** cells belonging to the deleted row/column. Over time, as other cells continue to be bumped forward, the deleted cells drift deeper into the timeline history, past the lookback window, and become effectively inaccessible.

If a stale client bumps a deleted cell before it syncs the deletion, it doesn't matter — other clients will simply ignore the cell when materializing the table, because the row/column no longer exists in the schema table.

This also has a privacy benefit: in an E2E encrypted system, Megolm keys for old sessions may have been rotated, making deleted data practically unrecoverable over time.

## Client Architecture

A three-layer stack:

### 1. `tables-over-matrix` — Pure Rust Library

The foundational layer. Handles:

- Matrix SDK integration (connection, sync, event send/receive)
- E2E encryption (via the Matrix Rust SDK's Megolm implementation)
- LWW cell resolution and table materialization
- Bump/compaction logic
- Cold start timeline traversal

This is a standalone, reusable library. It knows nothing about UI or application-specific semantics. Anyone who wants encrypted collaborative tables over Matrix could use it.

### 2. App Core — Rust

Depends on `tables-over-matrix`. Adds application-specific logic:

- System table conventions (schema table, views table, tables-of-tables)
- Workspace semantics
- View definition interpretation
- Exposes a clean API to the UI layer

Both Rust layers compile to **WebAssembly** for browser deployment. The Matrix Rust SDK has WASM support.

### 3. UI — JavaScript/TypeScript

A thin view layer that takes materialized table data and renders it as interactive views (kanban, calendar, task list, data table). Built with a standard JS framework (React, Svelte, etc.).

The JS layer communicates with the WASM core across the wasm-bindgen bridge. Data crosses the boundary as serialized JSON — the Rust side uses serde to serialize table state into JS objects.

The reactivity boundary uses a **pull model with change notifications**: the Rust core emits lightweight "table X changed" events, and the JS layer subscribes and re-fetches materialized table state when notified. A React hook like `useTable("tasks")` would encapsulate this pattern.

The WASM core should run in a **web worker** to avoid blocking the UI thread during sync bursts, decryption, or large table materializations.

If a native desktop app is desired later, the Rust core can be wrapped in **Tauri** (which uses the OS native webview rather than bundling Chromium), with the same JS UI layer on top. The Rust-to-JS bridge in Tauri is similar to the WASM bridge, so migration would be straightforward.

## Authentication

The app is a Matrix client, so authentication is Matrix authentication.

### Primary Flow: SSO with Email/Password Fallback

- **SSO/OIDC**: Matrix supports OpenID Connect. The Matrix Rust SDK handles the full OAuth flow — generating a login URL, opening it in the user's browser, receiving a login token at a redirect URI, and completing login.
- **Email/password fallback**: Standard Matrix username/password authentication for users or servers that don't support OIDC.
- **Custom homeserver support**: Users can point the app at any Matrix homeserver — `matrix.org`, a corporate Synapse/Conduit instance, or a managed hosting provider.

Privacy-respecting identity providers are front-loaded where possible. Proton does not currently act as an OIDC identity provider for third-party apps (it's a requested feature), so the most practical approach is to lean on the Matrix identity itself and support generic OIDC so teams can plug in their own IdP.

### Session Persistence

The Matrix Rust SDK supports session persistence via access tokens and refresh tokens:

1. User authenticates once (SSO or password).
2. The SDK returns a session (access token, refresh token, device ID).
3. The app persists this session locally.
4. On subsequent launches, `restore_session` re-establishes the connection without re-entering credentials.
5. Token refresh happens silently via the SDK.

The crypto store (an SQLite database with optional passphrase encryption) must also be persisted — it contains the Olm/Megolm keys needed to decrypt workspace history.

## Federation

Federation is a first-class feature inherited from Matrix at zero implementation cost.

- A user on any homeserver can be invited to any workspace by their Matrix ID (e.g., `@alice:company.com`).
- Homeservers handle federation negotiation and encrypted key exchange automatically.
- Megolm key sharing happens at the client level, not the server level, so federation does not complicate E2E encryption.
- Teams can self-host for full data sovereignty and still collaborate with external users on other servers.

Federated events have slightly higher latency (an extra server hop), but for LWW cell updates this is negligible.

## Summary

| Concern | Approach |
|---|---|
| Data model | LWW cells in tables; everything is a table |
| Transport & storage | Matrix protocol (single room per workspace) |
| Encryption | Megolm (via Matrix), E2E by default |
| Sync | Matrix sync API |
| Conflict resolution | Last-Write-Wins per cell |
| Compaction | Order-based bumping; lookback bounded by table size |
| Deletion | Natural decay (stop bumping) |
| Client core | Rust compiled to WASM |
| UI | Thin JS/TS layer (React/Svelte) |
| Auth | SSO (OIDC) with email/password fallback |
| Federation | Free via Matrix; any homeserver participates |
| Business model | Open-source core + enterprise contracts |

## Development Architecture and Practices

### Test-Driven Development

The three-layer architecture (tables-over-matrix → app core → UI) maps cleanly onto a TDD workflow because each layer has well-defined inputs and outputs with minimal side effects.

#### `tables-over-matrix` (Pure Rust Library)

This is the most testable layer and should have the highest test coverage. The core logic — LWW resolution, table materialization, bump selection, cold start traversal — is pure functions over data structures with no network or UI dependencies.

Key test areas:

- **LWW resolution:** Given a stream of `cell.update` events with various timestamps and orderings, assert that the materialized table always converges to the correct state. Property-based testing (via `proptest` or `quickcheck`) is ideal here — generate random event sequences, apply them in random orders, and assert convergence.
- **Bump selection:** Given a materialized table with known cell ages, assert that the bump mechanism selects the correct (stalest) cell. Assert that after N writes with bumps, the lookback window is bounded by table size.
- **Cold start:** Given a room timeline (mocked as a vector of events), assert that backward traversal correctly populates the table and terminates at the right point. Test with gaps, duplicates, and out-of-order events.
- **Deletion decay:** Assert that cells belonging to deleted rows/columns are excluded from materialization and bump selection. Assert that bumped deleted cells are harmlessly ignored.
- **Schema-as-table:** Assert that schema changes (column add, rename, delete) propagate correctly when schema is stored as cells in a system table.

These tests should run without any Matrix homeserver. Mock the event stream as simple in-memory vectors. The Matrix SDK integration is a thin adapter that translates sync responses into the internal event representation — test that adapter separately with recorded/mocked sync payloads.

#### App Core (Rust)

This layer interprets system table conventions and exposes workspace semantics. Tests here validate that:

- Creating a new table results in the correct rows in the system tables (schema table, tables-of-tables).
- View configurations are correctly stored and retrieved.
- Cross-table references resolve correctly.
- The API surface exposed to the UI layer returns correctly shaped data.

Use integration-style tests that spin up an in-memory `tables-over-matrix` instance (no network) and exercise the app core through its public API.

#### UI (JavaScript/TypeScript)

The UI layer is a thin projection over materialized tables. Test with standard frontend testing tools:

- **Unit tests** for view projection logic: given a table and a kanban view config, assert correct column grouping. Given a table and a calendar view config, assert correct date indexing.
- **Component tests** for interactive behavior: dragging a kanban card dispatches the correct `cell.update` call to the WASM bridge. Inline editing commits the correct value.
- **E2E browser tests for what only a browser can prove.** *(Updated from the
  original "none initially" stance.)* A two-browser Playwright harness
  (`ui/e2e/`) drives the real compiled WASM against a throwaway Conduit for the
  flows unit tests structurally cannot cover: crypto onboarding (recovery, SAS
  verification), the core product journey, and reload persistence. Unit tests
  still carry the volume; the harness carries the integration truth — it has
  repeatedly caught real bugs that the mock-based unit suite passed.

### Integration and Matrix-Level Testing

For testing actual Matrix interactions, maintain a lightweight test harness that can spin up a local homeserver. Conduit is a good choice here — it's a single-binary Rust homeserver that starts in milliseconds and requires no external databases.

Test scenarios:

- **Two-client sync:** Client A writes a cell, client B receives it via sync and materializes the correct value.
- **Conflict resolution:** Two clients write to the same cell concurrently, both converge to the same winner.
- **Cold start from real timeline:** Client A populates a table, client B joins the room and materializes from history.
- **Encryption round-trip:** Cell events are encrypted on send, decrypted on receive, and materialize correctly.
- **Federation (stretch goal):** Two local homeservers federate, clients on each server can collaborate on the same workspace.

These tests are slower and should be gated behind a flag (e.g., `cargo test --features integration`). They do not run on every commit during active development, but should run in CI on every merge.

### Project Structure

```
project-root/
├── crates/
│   ├── tables-over-matrix/     # Pure Rust library
│   │   ├── src/
│   │   │   ├── cell.rs          # Cell type, LWW resolution
│   │   │   ├── table.rs         # Table materialization
│   │   │   ├── compaction.rs    # Bump selection and execution
│   │   │   ├── coldstart.rs     # Timeline traversal for cold start
│   │   │   ├── matrix.rs        # Matrix SDK adapter (thin)
│   │   │   └── lib.rs
│   │   └── tests/               # Unit + Conduit integration (harness.rs
│   │       │                    #   spins up a throwaway homeserver)
│   │       ├── lww_properties.rs
│   │       ├── compaction.rs
│   │       ├── coldstart.rs
│   │       └── two_client_sync.rs
│   │
│   └── app-core/                # Application semantics
│       ├── src/
│       │   ├── workspace.rs     # Workspace lifecycle
│       │   ├── schema.rs        # System table conventions
│       │   ├── views.rs         # View config interpretation
│       │   ├── bridge.rs        # wasm-bindgen surface (local-only)
│       │   ├── bridge_matrix.rs # wasm-bindgen surface (Matrix-connected)
│       │   └── lib.rs
│       └── tests/
│           └── workspace_matrix.rs  # Conduit integration
│
├── ui/                          # JS/TS frontend
│   ├── src/
│   │   ├── hooks/
│   │   │   └── useTable.ts      # Reactive bridge to WASM core
│   │   ├── cells/               # Typed cell registry (grid + entry editors)
│   │   ├── views/
│   │   │   ├── table/
│   │   │   ├── kanban/
│   │   │   ├── card/
│   │   │   └── entry/
│   │   └── App.tsx              # (component tests live alongside sources)
│   └── e2e/                     # Two-browser Playwright harness (real WASM
│                                #   + live Conduit)
│
└── Cargo.toml                   # Workspace manifest
```

*(Integration tests live under each crate's `tests/` directory, not a
top-level `tests/`; browser E2E lives in `ui/e2e/`.)*

### CI Pipeline

A two-stage pipeline optimized for fast feedback:

**Stage 1 — Fast (every commit, <60s):**
- `cargo check` and `cargo clippy` for compile errors and lint.
- `cargo test` for all unit and property tests in `tables-over-matrix` and `app-core`.
- JS/TS lint and unit tests for view projection logic.
- WASM build verification (ensure it compiles to WASM cleanly).

**Stage 2 — Full (every merge to main, ~5min):**
- Everything in Stage 1.
- Integration tests with a local Conduit instance.
- Encryption round-trip tests.
- Basic smoke test of the full stack (WASM + UI) in a headless browser.

### Error Handling Strategy

Rust's type system is your ally. Use it aggressively:

- **`Result<T, E>` everywhere** in the library layers. No panics in `tables-over-matrix` or `app-core`. The UI layer is the only place that should handle errors (by displaying them to the user).
- **Custom error types** per crate using `thiserror`. `tables-over-matrix` errors should distinguish between Matrix SDK errors (network/auth), decryption errors, and data integrity errors (malformed events).
- **Graceful degradation for malformed events.** If a `cell.update` event can't be deserialized, log it and skip it. Don't crash the materialization of the entire table because one event is bad. This is important because in a federated system you may receive events from buggy or malicious clients.

### Logging and Observability

Use `tracing` (the Rust ecosystem standard) throughout both Rust crates. Structure logs around operations that matter for debugging:

- Sync cycle: events received, events processed, time elapsed.
- Table materialization: cells populated, lookback depth, time elapsed.
- Compaction: which cell was bumped, current staleness distribution.
- Errors: deserialization failures, decryption failures, Matrix SDK errors.

In the WASM context, `tracing` can be wired to the browser console via `tracing-wasm`. This gives you structured, filterable logs in the browser devtools during development.

### Versioning and Migration

Since your data model is "everything is cells in tables," schema evolution is relatively simple — you're not migrating a relational database, you're just changing conventions about what system table rows mean.

However, you still need to version:

- **Event format.** If the shape of a `cell.update` event changes, old clients need to handle new events gracefully and vice versa. Include a version field in the event content from day one. Never remove fields, only add. Old clients ignore fields they don't understand.
- **System table conventions.** If you add a new system table (e.g., a permissions table) or add columns to the schema table, old clients need to not break when encountering unknown system tables or columns. The "everything is tables" model handles this naturally — unknown tables are just tables the client doesn't know how to render.
- **WASM-JS bridge API.** Semantic versioning on the bridge API so the JS layer can detect mismatches if the WASM module and JS layer are deployed out of sync.

### Security Considerations

Beyond the encryption provided by Matrix/Megolm:

- **Input validation at the WASM boundary.** Never trust data coming from the JS layer. Validate all parameters before passing them to the Rust core.
- **Input validation on received events.** Never trust events from other clients. Validate structure, check for absurd values (negative timestamps, impossibly large table IDs), and discard malformed events gracefully.
- **No secrets in WASM memory.** WASM memory is inspectable. The Matrix Rust SDK handles sensitive crypto material, but be aware that any data passing through the bridge is potentially observable. This is inherent to the browser environment and not specific to your app.
- **CSP headers.** If serving the app as a web page, use strict Content Security Policy headers to prevent XSS. The thin JS layer and WASM core reduce the attack surface compared to a fully JS app.

### Documentation

For a solo developer, over-documentation is wasted effort. Focus on:

- **README per crate** with a one-paragraph summary, build instructions, and example usage.
- **Doc comments on public API surfaces.** Every public function and type in `tables-over-matrix` and `app-core` should have a doc comment explaining what it does, not how it works. The tests demonstrate how it works.
- **Architecture decision records (ADRs)** for non-obvious choices: why single room per workspace, why LWW over other CRDTs, why order-based bumping over time-based. These are for your future self when you've forgotten the reasoning. Short, one-page-per-decision format.
- **The architecture writeup** (i.e., this document and its companion) is the living design doc. Update it as the design evolves.
