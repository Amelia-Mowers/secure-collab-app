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
  - [x] **Follow-up:** two-client convergence via the real sync loop — done in `[§4.5]` (`test_two_client_sync_via_real_timeline`): Bob materializes from his own synced Conduit timeline and `origin_server_ts` is confirmed attached as the tiebreaker against real server-stamped events.

- [~] **Make E2E encryption real — or stop claiming it** — `[§4.2]` — _enablement + guard + honest badge done & compile-verified; encrypted send/decrypt round-trip now **verified against Conduit** (`test_two_client_encrypted_round_trip`). Remaining before launch: device verification + cross-signing + key backup._
  - [x] Enable encryption at room creation — `room.enable_encryption()` in `ConnectedWorkspace`'s `createRoom`; creation fails loudly if it can't be turned on.
  - [x] **Fail-closed send guard** — `send_updates` refuses to emit cell updates unless `room.encryption_state().is_encrypted()` (don't trust the server default). Placed at the bridge boundary only, so the native integration harness (unencrypted test rooms) is unaffected.
  - [x] **Honest badge** — new `ConnectedWorkspace::isEncrypted()` bridge method; `Sidebar` now shows "E2E Encrypted" only when the room really is, and a red "Not encrypted" warning otherwise (instead of a hard-coded claim).
  - [x] **Verify an encrypted round-trip** against Conduit — `test_two_client_encrypted_round_trip`: Alice sends into an `m.room.encryption` room, the SDK Megolm-encrypts + shares the key, and Bob decrypts on sync and materializes the value. Confirms the SDK auto-decrypt of `raw().json()` works for our custom events (the read path survives encryption).
  - [ ] Cross-device key sharing / **device verification + cross-signing + key backup** — required before launch (currently keys are shared with unverified devices by default: functional, not verified-secure). Larger design effort; still open.
  - [ ] Decide policy for **legacy unencrypted rooms** (created before this change): the guard makes them read-only. Offer a migrate/recreate path or a clear UI state.

---

## P1 — Should-fix (deliver the architecture's promises)

- [x] **Wire order-based bumping into the write path** — `[§4.3]` — _done 2026-06-07; unit + rotation tests, stable clippy, wasm build verified._
  - [x] Emit a bump alongside each user write — `Workspace::update_cell_with_bump` (used by `ConnectedWorkspace::update_cell`) sends the user write **plus** a bump of the stalest cell; the local-only path stays no-bump.
  - [x] System-table decision: `_schema`/`_views` are intentionally **not** bumped (low churn; lookback bounded by their small cell count) — documented on `update_cell_with_bump`.
  - [x] Removed dead `last_bump`; `CompactionManager` is now stateless (`&self` methods).

- [x] **Unify cold-start to one implementation** — `[§4.4]` — _done 2026-06-07; tables-over-matrix tests + clippy + fmt verified._
  - [x] One engine: `TimelinePaginator` (LWW apply → order-independent values); `materialize_from_timeline` now delegates to it, so they can't drift.
  - [x] Newest-first assumption made explicit (documented on `process_batch`: it governs only the dedup counters + early-stop); old order-dependent accounting removed; added an order-independence test.
  - [x] Bridge cold-start documented as the deliberately-separate **workspace** layer (routes schema/views via `apply_update`) — not a duplicate of the raw-table engine.

- [~] **Add a true end-to-end sync test** — `[§4.5]` — _harness runnable via Nix/WSL (`scripts/run-integration-tests.sh`) and green: tables-over-matrix integration tests + app-core `workspace_matrix` 17/17._
  - [x] Drive a real send → server → sync → fetch-timeline → extract → materialize round-trip (`test_two_client_sync_via_real_timeline`): Bob converges on Alice's value from his OWN synced timeline, not a re-applied in-memory update.
  - [x] **Encrypted** round-trip (overlaps `[§4.2]`): `test_two_client_encrypted_round_trip` — Megolm send/decrypt across two clients via the `create_encrypted_room` harness helper.
  - [ ] Add at least one UI test against compiled WASM (not just `MockWorkspace`).

---

## FE — Frontend / Table UX

- [~] **Migrate the table view to TanStack Table v8 + TanStack Virtual** — _grid done & verified 2026-06-07 (type-check + lint + 215 vitest + production build); branch `fe/tanstack-table`._
  - [x] Add deps: `@tanstack/react-table`, `@tanstack/react-virtual` (both MIT).
  - [x] **Typed cell registry** `ui/src/cells/cellRegistry.tsx` — `CellDisplay` + commit-on-blur `CellEditor` for all 9 column types, used by **both** the grid and the entry view (`FieldRenderer` delegates to it).
  - [x] Map `schema.columns → ColumnDef[]` (TanStack column model, carries options).
  - [x] Replace the raw `<table>` with TanStack + row virtualization (`@tanstack/react-virtual`, with a render-all fallback when there's no viewport, e.g. jsdom/SSR).
  - [x] **Commit on blur/Enter** → exactly one `CellUpdate` per logical edit (kills the per-keystroke `room.send`/429s).
  - [x] Header-click **column sorting** (`getSortedRowModel`). _(Toolbar Sort/Filter buttons are still stubs — real filter UI is a follow-up.)_
  - [x] Tests: rewritten to assert display + one-update-on-blur; per-type editors covered.
  - [x] **Shared the registry with EntryView** — `FieldRenderer` now delegates to `cellRegistry.CellEditor`; the `TableView` ⇄ `FieldRenderer` duplication is gone (−220 lines).
  - [ ] **Follow-up — optimistic ↔ LWW reconciliation** so a rejected write can't flash-then-revert (relates to `[§4.1]`/`[§5]`).
  - [ ] Follow-up — real filter UI; column resize/reorder/visibility (free with TanStack).

  *Alternative considered:* AG Grid (key features paid Enterprise — awkward for an auditable open-core). Glide Data Grid (canvas) for a future high-volume view.

- [ ] **Flesh out placeholder field editors** — `multiselect` is a comma-string and `reference` a plain text input in the registry; add a tag input and a real reference/record picker. (Now centralized in `cellRegistry.tsx`.)

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
