# Architecture & "Bones" Review — secure-collab-app

**Review date:** 2026-06-07
**Reviewed at:** `main` @ `ce8c8dd` (23 commits; first commit 2026-03-09, last 2026-03-11)
**Scope:** Whole-project structural review, focused on architectural cohesion and load-bearing foundations ("bones") rather than line-level polish.
**Method:** Full read of both Rust crates (`tables-over-matrix`, `app-core`), both WASM bridges, the UI reactivity layer, the integration harness, and CI. ~123 Rust test functions and the TS test suite were inspected, not executed (no Nix/Linux toolchain on the review host).

---

## 1. Executive summary

This is an unusually **coherent skeleton for a young (3-day) codebase**. The central architectural bet — *"everything is a table of LWW cells, with one event type and one code path"* — is not just slideware; it is actually implemented end to end. Schema definitions and view configurations really are stored as `CellUpdate`s in system tables (`_tables`, `_schema`, `_views`) and really do reconstruct through the same `apply_update` path as user data. The layering (pure library → app semantics → WASM bridge → thin React UI) is clean, the feature-flag matrix is disciplined, and test coverage on the pure layers is genuinely good.

But the **load-bearing bones have three structural cracks**, all in the gap between "the pure logic is correct" and "the distributed system is correct":

1. **The LWW clock is a local logical counter that is never synchronized, advanced on receive, or persisted.** This breaks convergence between clients and causes silent data loss after a page reload. This is the single most important issue in the codebase. (§4.1)
2. **End-to-end encryption — the product's entire reason to exist — is not actually turned on.** Rooms are created unencrypted and cell events are sent as plaintext, while the UI displays a "🔒 E2E Encrypted" badge. (§4.2)
3. **Order-based bumping (the marquee compaction mechanism) is implemented and unit-tested but not wired into the write path.** Cold-start is therefore unbounded in practice. (§4.3)

None of these are deep design flaws — the *design* anticipated all three (the `Cell` type even has a `server_timestamp` tiebreaker slot waiting to be filled). They are **integration gaps**: correct components that were never connected. That is the recurring theme of this review. The bones are good; several joints are not yet load-bearing.

**Overall verdict:** Architecturally sound foundation, prototype-grade integration. Safe to keep building on; **not** safe to put real data in yet.

---

## 2. The skeleton — what the bones actually are

```
crates/tables-over-matrix/   Pure Rust: Cell, Table, LWW, compaction, cold-start, Matrix adapter
   └─ cell.rs / table.rs / compaction.rs / coldstart.rs / matrix.rs (feature-gated)
crates/app-core/             Semantics: Workspace, SchemaManager, ViewManager + two WASM bridges
   └─ workspace.rs / schema.rs / views.rs / bridge.rs / bridge_matrix.rs
ui/                          React/TS: hooks (useWorkspace/useTable), views, auth, components
```

Two things make this a real architecture and not just folders:

- **The single-code-path invariant holds.** `Workspace::apply_update` (`workspace.rs:167`) is the one funnel: it routes a `CellUpdate` to a user table, the schema manager, or the view manager purely by inspecting `table_id`. The replay tests (`workspace.rs:857`–`1039`) prove a fresh workspace can rebuild tables, schema, *and* views from nothing but a stream of `CellUpdate`s, including out-of-order arrival. This is the promise of the architecture, and it is kept.
- **The layers are honestly separated.** `tables-over-matrix` has no UI or app knowledge; `app-core` adds conventions; the bridge is a thin serialization shell. The Matrix dependency is feature-gated (`matrix` / `matrix-wasm` / `matrix-native`) so the pure logic compiles and tests without ever pulling the SDK.

This separation is the project's biggest asset. Everything below is fixable *because* of it.

---

## 3. Where the bones are solid

