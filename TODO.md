# Project TODO / Backlog

Single source of truth for outstanding work. Supersedes the (stale) roadmap in `README.md`.
Most items trace to **[ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)** — section refs in brackets.

Priority bands:
- **P0 — Must-fix before real data** (correctness & trust)
- **P1 — Should-fix** (make the architecture deliver its promises)
- **P2 — Housekeeping** (cheap, high signal-to-noise)
- **FE — Frontend / Table UX**

---

## P0 — Must-fix before any real data

- [x] **Fix the LWW clock** — `[§4.1]` — _implemented & verified locally 2026-06-07 (stable 1.96 + nightly 1.98): pure-logic tests green (21 + 57), stable `clippy -D warnings` clean, `wasm32 + matrix-wasm` build compiles, `fmt` clean._
  The timestamp was a local counter starting at 0, never advanced on receive, never persisted. Caused cross-client divergence and **silent data loss after reload**.
  - [x] Hybrid logical clock: write ts = `max(last_seen + 1, wall_clock_ms)` (`workspace.rs` `next_timestamp` + `now_millis`).
  - [x] Advance the clock on **every** applied update — `observe_timestamp` in `Workspace::apply_update`, which both sync loops call (`bridge_matrix.rs`).
  - [x] Seed the counter from cold-start history (falls out of `observe_timestamp`; cold-start replays through `apply_update`).
  - [x] Plumb Matrix `origin_server_ts` into `Cell::server_timestamp` (wire-skipped `CellUpdate::server_timestamp` + `with_server_timestamp` + `ReceivedCellUpdate::into_update`; both bridge receive paths now call `into_update()`).
  - [x] Unit tests: post-replay write wins (`test_write_after_replay_wins_over_loaded_history`), monotonic-within-ms, order-independent tie-break by server ts (`test_lww_tiebreak_by_server_timestamp_is_order_independent`), wire omits server ts.
  - [ ] **Follow-up:** full two-client end-to-end convergence assertion via the real sync loop — folded into the `[§4.5]` e2e sync test (needs Conduit/WSL).