| Area | Evidence | Why it matters |
|---|---|---|
| Core data model | `cell.rs`, `table.rs` | Small, allocation-conscious, well-tested LWW primitives. |
| "Everything is tables" | `schema.rs`, `views.rs` route through system tables | The unifying idea is real, not aspirational. |
| Replay / reconstruction | `workspace.rs:857`+ | Schema + views rebuild from the event stream; out-of-order handled. |
| Wire-format pragmatism | `matrix.rs:75`–`109` | Cell values are JSON-string-encoded to dodge Matrix Canonical JSON's float prohibition — a real, documented decision with float/object round-trip tests. |
| Forward-compat | `version` field on `CellUpdate` from day one (`cell.rs:97`) | Old clients ignore unknown fields; matches the doc's versioning policy. |
| Feature-flag hygiene | `Cargo.toml` features split native/wasm store backends | Clean separation of `sqlite` (tests) vs `indexeddb` (browser). |
| CI breadth | `.github/workflows/ci.yml` | fmt + clippy `-D warnings` + per-feature unit tests + doctests + WASM build + UI typecheck/lint/test/build + Nix-gated Conduit integration + Pages deploy. Mature for the age. |
| UI reactivity | `useTable.ts` | Optimistic writes, pending-mutation guards, and a deliberately **data-free** cross-tab `BroadcastChannel` (no plaintext leaves the decrypting tab) — security-aware design. |

---

## 4. Where the bones are cracked (load-bearing)

### 4.1 — 🔴 Critical: the LWW clock is local, unsynchronized, and amnesiac

> **Status (2026-06-07): fixed & verified locally** — hybrid logical clock + `origin_server_ts` tiebreaker. Pure-logic tests green, stable `clippy -D warnings` clean, and the `wasm32 + matrix-wasm` build compiles (so the Matrix/wasm receive paths are confirmed, not just the pure layer). See `TODO.md` §4.1. The analysis below is the original finding.

**This is the most important finding in the review.**

Timestamps come from a per-instance counter that starts at 0 and only increments on local writes:

```rust
// workspace.rs:55
fn next_timestamp(&mut self) -> u64 { self.timestamp_counter += 1; self.timestamp_counter }
```

`apply_update` (used for *all* remote events, via both bridges' sync loops) **never advances this counter**, and `Workspace::new` always starts it at 0. There is no Lamport-style "advance to max(seen)+1 on receive," no wall-clock, and no persistence. Three consequences follow, in increasing severity:

1. **"Last-Write-Wins" actually means "highest-local-edit-count-wins."** A client that has made 50 edits writes at ts≈50; a client that just joined writes at ts≈1. The busy client clobbers the newcomer's *more recent* edit every time. The intended semantic (latest in wall-clock time wins) is inverted.
2. **Exact ties diverge permanently.** Two fresh clients each making their first edit to the same cell both emit ts=1. On a tie, `Cell::resolve_lww` (`cell.rs:56`) falls back to "whichever was applied last locally wins" (`server_timestamp` is `None` — see below). Client A ends up showing B's value and B shows A's. They never reconcile. For a CRDT system whose whole point is convergence, this is a foundational break.
3. **Silent data loss after every reload (single user, single device).** On reload the counter resets to 0. Cold-start (`bridge_matrix.rs:441`) replays history through `apply_update` **without seeding the counter**. The user's next edit to any existing cell gets ts=1, which loses the LWW comparison against that cell's historical timestamp — so the edit is applied optimistically in React, then silently reverted on the next read/sync. Editing existing data is broken after a refresh; only brand-new rows survive.

**Why the test suite doesn't catch it:** every convergence test hand-picks distinct, globally-ordered timestamps (`100` vs `200` in `two_client_sync.rs:54` and `workspace_matrix.rs:757`) or writes to *different* cells (`workspace_matrix.rs:668`). None exercises the timestamps the app actually generates via `next_timestamp_pub()`. The production clock path is effectively untested.

**The fix is half-scaffolded already.** `Cell` has a `server_timestamp` tiebreaker field (`cell.rs:35`) and `ReceivedCellUpdate` already captures `origin_server_ts` (`matrix.rs:172`) — but the conversion drops it (`matrix.rs:150`, `into_cell()` sets `None`), and both sync loops discard it (`bridge_matrix.rs:463`, `:513`). Recommended direction: adopt a **hybrid logical clock** — derive the write timestamp from `max(wall_clock_ms, last_seen_logical + 1)`, advance it on every received event, and use Matrix's `origin_server_ts` as the deterministic tiebreaker (plumb it into `Cell::server_timestamp`). At minimum, seed the counter from cold-start history before accepting the first local write.

---

### 4.2 — 🔴 Critical: E2E encryption is claimed but never enabled

The product is "genuine E2E encryption, auditable not marketing." The Matrix SDK is compiled with `e2e-encryption`, the crypto store is configured, and the UI shows a lock badge (`Sidebar.tsx:320`, `SignInPage.tsx:193`). But **no code ever enables encryption on a room.** A grep for `encrypt` / `m.room.encryption` / `EncryptionSettings` finds only docs, marketing copy, the SDK feature flag, and the UI badge — zero call sites.

`create_room` (`bridge_matrix.rs:147`) creates a `PrivateChat` room and tags it with a workspace marker, but never sends an `m.room.encryption` state event.

**Encryption is not a Matrix protocol default** — it is opt-in *per room*, activated only when that state event exists. (Consumer clients like Element enable it on new DMs as a *client* policy; room presets such as `PrivateChat` control join rules/history visibility, not encryption.) The SDK's `room.send()` *would* encrypt automatically **if** the room were encrypted — so the missing piece is the state event plus a send-time guard, not crypto code. Because the app never sets it, `room.send(content)` (`bridge_matrix.rs:736`) ships every cell update as **plaintext** on a default homeserver, and the "single room per workspace = only metadata leaks" privacy argument (`architecture.md:54`) collapses.

The precise criticism is sharper than "rooms are unencrypted": **the app silently inherits whatever the homeserver defaults to.** The lone exception is Synapse's `encryption_enabled_by_default_for_room_type`, which an admin can set to auto-inject the encryption event — but it is off by default, Synapse-specific (Conduit, the repo's recommended test server, has no equivalent), and this app explicitly targets *any* homeserver. Depending on an unknown server's admin config for your headline security property is the worst kind of guarantee for a security product: silent and environment-dependent.

`BUILD_STATUS.md` is honest about this ("No actual encryption flow yet"), but `README.md` and the running UI assert the opposite. The app currently tells users their data is end-to-end encrypted when, on a default server, it is not. Until §4.2 is closed, the encryption badge should be removed or gated behind a real capability check.

Fix is small in code — set encryption at room creation **and verify the room is encrypted before sending any cell update** (don't trust the server to have done it) — but large in consequence: it must be paired with device verification and key backup before launch.

---

### 4.3 — 🟠 High: order-based bumping is built but unplugged

Compaction-by-bumping is a headline of the design and the answer to bounded cold-start. The library implements it well (`compaction.rs`, `generate_updates_with_bump`) and tests it. But the actual write paths don't call it:

- `Workspace::update_cell` (`workspace.rs:145`) emits a single `CellUpdate` — no bump.
- `ConnectedWorkspace::update_cell` (`bridge_matrix.rs:599`) does the same.
- The `compaction_manager` field is literally `#[allow(dead_code)]` (`workspace.rs:25`), and `CompactionManager::last_bump` is recorded but never read.

So in the running system, **nothing is ever bumped**, and cold-start (`bridge_matrix.rs:441`) paginates the *entire* room history every time. The mechanism that makes the architecture scale is inert. (Schema/view system tables live in separate managers outside the `tables` map, so they wouldn't be bumped even if user tables were — a secondary gap to design for.)

---

### 4.4 — 🟠 High: two divergent cold-start implementations

`coldstart.rs` ships two materializers with **different correctness models**:

- `materialize_from_timeline` (`coldstart.rs:23`) applies every event and relies on `Table`'s LWW — order-independent and correct, but its `events_processed`/`events_skipped` accounting is arrival-order-dependent and effectively meaningless when events arrive oldest-first.
- `TimelinePaginator` (`coldstart.rs:89`) uses *first-seen-wins* and **assumes events arrive strictly newest-first** (it ignores any already-seen cell, even a newer one). That invariant happens to hold for Matrix backward pagination, but it is undocumented and unenforced at the type level — and neither of these is the path actually used in production.

Meanwhile the real cold-start (`bridge_matrix.rs:445`) is a *third*, hand-rolled pagination loop that uses neither helper. Three implementations of one concept, with subtly different semantics, is a cohesion smell that will bite during the next refactor. Pick one (the order-independent one), make the newest-first assumption explicit where it's relied on, and route the bridge through it.

---

### 4.5 — 🟡 Medium: the receive path is under-tested end to end

The integration tests send through Matrix but then **manually** `apply_update` the same struct locally and assert on that (e.g. `workspace_matrix.rs:706`), rather than letting the `start_sync` loop deliver, extract, and materialize the event. The genuinely distributed path — sync response → `extract_cell_update` → `apply_update` → `on_change` → React re-read — is never asserted against. Combined with §4.1, the result is that the system's two hardest properties (convergence and real sync delivery) are the two least-tested.

---

## 5. Structural / cohesion smells (lower severity)

- **Generated artifacts share a directory with a hand-written file.** `wasm-pack` outputs into `ui/src/wasm/`, which also contains the hand-maintained `loader.ts`; CI has to `git checkout -- ui/src/wasm/loader.ts` after every build (`ci.yml:133`) to undo the clobber. Move generated output to its own dir (e.g. `ui/src/wasm/generated/`) so the hand-written loader isn't in the blast radius.
- **UI is tested against a reimplementation, not the real core.** `MockWorkspace` (`test/mockWorkspace.ts`) is a hand-written TS clone of the bridge that explicitly notes "LWW semantics aside — later writes simply overwrite." It's a reasonable fast-test seam, but it can (and given §4.1, does) mask divergence between the mock and the real Rust bridge. Add at least one test that drives the *actual* compiled WASM.
- **Dead/duplicated logic.** `CompactionManager::last_bump` is written but never read; `compaction::calculate_lookback_window` (`compaction.rs:75`) and `coldstart::estimate_lookback_window` (`coldstart.rs:71`) compute the same thing two ways.
- **`next_timestamp_pub`** exists only to let the bridge reach around the abstraction (`workspace.rs:61`) — a sign the timestamp responsibility lives in the wrong layer (see §4.1 fix).

---

## 6. Documentation ↔ reality drift

The docs were written at the initial commit and the code has outpaced them. This matters for a project whose pitch is "auditable trust."

| Doc claim | Reality |
|---|---|
| `architecture.md:251` shows integration tests in a top-level `tests/` dir | They live under `crates/*/tests/`; no top-level `tests/` exists. |
| `BUILD_STATUS.md`: "48 tests", "Matrix is scaffolded but not implemented", "UI is basic demo" | ~123 Rust tests; Matrix auth/rooms/sync/invites/registration are substantially implemented; UI has auth, multiple views, workspaces. The file is ~3 months and many features stale. |
| `README.md` Features: "All data is encrypted using Megolm" + UI lock badge | Encryption is not enabled (§4.2). README roadmap *also* lists "Implement actual E2E encryption flow" as unchecked — the README contradicts itself. |
| `architecture.md`: order-based bumping bounds lookback | Bumping is not wired into writes (§4.3). |
| `architecture.md`: "No panics in libraries" | Largely upheld in `tables-over-matrix`/`app-core`; the bridges use `unwrap_or_else`/`?` cleanly. Good — just keep it true. |

Recommend collapsing `BUILD_STATUS.md` + `docs/SESSION_SUMMARY.md` into a single dated STATUS doc, and either making the encryption claim true or removing it everywhere until it is.

---

## 7. Prioritized recommendations

**Must-fix before any real data (correctness & trust):**
1. **Fix the clock (§4.1).** Hybrid logical clock + advance-on-receive + seed from cold-start; plumb `origin_server_ts` into `Cell::server_timestamp` as the tiebreaker. Add a convergence test that uses the *real* `next_timestamp` path and a same-counter tie.
2. **Make encryption real or stop claiming it (§4.2).** Enable room encryption at creation, refuse to send into an unencrypted room, and remove the "E2E Encrypted" UI badge until verification + key backup exist.

**Should-fix to make the architecture deliver its promises:**
3. **Wire bumping into the write path (§4.3)** and decide how system tables get compacted.
4. **Unify cold-start to one implementation (§4.4)** and route the bridge through it.
5. **Add a true end-to-end sync test (§4.5)** driving the real sync loop, plus one UI test against compiled WASM.

**Housekeeping (cheap, high signal-to-noise):**
6. Separate generated WASM output from `loader.ts` (§5).
7. Remove dead state and duplicated lookback helpers (§5).
8. Re-baseline the docs; fix the README's internal contradiction on encryption (§6).

---

## 8. One-paragraph takeaway

The architecture is the strongest thing here: a genuinely unified data model, clean layering, and a thoughtful build/test pipeline that most 3-day-old projects never reach. What's missing is the conversion from "the pieces are individually correct" to "the distributed system is correct" — the clock isn't synchronized, the encryption isn't switched on, and the compaction isn't plugged in. All three were anticipated by the design and are integration tasks, not redesigns. Close §4.1 and §4.2 and this goes from impressive prototype to credible foundation.