- [~] **Make E2E encryption real — or stop claiming it** — `[§4.2]` — _enablement + guard + honest badge implemented & compile-verified 2026-06-07 (wasm32 + matrix-wasm build green). NOT yet round-trip-tested against a real encrypted homeserver — see caveats below._
  - [x] Enable encryption at room creation — `room.enable_encryption()` in `ConnectedWorkspace`'s `createRoom`; creation fails loudly if it can't be turned on.
  - [x] **Fail-closed send guard** — `send_updates` refuses to emit cell updates unless `room.encryption_state().is_encrypted()` (don't trust the server default). Placed at the bridge boundary only, so the native integration harness (unencrypted test rooms) is unaffected.
  - [x] **Honest badge** — new `ConnectedWorkspace::isEncrypted()` bridge method; `Sidebar` now shows "E2E Encrypted" only when the room really is, and a red "Not encrypted" warning otherwise (instead of a hard-coded claim).
  - [ ] **Verify an encrypted round-trip** (send → sync → cold-start replay) against Conduit — the read path relies on the SDK auto-decrypting `raw().json()`; confirmed by docs, not yet by test. Needs the integration harness (WSL/Docker + Conduit). Fold into `[§4.5]`.
  - [ ] Cross-device key sharing / **device verification + cross-signing + key backup** — required before launch (currently keys are shared with unverified devices by default: functional, not verified-secure). Larger design effort; still open.
  - [ ] Decide policy for **legacy unencrypted rooms** (created before this change): the guard makes them read-only. Offer a migrate/recreate path or a clear UI state.

---

## P1 — Should-fix (deliver the architecture's promises)

- [ ] **Wire order-based bumping into the write path** — `[§4.3]`
  `CompactionManager` is implemented + tested but never called; the field is `#[allow(dead_code)]` (`workspace.rs:25`). Nothing is ever bumped, so cold-start paginates full history.
  - [ ] Emit a bump alongside each user write (`generate_updates_with_bump`).
  - [ ] Decide how system tables (`_schema`/`_views`, held outside `tables`) get compacted.
  - [ ] Remove dead `last_bump` tracking or actually use it.

- [ ] **Unify cold-start to one implementation** — `[§4.4]`
  Three materializers exist: `materialize_from_timeline` (order-independent), `TimelinePaginator` (assumes newest-first), and the bridge's hand-rolled loop (`bridge_matrix.rs:445`).
  - [ ] Keep the order-independent one; route the bridge through it.
  - [ ] Make the "newest-first" assumption explicit where relied on; fix the misleading processed/skipped accounting.

- [ ] **Add a true end-to-end sync test** — `[§4.5]`
  Integration tests manually `apply_update` rather than letting the sync loop deliver events (`workspace_matrix.rs:706`), so the real receive path is unasserted.
  - [ ] Drive an actual `start_sync` round-trip (send on A → sync delivers to B → assert B's materialized state).
  - [ ] Add at least one UI test against compiled WASM (not just `MockWorkspace`).

---

## FE — Frontend / Table UX

- [ ] **Migrate the table view to TanStack Table v8 + TanStack Virtual** — replaces the hand-rolled `<table>` in `TableView.tsx`
  Current grid re-implements column model/editing while missing virtualization, typed editors, and working sort/filter; only `select` is treated as typed (everything else is a stringified text input, `TableView.tsx:172`).
  - [ ] Add deps: `@tanstack/react-table`, `@tanstack/react-virtual` (both MIT — no licensing friction with open-core).
  - [ ] **Build one per-type cell registry** `{type → {Display, Editor}}` for all column types (text, number, boolean, date, select, multiselect, reference, document, json), reused by **both** the grid and the EntryView — kills the `TableView` ⇄ `FieldRenderer` duplication.
  - [ ] Map `schema.columns → ColumnDef[]` (carry options + reference target).
  - [ ] Replace the raw `<table>` with TanStack + row/column virtualization (target: 5k+ rows scroll smoothly).
  - [ ] **Commit on blur/Enter with debounce** → exactly one `CellUpdate` (one `room.send`) per logical edit. Fixes the current per-keystroke write that triggers 429 rate-limits (`TableView.tsx:208`, `:62`).
  - [ ] Wire real sort + filter (the toolbar buttons are currently dead, `TableView.tsx:120`).
  - [ ] Reconcile optimistic React state with LWW rejection so writes can't flash-then-revert (relates to `[§4.1]` and `[§5]`).
  - [ ] Column resize / reorder / visibility (free with TanStack — optional polish).
  - [ ] Tests: per-type editors render + commit correctly; ≤1 update per committed edit.

  *Alternative considered:* AG Grid (batteries-included, but key features are paid Enterprise — awkward for an auditable open-core). Glide Data Grid (canvas) noted for a future high-volume data view.

- [ ] **Flesh out placeholder field editors** — `multiselect` is a comma string and `reference` is a plain text input (`FieldRenderer.tsx:133`, `:148`); add a tag input and a real reference/record picker. (Folds into the cell registry above.)

---

## P2 — Housekeeping

- [ ] **Separate generated WASM output from hand-written code** — `[§5]`
  `wasm-pack` clobbers `ui/src/wasm/`, forcing CI to `git checkout -- ui/src/wasm/loader.ts` (`ci.yml:133`). Output to `ui/src/wasm/generated/`.
- [ ] **Remove dead/duplicated logic** — `[§5]` `CompactionManager::last_bump`; `calculate_lookback_window` vs `estimate_lookback_window`; `next_timestamp_pub` leak (should disappear with the §4.1 clock fix).
- [ ] **Re-baseline the docs** — `[§6]`
  Collapse `BUILD_STATUS.md` + `docs/SESSION_SUMMARY.md` into one dated STATUS doc; fix `README.md`'s internal contradiction on encryption; correct the `architecture.md` test-layout diagram (no top-level `tests/`).

---

## Notes

- Ordering rationale: close **P0** (clock + encryption) before anything ships — they're correctness/trust blockers. The **FE/TanStack** work and **P1** can proceed in parallel; the table migration's commit-on-blur also reduces the §4.1 blast radius.
- Nothing here has been started — this is planning only.
